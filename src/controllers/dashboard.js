const dashboard = require('../models/dashboard');

const get = (req, res) => {
    try {
        return res.json({ success: true, data: dashboard.compute({ stationId: req.query.station }) });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

module.exports = { get };
