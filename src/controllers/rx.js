const rxModel = require('../models/rx');
const { logEvent } = require('../models/syslog');

const handle = (res, err) => {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
};

const stations = async (req, res) => {
    try { return res.json({ success: true, stations: await rxModel.listStations() }); }
    catch (err) { return handle(res, err); }
};
const doctors = async (req, res) => {
    try { return res.json({ success: true, doctors: await rxModel.listDoctors() }); }
    catch (err) { return handle(res, err); }
};
// query params arrive as strings (or arrays, on a repeated key) — flatten and
// cap them before they reach a query
const str = (v) => String(Array.isArray(v) ? v[0] : (v ?? '')).slice(0, 100);

const suggest = async (req, res) => {
    try {
        const q = req.query;
        return res.json({
            success: true,
            ...(await rxModel.suggest(str(q.field), {
                q: str(q.q), generic: str(q.generic), brand: str(q.brand), form: str(q.form),
            })),
        });
    } catch (err) { return handle(res, err); }
};
const product = async (req, res) => {
    try {
        const q = req.query;
        return res.json({
            success: true,
            ...(await rxModel.getProduct({
                generic: str(q.generic), brand: str(q.brand), form: str(q.form), strength: str(q.strength),
            })),
        });
    } catch (err) { return handle(res, err); }
};

const create = async (req, res) => {
    try {
        const result = await rxModel.createRx(req.body);
        // station/department/med counts only — patient details stay out of the system log
        logEvent('rx_created', req, {
            target: `${result.station.name} · ${result.station.department}`,
            details: {
                meds: result.items.length,
                flagged: result.items.filter((i) => i.reason !== 'normal').length,
            },
        });
        return res.status(201).json({ success: true, ...result });
    } catch (err) {
        return handle(res, err);
    }
};

module.exports = { stations, doctors, suggest, product, create };
