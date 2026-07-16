# rx-system

Rx generator + pharmacy demand tracker. Express app backed by Postgres, containerized with Podman (Windows).

## Stack

- Node.js / Express, run in cluster mode (fixed worker count, see `WEB_CONCURRENCY`)
- Postgres (schema in `db/schema.sql`)
- Podman (app container + Postgres container, one pod) — Windows Scheduled Tasks handle boot-start and backups; Podman's own `restartPolicy: Always` handles crash-restart
- Separate Electron kiosk client: `rx-system-client` (not this repo)

## Deploying (this PC, or any other Windows machine)

### Before you leave your current machine

Grab `data.json` from the repo root if you want existing users/stations/prescriptions
to carry over. It's gitignored on purpose (so demo/prod data never lands in git),
so `git clone` alone won't bring it — copy it manually into the new checkout
before running the migration step below. Skip this if you're fine starting
empty and creating your own admin login fresh.

### First-time setup

```powershell
# 1. Install Podman Desktop (or the podman CLI) if not already installed.
#    Podman on Windows runs containers inside a small Linux VM under the
#    hood (`podman machine`) — you still just run `podman` commands
#    directly from PowerShell, same as on Linux/Mac.
podman machine start   # if not already running

# 2. Get the code
git clone <your-repo-url> rx-system
cd rx-system
# (drop the copied data.json in here now, if you brought one)

# 3. Set up the per-machine config
Copy-Item pod.yaml.example pod.yaml
notepad pod.yaml
# edit pod.yaml:
#   - hostPath path — a plain Linux-style path (e.g. /home/user/rx-system/pgdata),
#     NOT a Windows C:\ path. This lives inside the podman machine VM and is
#     what makes Postgres data survive container restarts/rebuilds.
#   - the two CHANGE_ME secrets (SECRET_KEY, PGPASSWORD — PGPASSWORD must
#     match POSTGRES_PASSWORD further down in the same file)

# 4. Build the app image
podman build -t localhost/rx-system:latest .

# 5. Register the boot-start + 12h-backup Scheduled Tasks (one-time — see
#    "Automation" below for what this actually does). Run as Administrator.
.\scripts\setup-windows-tasks.ps1

# 6. Confirm it's up
podman ps    # note the exact container names, e.g. rx-system-app / rx-system-postgres

# 7. Apply the schema (one-time, first boot only)
cmd /c "podman exec -i rx-system-postgres psql -U rxsystem -d rxsystem < db\schema.sql"

# 8a. If you brought data.json over — migrate it in
podman exec rx-system-app npm run migrate

# 8b. Either way, create yourself a login (skip if migrate already brought your users over)
podman exec rx-system-app npm run create-admin -- youradmin yourpassword superadmin
```

### Automation — what's actually automatic vs. one-time setup

Every automated thing here needs exactly one registration step before it runs
itself — that's unavoidable on any OS (Linux would need `systemctl enable`;
here it's `setup-windows-tasks.ps1`, run once). After that single run:

- **Boot-start**: the `rx-system-start` Scheduled Task fires every time this
  machine boots and runs `podman kube play`, no further action needed.
- **Crash-restart**: handled by Podman itself (`restartPolicy: Always` in
  `pod.yaml`) — if a container dies, Podman restarts it. Nothing OS-level
  involved, works identically on Windows/Linux/Mac.
- **Backups**: the `rx-system-backup` Scheduled Task fires every 12 hours,
  forever, starting from the moment you ran the setup script — you never
  touch it again.

Check on them anytime with:
```powershell
Get-ScheduledTask rx-system-start, rx-system-backup | Get-ScheduledTaskInfo
```

### Redeploying after a code change

```powershell
git pull
podman build -t localhost/rx-system:latest .
podman kube play pod.yaml --replace
```

The Electron kiosk client (`rx-system-client`) shows a "Connecting to server…"
splash screen with a 90-second grace period before it tells staff to contact
IT, so a routine restart like this doesn't need a maintenance-mode banner —
staff just see a brief reconnect.

### Day-to-day operations

| Task | Command |
|---|---|
| Check pod status | `podman ps` |
| View app logs | `podman logs -f rx-system-app` |
| Restart | `podman kube play pod.yaml --replace` |
| Stop | `podman kube down pod.yaml` |
| Create another admin login | `podman exec rx-system-app npm run create-admin -- <username> <password> [role]` |
| Manual backup | `.\scripts\backup-db.ps1` |
| Check scheduled tasks | `Get-ScheduledTask rx-system-start, rx-system-backup \| Get-ScheduledTaskInfo` |
| Rebuild the drug catalog | `node scripts/build-medicines.js && node scripts/tag-pnf.js` (run locally, not in the container — the source files it needs aren't shipped in the image; commit the regenerated `medicines.json` and redeploy) |

### Restoring from a backup

```powershell
cmd /c "podman exec -i rx-system-postgres psql -U rxsystem -d rxsystem < C:\rx-system\backups\rx-system-<timestamp>.sql"
```

## Environment variables

See `.env.example`. Note that the running containers get their env vars from
`pod.yaml`, not from a `.env` file — `.env` only matters when running scripts
directly with `node` (outside the containers), e.g. for local development.

| Variable | Purpose |
|---|---|
| `PORT` | App HTTP port (default 3000) |
| `SECRET_KEY` | JWT signing secret |
| `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` | Postgres connection (or set `DATABASE_URL` instead) |
| `WEB_CONCURRENCY` | Fixed Node cluster worker count — default 2; keep at or below (CPU cores − 1), and stay conservative since Postgres shares the box |

## Local development

```powershell
Copy-Item .env.example .env   # fill in PGPASSWORD etc. for a local Postgres
npm install
cmd /c "psql -U postgres -d rxsystem < db\schema.sql"
npm run migrate               # if you have an existing data.json to import
npm run create-admin -- youradmin yourpassword superadmin
npm run watch                 # nodemon
```

## Not yet done

- CI/CD (auto-deploy on git push) — deliberately out of scope for now, revisit later.
