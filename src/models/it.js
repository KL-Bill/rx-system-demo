const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const bcrypt = require('bcryptjs');
const db = require('../_db/db_functions');
const { pool, newId } = require('../_db/store');
const { version } = require('../../package.json');

// mounted read-only from the pod's `backups` volume — see pod.yaml
const BACKUP_DIR = process.env.BACKUP_DIR || '/backups';

const httpError = (status, message) => Object.assign(new Error(message), { status });

// roles the IT page may hand out. 'it' is deliberately absent: IT accounts
// are created only at the server console (scripts/create-admin.js), so a
// compromised IT session can't mint more IT logins.
const CREATABLE_ROLES = ['admin', 'staff'];

const listLogs = (filters) => db.getSystemLogs(filters);
const listAudit = () => db.getAudit();   // pharmacy management actions (no patient data)
const listUsers = () => db.listUsers();

const createUser = async ({ name, username, password, role }) => {
    name = (name || '').trim();
    username = (username || '').trim();
    if (!username || !password) throw httpError(400, 'Username and password are required');
    if (password.length < 8) throw httpError(400, 'Password must be at least 8 characters');
    if (!CREATABLE_ROLES.includes(role)) {
        throw httpError(400, `Role must be one of: ${CREATABLE_ROLES.join(', ')}`);
    }
    if (await db.getUserByUsername(username)) {
        throw httpError(409, `A user named "${username}" already exists`);
    }
    const id = newId('u');
    await db.insertUser({ id, name: name || username, username, passwordHash: bcrypt.hashSync(password, 10), role });
    return { id, name: name || username, username, role, active: true };
};

// IT accounts stay CLI-managed end to end — the API can't touch them either
const getManagedUser = async (id) => {
    const user = await db.getUserById(id);
    if (!user) throw httpError(404, 'No such user');
    if (user.role === 'it') throw httpError(403, 'IT accounts are managed from the server console only');
    return user;
};

const resetPassword = async (id, password) => {
    if (!password || password.length < 8) throw httpError(400, 'Password must be at least 8 characters');
    const user = await getManagedUser(id);
    await db.updateUserPassword(id, bcrypt.hashSync(password, 10));
    return user;
};

const setActive = async (id, active) => {
    const user = await getManagedUser(id);
    await db.setUserActive(id, !!active);
    return user;
};

const listBackups = async () => {
    // self-heal first: a dump can be on disk without a row (a restore wiped
    // the table, or someone copied a file in by hand). Without this it would
    // be invisible to the IT page and refused by download/restore.
    await reconcileBackups();

    const backups = await db.getBackups();
    const lastOk = backups.find((b) => b.status === 'ok');
    return {
        // downloadable only if the dump is actually still on disk — the host
        // copy in C:\rx-system\backups isn't reachable from in here
        backups: backups.map((b) => ({
            ...b,
            downloadable: b.status === 'ok' && fs.existsSync(path.join(BACKUP_DIR, b.file)),
        })),
        lastOkAt: lastOk ? lastOk.at : null,
        // the host task runs every 12h — past ~13h means it silently died
        stale: !lastOk || Date.now() - lastOk.at > 13 * 60 * 60 * 1000,
    };
};

// Resolves a requested filename to a real path on disk. Two independent
// gates, because this endpoint hands out the entire database: the name must
// match the strict pattern backup-db.ps1 generates, AND it must already be a
// row in the backups table. A traversal attempt fails both.
// the -pre-restore variant is what a restore writes as its safety dump
const BACKUP_FILE_RE = /^rx-system-\d{8}-\d{6}(-pre-restore)?\.sql$/;

const backupPath = async (file) => {
    if (!BACKUP_FILE_RE.test(file || '')) throw httpError(400, 'Invalid backup filename');
    const row = await db.getBackupByFile(file);
    if (!row || row.status !== 'ok') throw httpError(404, 'No such backup');

    const full = path.join(BACKUP_DIR, file);
    // belt and braces: the joined path must still sit inside BACKUP_DIR
    if (path.dirname(path.resolve(full)) !== path.resolve(BACKUP_DIR)) {
        throw httpError(400, 'Invalid backup filename');
    }
    if (!fs.existsSync(full)) {
        throw httpError(410, 'This backup is no longer on the server (it may have passed the retention window)');
    }
    return { path: full, file, sizeBytes: row.sizeBytes };
};

// ---------- restore ----------

const PG = {
    host: process.env.PGHOST || 'localhost',
    port: process.env.PGPORT || '5432',
    user: process.env.PGUSER || 'postgres',
    database: process.env.PGDATABASE || 'rxsystem',
};
const pgEnv = { ...process.env, PGPASSWORD: process.env.PGPASSWORD || '' };

const run = (cmd, args, timeoutMs) => new Promise((resolve, reject) => {
    execFile(cmd, args, { env: pgEnv, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(Object.assign(err, { stdout, stderr }));
        resolve({ stdout, stderr });
    });
});

const stamp = () => {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// Dump the current database into the backups volume and register it, so a
// restore can be walked back. Same --clean --if-exists as backup-db.ps1 —
// a dump without those flags can't be restored onto a live database.
const safetyDump = async () => {
    const file = `rx-system-${stamp()}-pre-restore.sql`;
    const full = path.join(BACKUP_DIR, file);
    const started = Date.now();
    await run('pg_dump', ['-h', PG.host, '-p', PG.port, '-U', PG.user,
        '--clean', '--if-exists', '-f', full, PG.database], 10 * 60 * 1000);
    const size = fs.existsSync(full) ? fs.statSync(full).size : 0;
    await db.addBackup({ file, sizeBytes: size, durationMs: Date.now() - started, status: 'ok' });
    return { file, sizeBytes: size };
};

const atFromName = (file) => {
    const m = file.match(/^rx-system-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
    if (!m) return Date.now();
    const [Y, M, D, h, mi, s] = m.slice(1).map(Number);
    return new Date(Y, M - 1, D, h, mi, s).getTime();
};

// A restore replaces the `backups` table along with everything else, so rows
// registered after the restored dump was taken — including the safety dump
// this very restore just wrote — vanish with it. Without this the safety
// backup would sit on disk unusable, since downloads and restores both
// require a matching row. Re-registers any dump file that lost its row.
const reconcileBackups = async () => {
    if (!fs.existsSync(BACKUP_DIR)) return;
    const known = new Set(await db.getBackupFiles());
    for (const file of fs.readdirSync(BACKUP_DIR)) {
        if (!BACKUP_FILE_RE.test(file) || known.has(file)) continue;
        await db.addBackup({
            at: atFromName(file),
            file,
            sizeBytes: fs.statSync(path.join(BACKUP_DIR, file)).size,
            status: 'ok',
        });
    }
};

// Replaces the live database with the contents of a backup.
//   confirm  — must equal the filename; makes this hard to do by accident
//   password — the caller's own IT password, re-entered
const restoreBackup = async (fileName, { password, confirm }, actor) => {
    const b = await backupPath(fileName);

    if (confirm !== fileName) throw httpError(400, 'Type the exact backup filename to confirm');

    const user = await db.getUserById(actor.id);
    if (!user || !(await bcrypt.compare(password || '', user.password))) {
        throw httpError(403, 'Incorrect password');
    }

    const safety = await safetyDump();

    // --single-transaction makes this all-or-nothing: any failure rolls the
    // whole thing back and leaves the live database untouched, instead of
    // stopping half-restored. ON_ERROR_STOP is what makes psql actually fail
    // on an error rather than plowing on and exiting 0.
    try {
        await run('psql', ['-h', PG.host, '-p', PG.port, '-U', PG.user, '-d', PG.database,
            '--single-transaction', '-v', 'ON_ERROR_STOP=1', '-f', b.path], 30 * 60 * 1000);
    } catch (err) {
        const detail = String(err.stderr || err.message).split('\n').find((l) => l.includes('ERROR')) || err.message;
        throw httpError(500, `Restore failed and was rolled back — the database is unchanged. ${detail}`);
    }

    await reconcileBackups();
    return { restored: fileName, safetyBackup: safety.file };
};

const health = async () => {
    let dbOk = true;
    try { await pool.query('SELECT 1'); } catch { dbOk = false; }
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    return {
        dbOk,
        version,
        uptimeSec: Math.floor(process.uptime()),
        users: await db.countRows('users'),
        prescriptions: await db.countRows('prescriptions'),
        systemLogs: await db.countRows('system_logs'),
        failedLogins24h: await db.countSystemLogs('login_failed', dayAgo),
    };
};

module.exports = {
    listLogs, listAudit, listUsers, createUser, resetPassword, setActive,
    listBackups, backupPath, restoreBackup, health,
};
