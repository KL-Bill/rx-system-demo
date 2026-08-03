# rx-system

Rx generator + pharmacy demand tracker. Express app backed by Postgres, containerized with Podman (Windows).

## Stack

- Node.js / Express, run in cluster mode (fixed worker count, see `WEB_CONCURRENCY`)
- Postgres (schema in `db/schema.sql`)
- Podman (app container + Postgres container, one pod) — Windows Scheduled Tasks handle boot-start and backups; Podman's own `restartPolicy: Always` handles crash-restart
- Separate Electron kiosk client: `rx-system-client` (not this repo)

## Deploying (this PC, or any other Windows machine)

A fresh `git clone` already has everything needed to run: the drug catalog
(`medicines.json`), the hospital stations (`scripts/migrate-to-postgres.js`'s
`BASELINE_STATIONS` list — edit that array directly if the department names
ever change), and 286 doctors (`doctors.json`) are all committed to git and
load in automatically the first time you run `npm run migrate` below. Nothing
to carry over manually for a normal fresh setup.

(The only optional case: if you're moving an *already-in-use* copy of this
app — one that's had real prescriptions/logins created on it — its `data.json`
holds that history and is gitignored, so it doesn't travel with `git clone`.
Copy it into the new checkout yourself first if you want that history to
carry over. If this is a new setup, ignore this paragraph entirely.)

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
# (only if migrating an existing in-use copy: drop its data.json in here now)

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

# 8. Load the catalog + baseline stations/doctors (and, if you brought an old
#    data.json over, its users/prescriptions/history too) - always run this
podman exec rx-system-app npm run migrate

# 9. Create yourself a login (skip only if step 8 brought over an existing data.json's users)
podman exec rx-system-app npm run create-admin -- youradmin yourpassword superadmin
```

### Automation — what's actually automatic vs. one-time setup

Every automated thing here needs exactly one registration step before it runs
itself — that's unavoidable on any OS (Linux would need `systemctl enable`;
here it's `setup-windows-tasks.ps1`, run once). After that single run:

- **Boot-start**: the `rx-system-start` Scheduled Task runs
  `scripts/start-pod.ps1`, which starts `podman machine` (the VM podman itself
  runs on — it doesn't come back up on its own after a reboot) and then
  `podman kube play`.

  **This task triggers at logon, not at system startup — so the server must be
  set to log in automatically.** The reason: `podman machine` belongs to a
  specific *user profile*, so the task has to run as that user to find it. A
  task running as SYSTEM would look for a different, non-existent machine, and
  an "at system startup" trigger under a "run only when user is logged on"
  account never fires at all (Task Scheduler reports `0x1` /
  `0x800710E0 — refused`). With auto-login the full chain works unattended:
  power on → auto-login → task → podman machine → pod.

  To enable auto-login on the server, run `netplwiz`, uncheck *"Users must
  enter a user name and password to use this computer"*, and enter that
  account's password when prompted. (If the checkbox isn't shown, set
  `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\PasswordLess\Device
  \DevicePasswordLessBuildVersion` to `0` and reopen `netplwiz`.) Treat the
  server as physically secured — auto-login means anyone at the keyboard is
  already signed in.

  The task runs hidden; its output goes to `logs/start-pod.log` — check there
  first if the pod isn't up after a reboot.
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

# Apply database upgrade for older installations
podman exec rx-system-app node scripts/migrate-add-it.js

podman restart rx-system-app
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
| Why didn't the pod start at boot? | `Get-Content logs\start-pod.log -Tail 40` |
| Start the pod by hand | `.\scripts\start-pod.ps1` |
| Rebuild the drug catalog | `node scripts/build-medicines.js && node scripts/tag-pnf.js` (run locally, not in the container — the source files it needs aren't shipped in the image; commit the regenerated `medicines.json` and redeploy) |

### Backups — where the files actually are

Each run of `scripts/backup-db.ps1` writes the same dump to two places:

- **`/backups` inside the pod** (the `backups` volume in `pod.yaml`). The app
  mounts this read-only, which is what makes the **Download** button on the IT
  page work — a container can't reach the Windows filesystem otherwise.
- **`C:\rx-system\backups` on the Windows host** (copied out with `podman cp`).
  This is the copy that survives if the podman machine VM is lost or rebuilt,
  so it's the real safety net.

Both are pruned after 7 days, along with the matching rows in the `backups`
table, so the IT page never lists a backup that can't be downloaded.

Note that `podman cp` only gets a dump onto the *server's* disk. To get one
onto an IT workstation, either use the IT page's Download button, or share
`C:\rx-system\backups` over the network. Every download is recorded in the
system log (`backup_downloaded`) — it's a copy of the whole database leaving
the server.

### Restoring from the IT page

The Backups tab has a **Restore** button per backup. It requires typing the
filename and re-entering the IT password, and it dumps the current database to
a `-pre-restore.sql` safety backup first — so a mistaken restore can be walked
back by restoring that file.

The restore runs in a single transaction (`--single-transaction` +
`ON_ERROR_STOP`), so a failure rolls back completely and leaves the live
database untouched rather than half-restored.

Two things to know:

- **A restore replaces `users` too.** If the backup predates an IT account,
  that login disappears with it — recover by restoring the safety backup from
  the server console (see below).
- **Client and server Postgres versions must match.** The app image installs
  `postgresql16-client` to pair with `postgres:16-alpine`; bump both together
  or dumps will fail to load (a v17 dump uses syntax v16 rejects, and vice
  versa).

### Restoring from a backup

Dumps are taken with `--clean --if-exists`, so restoring REPLACES the current
contents — the file drops each object before recreating it. Everything written
since that backup was taken is gone. Take a fresh backup first if the current
data matters:

```powershell
.\scripts\backup-db.ps1
podman exec rx-system-postgres psql -U rxsystem -d rxsystem -f /backups/rx-system-<timestamp>.sql
```

(Backups taken before the `--clean` flag was added restore *only onto an empty
database*. Against a populated one they fail every statement with "already
exists" and change nothing — check the output for `ERROR` lines rather than
assuming a silent run succeeded.)

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
npm run migrate               # loads the catalog + baseline stations/doctors
npm run create-admin -- youradmin yourpassword superadmin
npm run watch                 # nodemon
```

## Not yet done

- CI/CD (auto-deploy on git push) — deliberately out of scope for now, revisit later.
