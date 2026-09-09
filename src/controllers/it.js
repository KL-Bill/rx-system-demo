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
        const user = await itModel.setActive(req.params.id, active, req.user);
        logEvent(active ? 'user_reactivated' : 'user_deactivated', req, { target: user.username });
        return res.json({ success: true });
    } catch (err) { return handle(res, err); }
};

const backups = async (req, res) => {
    try { return res.json({ success: true, ...(await itModel.listBackups()) }); }
    catch (err) { return handle(res, err); }
};

const createBackup = async (req, res) => {
    try {
        const result = await itModel.createBackup();
        logEvent('backup_created', req, {
            target: result.file,
            details: { sizeBytes: result.sizeBytes, durationMs: result.durationMs },
        });
        return res.status(201).json({ success: true, ...result });
    } catch (err) { return handle(res, err); }
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

const prescriptions = async (req, res) => {
    try {
        const { from, to, limit, offset } = req.query;
        return res.json({ success: true, ...(await itModel.listPrescriptions({ from, to, limit, offset, deleted: req.query.deleted })) });
    } catch (err) { return handle(res, err); }
};

// Deleting prescriptions changes demand counts and the pharmacy dashboard (they
// can be restored from the Deleted view) — so the event is logged
// with the count and the range it covered. No patient data, same as rx_created.
const deletePrescriptions = async (req, res) => {
    try {
        const result = await itModel.deletePrescriptions(req.body, req.user);
        logEvent('rx_deleted', req, {
            target: result.mode === 'range'
                ? `${result.from || 'start'} → ${result.to || 'now'}`
                : `${result.deleted} selected`,
            details: { count: result.deleted, mode: result.mode },
        });
        return res.json({ success: true, ...result });
    } catch (err) { return handle(res, err); }
};

const health = async (req, res) => {
    try { return res.json({ success: true, health: await itModel.health() }); }
    catch (err) { return handle(res, err); }
};

const restorePrescriptions = async (req, res) => {
    try {
        const result = await itModel.restorePrescriptions(req.body || {});
        logEvent('rx_restored', req, { target: `${result.restored} restored`, details: { count: result.restored } });
        return res.json({ success: true, ...result });
    } catch (err) { return handle(res, err); }
};

// ----- doctors & stations -----
const doctors = async (req, res) => {
    try { return res.json({ success: true, doctors: await itModel.listDoctors() }); }
    catch (err) { return handle(res, err); }
};
const createDoctor = async (req, res) => {
    try {
        const doctor = await itModel.createDoctor(req.body || {});
        logEvent('doctor_created', req, { target: doctor.name });
        return res.status(201).json({ success: true, doctor });
    } catch (err) { return handle(res, err); }
};
const updateDoctor = async (req, res) => {
    try {
        const out = await itModel.updateDoctor(req.params.id, req.body || {});
        logEvent('doctor_updated', req, { target: out.doctor.name, details: { from: out.before.name, prescriptionsRewritten: out.rewritten } });
        return res.json({ success: true, ...out });
    } catch (err) { return handle(res, err); }
};
const deleteDoctor = async (req, res) => {
    try {
        const out = await itModel.deleteDoctor(req.params.id);
        logEvent('doctor_deleted', req, { target: out.doctor.name, details: { prescriptionsKept: out.prescriptionsKept } });
        return res.json({ success: true, ...out });
    } catch (err) { return handle(res, err); }
};
const restoreDoctor = async (req, res) => {
    try {
        const out = await itModel.restoreDoctor(req.params.id);
        logEvent('doctor_restored', req, { target: out.doctor.name });
        return res.json({ success: true, ...out });
    } catch (err) { return handle(res, err); }
};
const stations = async (req, res) => {
    try { return res.json({ success: true, stations: await itModel.listStations() }); }
    catch (err) { return handle(res, err); }
};
const createStation = async (req, res) => {
    try {
        const station = await itModel.createStation(req.body || {});
        logEvent('station_created', req, { target: `${station.name} · ${station.department}` });
        return res.status(201).json({ success: true, station });
    } catch (err) { return handle(res, err); }
};
const updateStation = async (req, res) => {
    try {
        const out = await itModel.updateStation(req.params.id, req.body || {});
        logEvent('station_updated', req, { target: `${out.station.name} · ${out.station.department}`, details: { from: `${out.before.name} · ${out.before.department}`, prescriptionsRewritten: out.rewritten } });
        return res.json({ success: true, ...out });
    } catch (err) { return handle(res, err); }
};

module.exports = {
    logs, audit, users, createUser, resetPassword, setActive,
    backups, createBackup, downloadBackup, restoreBackup, health,
    prescriptions, deletePrescriptions, restorePrescriptions,
    doctors, createDoctor, updateDoctor, deleteDoctor, restoreDoctor, stations, createStation, updateStation,
};
