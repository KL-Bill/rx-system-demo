const formulary = require('../models/formulary');

const handle = (res, err) => {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message, existing: err.existing });
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
};

const search = async (req, res) => {
    try {
        const { q, bizbox, brand, limit, offset } = req.query;
        return res.json({ success: true, ...(await formulary.search({ q, bizbox, brand, limit, offset })) });
    } catch (err) { return handle(res, err); }
};
const get = async (req, res) => {
    try { return res.json({ success: true, medicine: await formulary.get(req.params.id) }); }
    catch (err) { return handle(res, err); }
};
const update = async (req, res) => {
    try { return res.json({ success: true, medicine: await formulary.update(req.params.id, req.body || {}, req.user) }); }
    catch (err) { return handle(res, err); }
};
const merge = async (req, res) => {
    try { return res.json({ success: true, medicine: await formulary.merge(req.params.id, req.body.intoId, req.user) }); }
    catch (err) { return handle(res, err); }
};
const restore = async (req, res) => {
    try { return res.json({ success: true, medicine: await formulary.restore(req.params.id, req.user) }); }
    catch (err) { return handle(res, err); }
};
const add = async (req, res) => {
    try { return res.json({ success: true, ...(await formulary.add(req.body || {}, req.user)) }); }
    catch (err) { return handle(res, err); }
};
const similar = async (req, res) => {
    try { return res.json({ success: true, products: await formulary.similar({ generic: req.query.generic, brand: req.query.brand }) }); }
    catch (err) { return handle(res, err); }
};

module.exports = { search, get, update, merge, restore, add, similar };
