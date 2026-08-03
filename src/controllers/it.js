const itModel = require('../models/it');
const { logEvent } = require('../models/syslog');

const handle = (res, err) => {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
};

const logs = async (req, res) => {
    try {
        const { type, q, from, to, limit, offset } = req.query;
        return res.json({ success: true, ...(await itModel.listLogs({ type, q, from, to, limit, offset })) });
    } catch (err) { return handle(res, err); }
};

const audit = async (req, res) => {
    try { return res.json({ success: true, audit: await itModel.listAudit() }); }
    catch (err) { return handle(res, err); }
};

const users = async (req, res) => {
    try { return res.json({ success: true, users: await itModel.listUsers() }); }
    catch (err) { return handle(res, err); }
};

const createUser = async (req, res) => {
    try {
        const user = await itModel.createUser(req.body);
        logEvent('user_created', req, { target: `${user.username} (${user.role})` });
        return res.status(201).json({ success: true, user });
    } catch (err) { return handle(res, err); }
};

const resetPassword = async (req, res) => {
    try {
        const user = await itModel.resetPassword(req.params.id, req.body.password);
        logEvent('password_reset', req, { target: user.username });
        return res.json({ success: true });
    } catch (err) { return handle(res, err); }
};

const setActive = async (req, res) => {
    try {
        const active = !!req.body.active;
        const user = await itModel.setActive(req.params.id, active);
        logEvent(active ? 'user_reactivated' : 'user_deactivated', req, { target: user.username });
        return res.json({ success: true });
    } catch (err) { return handle(res, err); }
};

const backups = async (req, res) => {
    try { return res.json({ success: true, ...(await itModel.listBackups()) }); }
    catch (err) { return handle(res, err); }
};

// Downloading a backup means walking off with the whole database, so the
// event is logged BEFORE the file is sent — an aborted transfer still leaves
// the attempt on record.
const downloadBackup = async (req, res) => {
    try {
        const b = await itModel.backupPath(req.params.file);
        logEvent('backup_downloaded', req, { target: b.file, details: { sizeBytes: b.sizeBytes } });
        return res.download(b.path, b.file);
    } catch (err) { return handle(res, err); }
};

// Restoring replaces the whole database — including system_logs — so the
// event is logged AFTER it completes. Logging first would work, then be
// wiped by the very restore it was recording. (The pre-restore state is
// still recoverable from the safety dump this returns.)
const restoreBackup = async (req, res) => {
    try {
        const result = await itModel.restoreBackup(req.params.file, req.body, req.user);
        logEvent('backup_restored', req, {
            target: result.restored,
            details: { safetyBackup: result.safetyBackup },
        });
        return res.json({ success: true, ...result });
    } catch (err) {
        if (!err.status) console.error(err);
        return handle(res, err);
    }
};

const health = async (req, res) => {
    try { return res.json({ success: true, health: await itModel.health() }); }
    catch (err) { return handle(res, err); }
};

module.exports = {
    logs, audit, users, createUser, resetPassword, setActive,
    backups, downloadBackup, restoreBackup, health,
};
