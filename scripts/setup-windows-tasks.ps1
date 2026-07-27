# Run ONCE, as Administrator, from this machine, after pod.yaml is set up
# and the image is built. Registers two Windows Scheduled Tasks - the
# Windows equivalent of what Quadlet/systemd does on Linux:
#
#   rx-system-start   starts podman machine (the VM podman itself runs on -
#                     it does NOT come back up on its own after a reboot)
#                     then the pod, at system boot; safe to re-run
#   rx-system-backup  runs scripts/backup-db.ps1 every 12 hours, forever
#
# After this one-time run, both are fully automatic - no need to repeat this
# script or touch Task Scheduler again unless you want to change something.

#Requires -RunAsAdministrator

$repoRoot = Split-Path -Parent $PSScriptRoot
$podYaml = Join-Path $repoRoot "pod.yaml"

if (-not (Test-Path $podYaml)) {
    Write-Error "pod.yaml not found at $podYaml - copy pod.yaml.example to pod.yaml and edit it first."
    exit 1
}

# ---- start-at-logon ----
# NOT -AtStartup, even though "at boot" is what we actually want: `podman
# machine` (the Linux VM podman runs containers in on Windows) belongs to a
# specific USER profile, so the task has to run as that user to find it. A
# task running as SYSTEM would start a different, empty machine; and an
# -AtStartup trigger on a "run only when user is logged on" principal never
# fires at all (Task Scheduler reports 0x1 / 0x800710E0 - refused).
#
# So: trigger at logon, and set this machine to log in automatically after a
# reboot (see "Automation" in README.md). Unattended boot then works end to
# end - power on -> auto-login -> this task -> podman machine -> pod.
$startAction = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$repoRoot\scripts\start-pod.ps1`"" `
    -WorkingDirectory $repoRoot
$startTrigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
Register-ScheduledTask -TaskName "rx-system-start" -Action $startAction -Trigger $startTrigger `
    -RunLevel Highest -Force | Out-Null
Write-Host "Registered rx-system-start (runs at logon of $env:USERNAME)."

# ---- 12-hour backup ----
$backupAction = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$repoRoot\scripts\backup-db.ps1`"" `
    -WorkingDirectory $repoRoot
# [TimeSpan]::MaxValue overflows Task Scheduler's duration format (its XML
# schema rejects it) - 10 years is effectively "forever" for this purpose
# and stays within the valid range.
$onceTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Hours 12) -RepetitionDuration (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName "rx-system-backup" -Action $backupAction -Trigger $onceTrigger `
    -RunLevel Highest -Force | Out-Null
Write-Host "Registered rx-system-backup (runs every 12h, starting now)."

# start the pod right now too, instead of waiting for the next reboot
Start-ScheduledTask -TaskName "rx-system-start"
Write-Host "Pod starting now via the registered task - check with: podman ps"
