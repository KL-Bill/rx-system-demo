const report = require('../models/report');

const get = (req, res) => {
    try {
        const { station, from, to } = req.query;
        const data = report.build({
            stationId: station || undefined,
            from: from ? new Date(from + 'T00:00:00').getTime() : undefined,
            to: to ? new Date(to + 'T23:59:59').getTime() : undefined,
        });
        return res.json({ success: true, data });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

module.exports = { get };
