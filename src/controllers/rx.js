const rxModel = require('../models/rx');

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
const catalog = async (req, res) => {
    try { return res.json({ success: true, ...(await rxModel.getCatalog()) }); }
    catch (err) { return handle(res, err); }
};

const create = async (req, res) => {
    try {
        const result = await rxModel.createRx(req.body);
        return res.status(201).json({ success: true, ...result });
    } catch (err) {
        return handle(res, err);
    }
};

module.exports = { stations, doctors, catalog, create };
