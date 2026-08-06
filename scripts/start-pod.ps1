# Called by the rx-system-start Scheduled Task at logon (registered by
# setup-windows-tasks.ps1). Brings the podman machine up, then the pod.
#
# The task runs with a hidden window, so everything is written to
# logs/start-pod.log instead — check there first when the pod isn't up.
#
# Three things this script is careful about, each learned from a real failure:
#
#   1. IDENTITY. A podman machine — the VM podman runs containers in — belongs
#      to the user profile that created it (%LOCALAPPDATA%\containers\podman).
#      Install podman as an admin and the machine is the ADMIN's; a task
#      running as the logged-in standard user sees "VM does not exist" and
#      retries forever. On the Hyper-V provider it also needs the rights to
#      manage a VM. This script names the account it's running as, up front,
#      and stops with a clear message instead of grinding.
#
#   2. ONE AT A TIME. Two overlapping runs destroy each other: `kube play
#      --replace` from the second tears down the pod the first just built,
#      leaving nothing running. A mutex makes extra invocations exit quietly.
#
#   3. NO BLIND SLEEPS. Waiting a fixed two minutes for Windows to settle
#      means the task sits in "Running" long after it could have finished, and
#      still isn't long enough on a slow boot. Everything here polls for the
#      condition it actually needs, up to a bounded timeout.

param(
    [int]$AppPort = 3000,
    [string]$MachineName = "podman-machine-default"
)

$ErrorActionPreference = "Continue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$podYaml = Join-Path $repoRoot "pod.yaml"
$logDir = Join-Path $repoRoot "logs"
$logFile = Join-Path $logDir "start-pod.log"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Log([string]$Message) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $Message"
    Add-Content -Path $logFile -Value $line -Encoding UTF8
    Write-Host $line
}

# Poll until $Test returns true. Returns $false on timeout. Native commands are
# checked via $LASTEXITCODE with output sunk to $null — piping a native exe's
# stderr through PowerShell wraps each line in an ErrorRecord, which is what
# filled the old log with garbled UTF-16 "T h e   f i l e ..." noise.
function Wait-Until {
    param(
        [scriptblock]$Test,
        [int]$TimeoutSec,
        [int]$IntervalSec = 5,
        [string]$What = "condition"
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $announced = $false
    while ($true) {
        if (& $Test) { return $true }
        if ((Get-Date) -ge $deadline) { return $false }
        if (-not $announced) {
            Log "waiting for $What (up to $TimeoutSec s)..."
            $announced = $true
        }
        Start-Sleep -Seconds $IntervalSec
    }
}

if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 1MB)) {
    Remove-Item $logFile -Force
}

# ---- one instance at a time ----
# Local\ (not Global\) — every run is the same interactive user, and Global\
# needs a privilege a standard account may not hold.
$mutex = New-Object System.Threading.Mutex($false, "Local\rx-system-start")
$holdsMutex = $false
try { $holdsMutex = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $holdsMutex = $true }
if (-not $holdsMutex) {
    Log "another start-pod.ps1 is already running - exiting so the two don't fight."
    exit 0
}

try {
    Log "--- start-pod.ps1 ---"
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
    $elevated = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
    Log "Running as: $($identity.Name)  (elevated: $elevated)"

    if (-not (Test-Path $podYaml)) {
        Log "ERROR: pod.yaml not found at $podYaml"
        exit 1
    }

    $healthy = {
        try {
            $r = Invoke-WebRequest -Uri "http://localhost:$AppPort/" -UseBasicParsing -TimeoutSec 5
            return ($null -ne $r)
        } catch { return $false }
    }

    # Already serving? Then a previous run (or the last boot) got there first.
    # Doing anything else here would only knock it over.
    if (& $healthy) {
        Log "App is already answering on port $AppPort - nothing to do."
        exit 0
    }

    $podmanCommand = Get-Command podman.exe -ErrorAction SilentlyContinue
    if (-not $podmanCommand) { $podmanCommand = Get-Command podman -ErrorAction SilentlyContinue }
    if (-not $podmanCommand) {
        Log "ERROR: podman.exe is not on PATH for this account. Podman is installed per-machine but"
        Log "       PATH is per-session - if it was installed while this task was already registered,"
        Log "       log out and back in, or reinstall podman for all users."
        exit 1
    }
    $podman = $podmanCommand.Source
    Log "Using podman: $podman"

    $podmanReady = { & $podman info *> $null; return ($LASTEXITCODE -eq 0) }

    if (& $podmanReady) {
        Log "Podman is already reachable."
    }
    else {
        # Does this ACCOUNT have a machine at all? Distinguishes "not started
        # yet" from "belongs to a different user", which look identical from
        # the outside but need completely different fixes.
        & $podman machine inspect $MachineName *> $null
        if ($LASTEXITCODE -ne 0) {
            Log "ERROR: no podman machine named '$MachineName' exists for $($identity.Name)."
            Log "       A podman machine belongs to the user profile that created it. This usually"
            Log "       means it was created by the admin account used to install Podman, while this"
            Log "       task runs as the account that logs in."
            Log "       Fix: log in AS THIS ACCOUNT and run 'podman machine init', so the machine and"
            Log "       the task are owned by the same user. See setup-windows-tasks.ps1."
            exit 1
        }

        for ($attempt = 1; $attempt -le 3; $attempt++) {
            Log "podman machine start (attempt $attempt/3)..."
            $output = (& $podman machine start | Out-String).Trim()
            $startExit = $LASTEXITCODE
            if ($output) { Log $output }

            # "already running" is the state we want, but podman reports it as
            # a non-zero failure. On Hyper-V the VM can also be running while
            # the host-side proxies are not, so readiness is checked below
            # either way rather than trusted from this exit code.
            if ($startExit -eq 0 -or $output -match "already running") { break }

            if ($attempt -lt 3) { Start-Sleep -Seconds 10 }
        }

        # Hyper-V reports the VM as started before the API/ssh forwarding is
        # accepting connections.
        if (-not (Wait-Until -Test $podmanReady -TimeoutSec 180 -What "the podman API")) {
            Log "ERROR: podman machine did not become reachable within 180 s."
            if (-not $elevated) {
                Log "       This task is NOT running elevated. The Hyper-V provider needs rights to"
                Log "       manage a VM: either make this account a local administrator and register"
                Log "       the task with -RunLevel Highest, or add it to the local 'Hyper-V"
                Log "       Administrators' group."
            }
            exit 1
        }
        Log "Podman is ready."
    }

    # ---- deploy ----
    $podStarted = $false
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        Log "podman kube play $podYaml --replace (attempt $attempt/3)..."
        $output = (& $podman kube play $podYaml --replace | Out-String).Trim()
        $playExit = $LASTEXITCODE
        if ($output) { Log $output }

        if ($playExit -eq 0) { $podStarted = $true; break }

        Log "attempt $attempt failed."
        if ($attempt -lt 3) {
            Start-Sleep -Seconds 10
            Wait-Until -Test $podmanReady -TimeoutSec 60 -What "the podman API to come back" | Out-Null
        }
    }

    if (-not $podStarted) {
        Log "ERROR: podman kube play failed after 3 attempts."
        exit 1
    }

    # Containers created is not the same as the app serving traffic — Postgres
    # has to accept connections first. Report what actually happened.
    if (Wait-Until -Test $healthy -TimeoutSec 120 -IntervalSec 3 -What "the app to answer on port $AppPort") {
        Log "Pod started successfully - app is answering on port $AppPort."
        exit 0
    }

    Log "WARNING: pod deployed, but nothing is answering on port $AppPort after 120 s."
    Log "         Check container logs: podman logs rx-system-app"
    exit 1
}
finally {
    if ($holdsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
