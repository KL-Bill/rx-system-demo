# rx-system

Rx generator + pharmacy demand tracker. Express app backed by Postgres, containerized with Podman (Windows).

## Stack

- Node.js / Express, run in cluster mode (fixed worker count, see `WEB_CONCURRENCY`)
- Postgres (schema in `db/schema.sql`)
- Podman (app container + Postgres container, one pod) — Windows Scheduled Tasks handle boot-start and backups; Podman's own `restartPolicy: Always` handles crash-restart
- Separate Electron kiosk client: `rx-system-client` (not this repo)

## Two medicine lists, and why the wording matters

**Bizbox** is the hospital's main dispensing system. It is not this app and
this app cannot talk to it. **The RX Formulary** is this app's own copy of the
medicine list, and every product in it is flagged either *In Bizbox* or *not*.

That flag is the whole point of the system. A nurse only prints a slip here
when Bizbox will not release the medicine — because Bizbox does not carry it,
or carries it but has none in stock. The pharmacy then reviews what keeps
being prescribed outside Bizbox, which is the evidence for stocking it.

So the two lists drift apart as Bizbox gains and loses products, and the
**Bizbox import** is what brings the RX Formulary back in step. Everything
below uses these two names precisely; "Formulary" on its own is the old
wording and no longer appears in the UI.

### What each role sees

**Nurse** — `/`, no login, one station per kiosk (`/?station=st-er` pins it).
Pick the generic, then the brand, form and strength as Bizbox writes them, in
a single search box. Tick **No brand** for an unbranded medicine, which swaps
that box for Form and Strength. Type something Bizbox does not list and three
fields open underneath, prefilled by a splitter, for the nurse to confirm
before adding — so a new medicine is still stored as clean brand / form /
strength, never as one blob of text. Picking a medicine that *is* in Bizbox
asks "are you sure?" first. The prescription is recorded on the first **Print**
click, not on Add and not on New patient.

**Medical supplies** (gloves, catheters, syringes) follow the same rules and go
on the same prescription, in the same numbered list. A **Medicine / Supply**
switch at the top of the Add panel swaps the boxes: a supply is one search box
(Bizbox's wording, with its item code), plus the same Out of stock, Qty and
Sig. Picking one Bizbox carries asks "are you sure?"; typing one it does not
carry is allowed and prints bold, like a new medicine. The kiosk remembers
which kind it was last adding. Supplies live in their own flat `supplies`
table (code + description), not the generic/brand/form/strength tree, and on
Review and Reports they show the supply in the Generic column and
"Supply · code" beside it. *Medicines only* / *Supplies only* presets split
them; the Brand filters (*Branded only*, *No brand only*) apply to medicines
only.

**Previous prescriptions** on the nurse page finds a slip a station lost and
reprints it: search by patient, doctor, medicine or address, within a date
range. A kiosk only ever sees what *it* printed. Each save hands the kiosk an
unguessable receipt, the kiosk keeps its receipts in its own browser storage,
and the server answers only for receipts it is shown, so another computer on
the network gets nothing and no PIN is needed. A reprint records no new
prescription, so demand is never counted twice; the copy is identical to the
original, date and time included, and the reprint is logged for IT with the
station and id only. Older prescriptions, or
ones printed on another kiosk, the pharmacy can still find and reprint from
its Logs page.

**Pharmacy** — `/dashboard` (review), `/reports`, `/logs`, and `/medicines`
for the head only. Review has four tabs: To review, Reviewed, Prescribed but
In Bizbox, Resolved. Each row carries a **Remarks** history explaining why it
is still open; "Set remark" opens a short stepper, and the preset *Available
in Bizbox* also resolves the row after showing exactly what will change.
Review has a **Period** that decides which prescriptions are counted, so the
tab counts, # RX and # Prescribed all follow it. Both review and reports have
a filter bar with one-click presets (Branded only, No brand only, No remarks,
and so on) that persist per browser, so each kiosk keeps its own view; presets
that contradict each other switch each other off. Reports has a print preview
with paper size, orientation, text size, margins and column choices, also
remembered per browser.

Every date filter in the app takes a range, with a quick menu beside it:
Today, Last 7 days, Last 30 days, This month, Last month, All time.

**IT** — `/it`. Tabs for the system log, pharmacy audit, accounts,
prescriptions, backups, **Medicines**, and **Doctors & Stations**. Renaming a
doctor offers to correct past prescriptions written under the old name, since
reports group by that name; the same applies to a station's department.

### Keeping the RX Formulary in step

The Medicines page (pharmacy head at `/medicines`, IT on its Medicines tab)
has two tabs:

- **RX Formulary** — search the whole list, fix a spelling, merge a duplicate
  into the entry you keep, or add a single medicine by hand. The
  **Medicines / Supplies** chip switches to the supplies list, which has the
  same edit, merge, add and restore.
- **Import from Bizbox** — upload the Bizbox export (`.xlsx` or `.csv`): the
  medicine list (generic and description, e.g. AllMeds) or the supplies list
  (item code and description, e.g. MEDSUPP — `Pk_iwitems`, `Itemdesc`). The
  column screen asks what the file lists and guesses it from the headers.
  Supplies are matched by Bizbox code first, then by wording, so there is
  nothing to split and no *Needs your decision* group; lines that are not
  supplies (the `MEDSUO-` services, for instance) can be skipped, and
  remembered. For medicines: confirm which column is which, watch the
  analysis run, then review the result in four plain groups: *Needs your
  decision*, *New to RX Formulary*, *Now marked In Bizbox*, and *Already in RX
  Formulary*. Only rows the import could not settle need a person, and each
  says why in words. Nothing is written until **Apply import**; choices are
  saved as you go, so you can leave and come back, or discard the file.

The import never removes or unmarks anything. Products marked In Bizbox that
the file does not list are reported at the end, for information only. The job
lives in the database rather than in memory, because the app runs several
workers — which is also why progress survives a refresh.

### Soft delete

Nothing removed on a page is gone for good. Deleted prescriptions, removed
doctors, and duplicates merged away in the RX Formulary all keep their rows,
hidden from every list, count, report and search, and each has a Restore:
the **Deleted** view on the IT prescriptions tab, **Show removed** on Doctors,
and the **Removed** chip on the RX Formulary. Pharmacy accounts were already
soft — they deactivate rather than delete.

### Two tiers of IT

An IT account created at the server console with `create-admin` is **master
IT**: it alone sees the Accounts tab and can create, reset or deactivate
logins, including other IT accounts. An IT account created from the IT page is
not master — it gets the whole console except Accounts. Two guards prevent a
lock-out: you cannot deactivate your own account, and the last active master
IT account cannot be deactivated at all.

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

**Read these two first.** Both are decisions you cannot change later without
starting over, and both are made before step 3:

1. **[Which account owns podman](#which-account-owns-podman)** — the podman
   machine belongs to the user profile that creates it. Create it as the
   account that will log in on the server, *not* the admin used to install
   Podman. Getting this wrong is the single most common reason the pod stops
   coming up after a reboot, and the only fix is to redo it as the right user.
2. **[WSL vs Hyper-V](#choosing-the-podman-machine-provider-wsl-vs-hyper-v)** —
   a machine cannot switch providers; you delete it and make a new one. The
   provider also decides the `hostPath` you need in step 3.

```powershell
# 1. Install Podman Desktop (or the podman CLI) if not already installed.
#    Podman on Windows runs containers inside a small Linux VM under the
#    hood (`podman machine`) — you still just run `podman` commands
#    directly from PowerShell, same as on Linux/Mac.
#
#    Podman may be INSTALLED by an admin, but the machine below must be
#    CREATED by the account that will log in on the server. Log in as that
#    account before running these:
whoami                                        # confirm who you are
$env:CONTAINERS_MACHINE_PROVIDER = "hyperv"   # omit for the WSL default
podman machine init
podman machine start

# 2. Get the code
git clone <your-repo-url> rx-system
cd rx-system
# (only if migrating an existing in-use copy: drop its data.json in here now)

# 3. Set up the per-machine config
Copy-Item pod.yaml.example pod.yaml
podman machine ssh whoami        # tells you which home directory to use — see below
notepad pod.yaml
# edit pod.yaml:
#   - hostPath path — a plain Linux-style path, NOT a Windows C:\ path. This
#     lives inside the podman machine VM and is what makes Postgres data
#     survive container restarts/rebuilds. WHICH path depends on the provider:
#       WSL provider      -> user "user", use /home/user/rx-system/pgdata
#       Hyper-V provider  -> the VM is Fedora CoreOS, whose user is "core",
#                            so use /home/core/rx-system/pgdata
#     `podman machine ssh whoami` above prints it. Getting this wrong isn't
#     fatal (DirectoryOrCreate makes the directory either way) but your data
#     ends up somewhere you won't think to look.
#   - the two CHANGE_ME secrets (SECRET_KEY, PGPASSWORD — PGPASSWORD must
#     match POSTGRES_PASSWORD further down in the same file)

# 4. Build the app image
podman build -t localhost/rx-system:latest .

# 5. Register the boot-start + 12h-backup Scheduled Tasks (one-time — see
#    "Automation" below for what this actually does).
#    Run this AS THE ACCOUNT THAT WILL LOG IN ON THE SERVER — not from an
#    admin shell belonging to someone else. See "Which account owns podman".
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

  **This task triggers at logon, not at system startup.** The reason:
  `podman machine` belongs to a specific *user profile*, so the task has to run
  as that user to find it (see "Which account owns podman"). A task running as
  SYSTEM would look for a different, non-existent machine, and an "at system
  startup" trigger under a "run only when user is logged on" principal never
  fires at all (Task Scheduler reports `0x1` / `0x800710E0 — refused`).

  Someone logging in normally is enough — the trigger doesn't care whether the
  password was typed or not. **Auto-login is only needed if you want the pod up
  with nobody at the machine.** To enable it, run `netplwiz`, uncheck *"Users
  must enter a user name and password to use this computer"*, and enter that
  account's password when prompted. (If the checkbox isn't shown, set
  `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\PasswordLess\Device
  \DevicePasswordLessBuildVersion` to `0` and reopen `netplwiz`.) Treat the
  server as physically secured if you do — anyone at the keyboard is already
  signed in.

  The task runs hidden; its output goes to `logs/start-pod.log` — check there
  first if the pod isn't up after a reboot. A healthy run takes roughly 15–30
  seconds and ends with `app is answering on port 3000`; the pod does not exist
  until the task finishes, so "still Running" means "not deployed yet". The
  script polls for each condition rather than sleeping a fixed amount, exits
  early if the app is already up, and refuses to run two copies at once — two
  overlapping runs used to destroy each other, because `kube play --replace`
  from the second tears down the pod the first just built.
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

### Choosing the podman machine provider (WSL vs Hyper-V)

Podman on Windows defaults to **WSL**. This deployment uses **Hyper-V**, which
is opt-in and has to be chosen when the machine is created — a machine cannot
be switched from one provider to the other afterwards, you delete it and make
a new one.

There is **no `--provider` flag** on `podman machine init` (checked against
podman 5.8.0). The provider comes from configuration, and is read when the
machine is created:

```powershell
# 1. Enable Hyper-V itself (as Administrator; requires a reboot)
Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All

# 2. As the account that will own the machine (see the next section):
podman machine list             # what you have now, and its VMType

$env:CONTAINERS_MACHINE_PROVIDER = "hyperv"
podman machine init rx-hyperv   # a NAME keeps your existing WSL machine intact
podman machine start rx-hyperv

# 3. Confirm what you actually got
podman machine list             # VMType column: hyperv vs wsl
podman machine ssh rx-hyperv whoami    # "core" = Hyper-V (Fedora CoreOS), "user" = WSL
```

To make it permanent rather than per-session, set it in
`%APPDATA%\containers\containers.conf`:

```toml
[machine]
provider = "hyperv"
```

**Images and volumes do not move between machines.** Each machine has its own
storage, so a new one starts empty and re-pulls everything — that is true
whether or not you keep the old machine. Naming the new machine only preserves
the old one as a fallback. To avoid re-downloading a large image:

```powershell
podman save -o C:\temp\pg16.tar docker.io/library/postgres:16-alpine
# ...switch machines...
podman load -i C:\temp\pg16.tar
```

Deleting the old machine (`podman machine rm podman-machine-default`) destroys
every image, container and volume inside it — including other projects'. Only
do that once the new machine is working.

The provider decides the in-VM home directory, which is what the `hostPath` in
`pod.yaml` has to match — `/home/core/...` on Hyper-V, `/home/user/...` on WSL.
Step 3 of First-time setup covers that.

### Which account owns podman

The single most common way a working install stops working after a reboot.

A podman machine belongs to the **user profile that created it** — its config
lives in that user's `%LOCALAPPDATA%\containers\podman`. It is not shared
between accounts. Install Podman as an admin, run `podman machine init` as
that admin, then have the server log in as a standard user, and that user has
no machine at all: `rx-system-start` fails at every boot with

```
Error: podman-machine-default: VM does not exist
```

…and no amount of retrying fixes it, because the machine it's looking for was
never created for that account.

Three things must be the same account:

```
the account that runs `podman machine init`
  = the account that logs in on the server
  = the account rx-system-start runs as
```

`setup-windows-tasks.ps1` registers the tasks for whoever runs it, and warns
if that account has no machine — so run it as the account that will be logged
in, not from an elevated shell belonging to someone else. To check at any
time:

```powershell
whoami
podman machine inspect podman-machine-default   # exit 0 = this account owns one
```

If it's the wrong account, `podman machine init` as the right one. There is no
way to hand an existing machine over to another profile.

### Redeploying after a code change

```powershell
.\scripts\backup-db.ps1                       # safety copy before anything
git pull
# ...if the release changed the schema, run its migration HERE — see below...
podman build -t localhost/rx-system:latest .
podman kube play pod.yaml --replace
```

Code lives *inside* the image (`COPY . .` in the Dockerfile) — editing files
in the repo folder on the server changes nothing until you rebuild. That's why
this is a manual step and not just a `git pull`.

**If the release changed the schema, migrate BEFORE the rebuild.** The
September 2026 release (Bizbox) did, so any server still on an older build
needs the extra pair of commands below. Migrations only add columns and
tables, so the old code keeps running happily beside them — which is the whole
point of going first. Rebuild first instead and the new code starts against
the old schema and throws until the migration lands.

```powershell
# copy the script into the container that is still running the OLD image,
# which does not contain it yet — `git pull` updated the repo folder on disk,
# not the image
podman cp scripts\migrate-add-bizbox-columns.js rx-system-app:/app/scripts/

# run it in the container: the database only listens inside the pod, and the
# app container already holds the right PGUSER/PGPASSWORD. From the Windows
# host the same script fails on credentials.
podman exec rx-system-app node scripts/migrate-add-bizbox-columns.js
```

It prints `Migration done. Descriptions stitched for N existing product(s)`.
Safe to re-run. Once the new image is built the copy is no longer needed —
later runs are just `podman exec rx-system-app npm run migrate:bizbox`.

**If the server has no git clone**, copy the changed files in by hand (USB,
network share, whatever) and run the same `build` and `kube play`. Only the files
that actually changed need to go over — there is no need to replace the whole
folder, and replacing it wholesale is how people lose their config.

Never overwrite these on the server, they are per-machine and not in git:

| File | Holds |
|---|---|
| `pod.yaml` | `SECRET_KEY`, `PGPASSWORD`, the pgdata path |
| `.env` | local dev config, if present |
| `data.json` | only relevant to a pre-Postgres install |
| `logs/` | `start-pod.log` |

Nothing under `src/`, `scripts/` or `db/` is machine-specific, so those are
always safe to overwrite. The database lives inside the podman machine, not in
the repo folder, so copying files can't touch accounts or prescriptions.

Then, if the Scheduled Task scripts changed (`start-pod.ps1`,
`setup-windows-tasks.ps1`), re-register them — copying the files alone does
nothing, Task Scheduler holds its own copy of the command line:

```powershell
.\scripts\setup-windows-tasks.ps1     # as the account that logs in on the server
```

#### Turning a hand-copied server into a git clone

Worth doing once so later updates are a `git pull` instead of picking files
out by hand. Do it **in place** — a fresh clone into a new folder changes the
repo path, and the Scheduled Tasks store an absolute path to
`scripts\start-pod.ps1`, so they would all have to be re-registered.

```powershell
cd C:\rx-system              # the existing folder, whatever path it really is
git init
git remote add origin <your-repo-url>
git fetch origin
git reset --hard origin/main
git branch --set-upstream-to=origin/main main
```

`reset --hard` only touches files git tracks. `pod.yaml`, `.env`, `data.json`
and `logs/` are all gitignored, so they are untracked and survive untouched —
your `SECRET_KEY` and `PGPASSWORD` are not at risk. What it *does* overwrite is
any hand-edit made directly on the server to a tracked file; check for those
first if you think someone patched something in place:

```powershell
git status                   # after the fetch, before the reset
```

From then on:

```powershell
git pull
podman build -t localhost/rx-system:latest .
podman kube play pod.yaml --replace
```

`git pull` on its own deploys nothing — the code is baked into the image at
build time, so the rebuild is still required.

**If the schema changed and you are keeping the existing database**, apply the
matching migration before or after the rebuild. These add only what's new;
they never drop data, and they're safe to re-run:

```powershell
podman exec rx-system-app node scripts/migrate-add-it.js              # IT page (older installs)
podman exec rx-system-app node scripts/migrate-add-search-indexes.js  # medicine search indexes
podman exec rx-system-app npm run migrate:bizbox                      # Sept 2026 Bizbox release
```

You only need these on a database that already exists and is staying. A
database created fresh from `db/schema.sql` already has everything in them —
skip them entirely on a from-scratch build.

`migrate:bizbox` is one script covering the whole September 2026 release:
the Bizbox description columns on `strengths`, the `review_remarks`,
`catalog_imports` and `catalog_import_exclusions` tables, `users.is_master`
for the two IT tiers, and the soft-delete columns on prescriptions, doctors
and strengths, and the `supplies` table for medical supplies. It backfills a stitched description for every existing product
and marks every IT account that predates it as master. Additive only: nothing
is dropped, renamed or retyped, and re-running it is a no-op.

Note that on a container built from an older image the script is not present
yet, so it needs the `podman cp` shown in the redeploy section above. That is
the only reason the Bizbox line differs from the two above it.

The Electron kiosk client (`rx-system-client`) shows a "Connecting to server…"
splash screen with a 90-second grace period before it tells staff to contact
IT, so a routine restart like this doesn't need a maintenance-mode banner —
staff just see a brief reconnect.

### Tearing down and rebuilding from scratch

For local testing, or to redo a bad install. **This destroys the database** —
take a backup first if the data matters (`.\scripts\backup-db.ps1`).

```powershell
# 1. Remove the pod and the app image
podman pod rm -f rx-system
podman rmi localhost/rx-system:latest

# 2. Remove the database directory. This is the step people miss: pod.yaml
#    uses a hostPath INSIDE the podman machine VM, not a podman volume, so
#    removing the pod, the image and the repo folder all leave it untouched.
#    Use the path from your own pod.yaml (/home/user/... on WSL,
#    /home/core/... on Hyper-V).
podman machine ssh "rm -rf /home/user/rx-system/pgdata /home/user/rx-system/backups"

# 3. Remove the Scheduled Tasks, if they were registered
Unregister-ScheduledTask -TaskName rx-system-start, rx-system-backup -Confirm:$false
```

Then start again from **First-time setup**, step 3.

Do **not** use `podman system prune -a` to clean up — it removes images and
volumes belonging to every other project on the machine, not just this one.

### Day-to-day operations

| Task | Command |
|---|---|
| Check pod status | `podman ps` |
| View app logs | `podman logs -f rx-system-app` |
| Restart | `podman kube play pod.yaml --replace` |
| Stop | `podman kube down pod.yaml` |
| Create another admin login | `podman exec rx-system-app npm run create-admin -- <username> <password> [role]` |
| Create a **master** IT login | same command with role `it` — only console-made IT accounts manage accounts |
| Bring the RX Formulary in step with Bizbox | no command: sign in as the pharmacy head or IT, open **Medicines → Import from Bizbox**, upload the export |
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
- The staff manuals in `docs/*.docx` (Nurse, Pharmacy, IT, Overview,
  Troubleshooting, Codebase) still describe the pre-Bizbox app: the old
  "Formulary" wording, the four-box medicine picker, and no Medicines page,
  remarks, filter bar, print preview or soft delete. Regenerate them with the
  scripts in `docs/screenshot-tools/` before handing them to staff.
