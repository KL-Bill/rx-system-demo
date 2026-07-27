# Called by the rx-system-start Scheduled Task at logon (registered by
# setup-windows-tasks.ps1). On Windows, `podman` commands run against a small
# Linux VM ("podman machine") — unlike the Scheduled Task itself, that VM does
# NOT come back up on its own after a reboot, so `podman kube play` run
# directly at startup fails until someone manually runs `podman machine start`.
# This starts the machine first, then the pod.
#
# The task runs with a hidden window, so everything is written to
# logs/start-pod.log instead — check there first when the pod isn't up.

$repoRoot = Split-Path -Parent $PSScriptRoot
$podYaml = Join-Path $repoRoot "pod.yaml"
$logDir = Join-Path $repoRoot "logs"
$logFile = Join-Path $logDir "start-pod.log"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
    Add-Content -Path $logFile -Value $line -Encoding utf8
    Write-Host $line
}

# Keep the log from growing forever - it's appended to on every boot.
if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 1MB)) {
    Remove-Item $logFile -Force
}

Log "--- start-pod.ps1 ---"

if (-not (Test-Path $podYaml)) {
    Log "ERROR: pod.yaml not found at $podYaml"
    exit 1
}

# At logon the machine may still be initializing (WSL/Hyper-V, network, the
# user profile mount). Retry rather than giving up on the first failure.
$started = $false
for ($i = 1; $i -le 5; $i++) {
    Log "podman machine start (attempt $i)..."
    $out = (podman machine start 2>&1 | Out-String).Trim()
    if ($out) { Log $out }

    # Already-running is a success, not a failure - podman exits non-zero and
    # says so, which is exactly the state we want to be in.
    if ($LASTEXITCODE -eq 0 -or $out -match "already running") {
        $started = $true
        break
    }
    Start-Sleep -Seconds 15
}

if (-not $started) {
    Log "ERROR: podman machine did not start after 5 attempts - giving up."
    exit 1
}

# The VM can report "started" a moment before the API socket is actually
# accepting connections; `podman info` is the real readiness check.
for ($i = 1; $i -le 10; $i++) {
    podman info *>$null
    if ($LASTEXITCODE -eq 0) { break }
    Log "waiting for podman to become ready ($i)..."
    Start-Sleep -Seconds 5
}

Log "podman kube play $podYaml --replace"
$out = (podman kube play $podYaml --replace 2>&1 | Out-String).Trim()
if ($out) { Log $out }
if ($LASTEXITCODE -ne 0) {
    Log "ERROR: podman kube play failed."
    exit 1
}

Log "Pod started."
