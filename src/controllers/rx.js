const rxModel = require('../models/rx');

const stations = (req, res) =>
    res.json({ success: true, stations: rxModel.listStations() });

const meds = (req, res) =>
    res.json({ success: true, meds: rxModel.searchMeds(req.query.search) });

const create = (req, res) => {
    try {
        const result = rxModel.createRx(req.body);
        return res.status(201).json({ success: true, ...result });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ success: false, message: err.message });
        console.error(err);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

module.exports = { stations, meds, create };
