const pharmacy = require('../models/pharmacy');

const handle = (res, err) => {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
};

const review = (req, res) => {
    try { return res.json({ success: true, review: pharmacy.getReview({ reason: req.query.reason, department: req.query.department }) }); }
    catch (err) { return handle(res, err); }
};

const detail = (req, res) => {
    try { return res.json({ success: true, detail: pharmacy.getDetail(req.query.key, req.query.reason) }); }
    catch (err) { return handle(res, err); }
};

const status = async (req, res) => {
    try {
        const { key, reason, action, drug, authorizerPassword } = req.body;
        const detail = await pharmacy.setStatus(key, reason, action, drug, req.user, authorizerPassword);
        return res.json({ success: true, detail });
    } catch (err) { return handle(res, err); }
};

const audit = (req, res) => {
    try { return res.json({ success: true, audit: pharmacy.getAudit() }); }
    catch (err) { return handle(res, err); }
};

module.exports = { review, detail, status, audit };
