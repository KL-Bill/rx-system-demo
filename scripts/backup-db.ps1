# Dumps the running Postgres container to a timestamped file via
# `podman exec ... pg_dump` (never a raw copy of the data directory -
# copying a live database's files risks an inconsistent snapshot; pg_dump
# talks to the running server and produces one clean, consistent dump).
# Registered to run every 12h by scripts/setup-windows-tasks.ps1.
#
# Each dump is written TWICE, on purpose:
#   1. /backups inside the pod (the `backups` volume in pod.yaml). The app
#      mounts this read-only, which is how IT downloads backups from the IT
#      page - a container can't reach the Windows filesystem otherwise.
#   2. $BackupDir on the Windows host (default C:\rx-system\backups), copied
#      out with `podman cp`. This is the copy that survives if the podman
#      machine VM is ever lost or rebuilt, so it's the real safety net.
# Both are pruned past $RetentionDays.

param(
    [string]$PodContainer = $(if ($env:POD_CONTAINER) { $env:POD_CONTAINER } else { "rx-system-postgres" }),
    [string]$PgUser = $(if ($env:PGUSER) { $env:PGUSER } else { "rxsystem" }),
    [string]$PgDatabase = $(if ($env:PGDATABASE) { $env:PGDATABASE } else { "rxsystem" }),
    [string]$BackupDir = $(if ($env:BACKUP_DIR) { $env:BACKUP_DIR } else { "C:\rx-system\backups" }),
    [int]$RetentionDays = 7
)

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$fileName = "rx-system-$stamp.sql"
$inPod = "/backups/$fileName"                       # inside the pod (served to IT)
$onHost = Join-Path $BackupDir $fileName            # on the Windows disk (safety copy)

# Records the run in the `backups` table - that's what the IT page lists, and
# the app checks a requested filename against it before serving a download.
# Best-effort: a failed INSERT must not fail the backup itself.
function Record-Run($status, $sizeBytes, $durationMs) {
    $at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $sql = "INSERT INTO backups (at, file, size_bytes, duration_ms, status) " +
           "VALUES ($at, '$fileName', $sizeBytes, $durationMs, '$status')"
    podman exec $PodContainer psql -U $PgUser -d $PgDatabase -c $sql | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Warning "could not record backup run in backups table" }
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()

# --clean --if-exists makes the dump REPLACE rather than merge: it emits
# DROP ... IF EXISTS before each CREATE. Without it, restoring onto a
# database that still has data fails every CREATE with "already exists" and
# then appends the dump's rows to the existing ones - a silently corrupted
# restore. Only a dump taken with these flags is safe to restore onto a
# live database.
#
# -f writes the dump inside the container, so there's no host redirect to
# corrupt the encoding (PowerShell's `>` would re-encode it as UTF-16).
podman exec $PodContainer pg_dump -U $PgUser --clean --if-exists -f $inPod $PgDatabase
if ($LASTEXITCODE -ne 0) {
    Record-Run "failed" 0 $sw.ElapsedMilliseconds
    Write-Error "pg_dump failed"
    exit 1
}

# Copy out to the Windows host. If only this step fails the backup itself is
# still good and downloadable from the IT page - warn, don't fail the run.
podman cp "${PodContainer}:$inPod" $onHost
if ($LASTEXITCODE -ne 0) {
    Write-Warning "dump succeeded but copying it to $BackupDir failed"
    $size = 0
} else {
    $size = (Get-Item $onHost).Length
}

Record-Run "ok" $size $sw.ElapsedMilliseconds
Write-Host "Backup written: $inPod (pod) and $onHost (host)"

# ---- retention: prune both copies ----
Get-ChildItem $BackupDir -Filter "rx-system-*.sql" |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$RetentionDays) } |
    Remove-Item

# -mtime works on whole days, matching $RetentionDays' granularity.
podman exec $PodContainer sh -c "find /backups -name 'rx-system-*.sql' -mtime +$RetentionDays -delete"
if ($LASTEXITCODE -ne 0) { Write-Warning "could not prune old dumps inside the pod" }

# Drop rows whose files are gone from both places, so the IT page doesn't
# list backups that can no longer be downloaded.
$cutoff = [DateTimeOffset]::UtcNow.AddDays(-$RetentionDays).ToUnixTimeMilliseconds()
podman exec $PodContainer psql -U $PgUser -d $PgDatabase -c "DELETE FROM backups WHERE at < $cutoff" | Out-Null
