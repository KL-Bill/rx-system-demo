const pharmacy = require('../models/pharmacy');

const handle = (res, err) => {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
};

const review = async (req, res) => {
    try { return res.json({ success: true, review: await pharmacy.getReview({ reason: req.query.reason, department: req.query.department }) }); }
    catch (err) { return handle(res, err); }
};

const detail = async (req, res) => {
    try { return res.json({ success: true, detail: await pharmacy.getDetail(req.query.key, req.query.reason) }); }
    catch (err) { return handle(res, err); }
};

const status = async (req, res) => {
    try {
        const { key, reason, action, drug, authorizerPassword } = req.body;
        const detail = await pharmacy.setStatus(key, reason, action, drug, req.user, authorizerPassword);
        return res.json({ success: true, detail });
    } catch (err) { return handle(res, err); }
};

const statusBulk = async (req, res) => {
    try {
        const { drugs, action, authorizerPassword } = req.body;
        const out = await pharmacy.setStatusBulk(drugs, action, req.user, authorizerPassword);
        return res.json({ success: true, ...out });
    } catch (err) { return handle(res, err); }
};

const prescriptions = async (req, res) => {
    try {
        const { from, to, department, reason, q } = req.query;
        return res.json({
            success: true,
            prescriptions: await pharmacy.listPrescriptions({
                department, reason, q,
                from: from ? new Date(from + 'T00:00:00').getTime() : undefined,
                to: to ? new Date(to + 'T23:59:59').getTime() : undefined,
            }),
        });
    } catch (err) { return handle(res, err); }
};

const audit = async (req, res) => {
    try { return res.json({ success: true, audit: await pharmacy.getAudit() }); }
    catch (err) { return handle(res, err); }
};

const remarks = async (req, res) => {
    try { return res.json({ success: true, presets: pharmacy.REMARKS, remarks: await pharmacy.listRemarks(req.query.key, req.query.reason) }); }
    catch (err) { return handle(res, err); }
};

const addRemark = async (req, res) => {
    try {
        const { authorizerPassword, ...body } = req.body;
        return res.json({ success: true, ...(await pharmacy.addRemark(body, req.user, authorizerPassword)) });
    } catch (err) { return handle(res, err); }
};

const similar = async (req, res) => {
    try { return res.json({ success: true, products: await pharmacy.similarProducts({ generic: req.query.generic, brand: req.query.brand }) }); }
    catch (err) { return handle(res, err); }
};

const addCatalog = async (req, res) => {
    try { return res.json({ success: true, ...(await pharmacy.addCatalogProduct(req.body, req.user)) }); }
    catch (err) { return handle(res, err); }
};

module.exports = { review, detail, status, statusBulk, audit, prescriptions, remarks, addRemark, similar, addCatalog };
