const bcrypt = require('bcryptjs');
const db = require('../_db/db_functions');
const { pool, newId } = require('../_db/store');
const { version } = require('../../package.json');

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
    const backups = await db.getBackups();
    const lastOk = backups.find((b) => b.status === 'ok');
    return {
        backups,
        lastOkAt: lastOk ? lastOk.at : null,
        // the host task runs every 12h — past ~13h means it silently died
        stale: !lastOk || Date.now() - lastOk.at > 13 * 60 * 60 * 1000,
    };
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

module.exports = { listLogs, listAudit, listUsers, createUser, resetPassword, setActive, listBackups, health };
