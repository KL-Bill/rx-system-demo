# Dumps the running Postgres container to a timestamped file via
# `podman exec ... pg_dump` (never a raw copy of the data directory —
# copying a live database's files risks an inconsistent snapshot; pg_dump
# talks to the running server and produces one clean, consistent dump).
# Deletes dumps older than $RetentionDays. Registered to run every 12h by
# scripts/setup-windows-tasks.ps1.

param(
    [string]$PodContainer = $(if ($env:POD_CONTAINER) { $env:POD_CONTAINER } else { "rx-system-postgres" }),
    [string]$PgUser = $(if ($env:PGUSER) { $env:PGUSER } else { "rxsystem" }),
    [string]$PgDatabase = $(if ($env:PGDATABASE) { $env:PGDATABASE } else { "rxsystem" }),
    [string]$BackupDir = $(if ($env:BACKUP_DIR) { $env:BACKUP_DIR } else { "C:\rx-system\backups" }),
    [int]$RetentionDays = 7
)

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outFile = Join-Path $BackupDir "rx-system-$stamp.sql"

# Redirect via cmd.exe, not PowerShell's `>`/Out-File — PowerShell's own
# redirection re-encodes text (UTF-16 with a BOM by default), which would
# corrupt the SQL dump. cmd.exe's `>` just captures pg_dump's raw output.
cmd /c "podman exec $PodContainer pg_dump -U $PgUser $PgDatabase > `"$outFile`""
if ($LASTEXITCODE -ne 0) { Write-Error "pg_dump failed"; exit 1 }
Write-Host "Backup written: $outFile"

Get-ChildItem $BackupDir -Filter "rx-system-*.sql" |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$RetentionDays) } |
    Remove-Item
