const pharmacy = require('../models/pharmacy');

const handle = (res, err) => {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
};

const review = (req, res) => {
    try {
        return res.json({ success: true, queue: pharmacy.getReviewQueue({ stationId: req.query.station }) });
    } catch (err) {
        return handle(res, err);
    }
};

const confirm = async (req, res) => {
    try {
        const { authorizerPassword, ...edits } = req.body;
        const med = await pharmacy.confirmMed(req.params.id, edits, req.user, authorizerPassword);
        return res.json({ success: true, med });
    } catch (err) {
        return handle(res, err);
    }
};

const edit = async (req, res) => {
    try {
        const { authorizerPassword, ...edits } = req.body;
        const med = await pharmacy.editMed(req.params.id, edits, req.user, authorizerPassword);
        return res.json({ success: true, med });
    } catch (err) {
        return handle(res, err);
    }
};

const audit = (req, res) => {
    try {
        return res.json({ success: true, audit: pharmacy.getAudit() });
    } catch (err) {
        return handle(res, err);
    }
};

module.exports = { review, confirm, edit, audit };
