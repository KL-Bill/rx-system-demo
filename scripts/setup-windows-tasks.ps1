# Run ONCE, from the account that will be logged in on the server, after
# pod.yaml is set up and the image is built. Registers two Windows Scheduled
# Tasks - the Windows equivalent of what Quadlet/systemd does on Linux:
#
#   rx-system-start   starts podman machine (the VM podman itself runs on -
#                     it does NOT come back up on its own after a reboot)
#                     then the pod, at logon; safe to re-run
#   rx-system-backup  runs scripts/backup-db.ps1 every 12 hours, forever
#
# After this one-time run, both are fully automatic - no need to repeat this
# script or touch Task Scheduler again unless you want to change something.
#
# ---------------------------------------------------------------------------
# RUN THIS AS THE ACCOUNT THAT AUTO-LOGS IN - not from an admin shell that
# belongs to somebody else.
#
# A podman machine belongs to the user profile that created it
# (%LOCALAPPDATA%\containers\podman). Install Podman as an admin, then log the
# server in as a standard user, and that user has no machine: the task fails
# with "VM does not exist" at every boot no matter how often it retries.
# Three things must be the same account:
#
#     the account that runs `podman machine init`
#   = the account that logs in on the server
#   = the account these tasks run as
#
# On the Hyper-V provider that account also needs the rights to manage a VM -
# a plain standard user cannot start one. Either:
#   (a) make the auto-login account a local administrator. A Scheduled Task
#       running as an admin with -RunLevel Highest elevates silently, with no
#       UAC prompt - this is what stops the password-every-time problem; or
#   (b) leave it a standard user and grant just Hyper-V:
#           Add-LocalGroupMember -Group "Hyper-V Administrators" -Member <user>
#       then log out and back in for the membership to take effect.
#
# (a) is the simpler thing to keep working on a dedicated server PC; (b) grants
# less. Either way `podman machine init` must be run from that account.
# ---------------------------------------------------------------------------

$repoRoot = Split-Path -Parent $PSScriptRoot
$podYaml = Join-Path $repoRoot "pod.yaml"

if (-not (Test-Path $podYaml)) {
    Write-Error "pod.yaml not found at $podYaml - copy pod.yaml.example to pod.yaml and edit it first."
    exit 1
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
$elevated = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
$me = $identity.Name

Write-Host "Registering tasks for: $me  (elevated: $elevated)"

# ---- preflight: does THIS account own a podman machine? ----
# Catching it here is the whole point - otherwise the mismatch only ever shows
# up as a task that silently fails at every boot.
$podmanCommand = Get-Command podman.exe -ErrorAction SilentlyContinue
if (-not $podmanCommand) { $podmanCommand = Get-Command podman -ErrorAction SilentlyContinue }

if (-not $podmanCommand) {
    Write-Warning "podman is not on PATH for $me. Install it for all users, or open a new session."
}
else {
    & $podmanCommand.Source machine inspect podman-machine-default *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "$me has no 'podman-machine-default'."
        Write-Warning "Run 'podman machine init' AS THIS ACCOUNT before relying on the task, or it"
        Write-Warning "will fail at every boot with 'VM does not exist'. See the header of this file."
    }
    else {
        Write-Host "Found podman-machine-default for $me."
    }
}

# Ask for elevation only when this account can actually get it silently.
# -RunLevel Highest on an account that cannot elevate is what produced the
# password prompt on every run.
if ($elevated) { $runLevel = "Highest" } else { $runLevel = "Limited" }

# IgnoreNew is the important one: two overlapping runs destroy each other,
# because `kube play --replace` from the second tears down the pod the first
# just built and leaves nothing running.
$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 20) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 2)

# ---- start-at-logon ----
# NOT -AtStartup, even though "at boot" is what we actually want: `podman
# machine` (the VM podman runs containers in on Windows) belongs to a specific
# USER profile, so the task has to run as that user to find it. A task running
# as SYSTEM would look for a different, non-existent machine; and an
# -AtStartup trigger on a "run only when user is logged on" principal never
# fires at all (Task Scheduler reports 0x1 / 0x800710E0 - refused).
#
# So: trigger at logon, and set this machine to log in automatically after a
# reboot (see "Automation" in README.md). Unattended boot then works end to
# end - power on -> auto-login -> this task -> podman machine -> pod.
$startAction = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$repoRoot\scripts\start-pod.ps1`"" `
    -WorkingDirectory $repoRoot
$startTrigger = New-ScheduledTaskTrigger -AtLogOn -User $me
# Hand Windows 30 s to finish networking and Hyper-V before the script starts
# polling. start-pod.ps1 no longer sleeps blindly, so this is the only fixed
# delay left in the chain.
$startTrigger.Delay = "PT30S"

Register-ScheduledTask -TaskName "rx-system-start" -Action $startAction -Trigger $startTrigger `
    -Settings $settings -User $me -RunLevel $runLevel -Force | Out-Null
Write-Host "Registered rx-system-start (at logon of $me, RunLevel $runLevel)."

# ---- 12-hour backup ----
$backupAction = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$repoRoot\scripts\backup-db.ps1`"" `
    -WorkingDirectory $repoRoot
# [TimeSpan]::MaxValue overflows Task Scheduler's duration format (its XML
# schema rejects it) - 10 years is effectively "forever" for this purpose
# and stays within the valid range.
$onceTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Hours 12) -RepetitionDuration (New-TimeSpan -Days 3650)

# Same account as the start task on purpose: backup-db.ps1 shells out to
# `podman exec`, which only reaches the pod from the profile that owns it.
Register-ScheduledTask -TaskName "rx-system-backup" -Action $backupAction -Trigger $onceTrigger `
    -Settings $settings -User $me -RunLevel $runLevel -Force | Out-Null
Write-Host "Registered rx-system-backup (runs every 12h, starting now)."

# start the pod right now too, instead of waiting for the next reboot
Start-ScheduledTask -TaskName "rx-system-start"
Write-Host ""
Write-Host "Pod starting now via the registered task."
Write-Host "  Watch it:  Get-Content '$repoRoot\logs\start-pod.log' -Wait -Tail 20"
Write-Host "  Check it:  podman ps"
