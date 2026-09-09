const imp = require('../models/import');
const { logEvent } = require('../models/syslog');

const handle = (res, err) => {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
};

const upload = async (req, res) => {
    try {
        const name = String(req.query.name || 'upload.xlsx').slice(0, 200);
        const out = await imp.createFromUpload({ name, buffer: req.body, actor: req.user });
        logEvent('bizbox_import_uploaded', req, { target: name, details: { id: out.id, rows: out.rowCount } });
        return res.status(201).json({ success: true, ...out });
    } catch (err) { return handle(res, err); }
};

const analyze = async (req, res) => {
    try { return res.json({ success: true, ...(await imp.analyze(req.params.id, req.body || {}, req.user)) }); }
    catch (err) { return handle(res, err); }
};

const list = async (req, res) => {
    try { return res.json({ success: true, imports: await imp.list() }); }
    catch (err) { return handle(res, err); }
};

const get = async (req, res) => {
    try { return res.json({ success: true, import: await imp.get(req.params.id, { withRows: req.query.rows === '1' }) }); }
    catch (err) { return handle(res, err); }
};

const decisions = async (req, res) => {
    try { return res.json({ success: true, ...(await imp.saveDecisions(req.params.id, req.body.decisions, req.user)) }); }
    catch (err) { return handle(res, err); }
};

const apply = async (req, res) => {
    try {
        const out = await imp.apply(req.params.id, req.user);
        logEvent('bizbox_import_applied', req, { target: req.params.id });
        return res.json({ success: true, ...out });
    } catch (err) { return handle(res, err); }
};

const cancel = async (req, res) => {
    try { return res.json({ success: true, ...(await imp.cancel(req.params.id)) }); }
    catch (err) { return handle(res, err); }
};

const report = async (req, res) => {
    try {
        const { file, csv } = await imp.reportCsv(req.params.id);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
        return res.send('﻿' + csv);
    } catch (err) { return handle(res, err); }
};

const exclusions = async (req, res) => {
    try { return res.json({ success: true, exclusions: await imp.exclusions() }); }
    catch (err) { return handle(res, err); }
};
const forgetExclusion = async (req, res) => {
    try { return res.json({ success: true, removed: await imp.forgetExclusion(req.params.key) }); }
    catch (err) { return handle(res, err); }
};

module.exports = { upload, analyze, list, get, decisions, apply, cancel, report, exclusions, forgetExclusion };
