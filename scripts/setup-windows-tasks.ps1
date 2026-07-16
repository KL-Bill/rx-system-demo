# Run ONCE, as Administrator, from this machine, after pod.yaml is set up
# and the image is built. Registers two Windows Scheduled Tasks — the
# Windows equivalent of what Quadlet/systemd does on Linux:
#
#   rx-system-start   starts the pod at system boot, and restarts it if this
#                     task is ever run again (safe to re-run)
#   rx-system-backup  runs scripts/backup-db.ps1 every 12 hours, forever
#
# After this one-time run, both are fully automatic — no need to repeat this
# script or touch Task Scheduler again unless you want to change something.

#Requires -RunAsAdministrator

$repoRoot = Split-Path -Parent $PSScriptRoot
$podYaml = Join-Path $repoRoot "pod.yaml"

if (-not (Test-Path $podYaml)) {
    Write-Error "pod.yaml not found at $podYaml — copy pod.yaml.example to pod.yaml and edit it first."
    exit 1
}

# ---- start-on-boot ----
$startAction = New-ScheduledTaskAction -Execute "podman.exe" `
    -Argument "kube play `"$podYaml`" --replace" -WorkingDirectory $repoRoot
$startTrigger = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -TaskName "rx-system-start" -Action $startAction -Trigger $startTrigger `
    -RunLevel Highest -Force | Out-Null
Write-Host "Registered rx-system-start (runs at boot)."

# ---- 12-hour backup ----
$backupAction = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$repoRoot\scripts\backup-db.ps1`"" `
    -WorkingDirectory $repoRoot
$onceTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Hours 12) -RepetitionDuration ([TimeSpan]::MaxValue)
Register-ScheduledTask -TaskName "rx-system-backup" -Action $backupAction -Trigger $onceTrigger `
    -RunLevel Highest -Force | Out-Null
Write-Host "Registered rx-system-backup (runs every 12h, starting now)."

# start the pod right now too, instead of waiting for the next reboot
Start-ScheduledTask -TaskName "rx-system-start"
Write-Host "Pod starting now via the registered task — check with: podman ps"
