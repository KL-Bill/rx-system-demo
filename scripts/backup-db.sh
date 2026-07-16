#!/bin/sh
# Dumps the running Postgres container to a timestamped file via `podman exec
# ... pg_dump` (never a raw copy of the data directory — copying a live
# database's files risks an inconsistent snapshot; pg_dump talks to the
# running server and produces one clean, consistent dump). Deletes dumps
# older than RETENTION_DAYS. Triggered every 12h by rx-system-backup.timer.
set -eu

POD_CONTAINER="${POD_CONTAINER:-rx-system-postgres}"
PGUSER="${PGUSER:-rxsystem}"
PGDATABASE="${PGDATABASE:-rxsystem}"
BACKUP_DIR="${BACKUP_DIR:-/srv/rx-system/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

mkdir -p "$BACKUP_DIR"

STAMP=$(date +%Y%m%d-%H%M%S)
OUT_FILE="$BACKUP_DIR/rx-system-$STAMP.sql"

podman exec "$POD_CONTAINER" pg_dump -U "$PGUSER" "$PGDATABASE" > "$OUT_FILE"
echo "Backup written: $OUT_FILE"

find "$BACKUP_DIR" -name 'rx-system-*.sql' -mtime "+$RETENTION_DAYS" -delete
