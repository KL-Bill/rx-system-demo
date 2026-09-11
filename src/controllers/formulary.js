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

// ----- supplies -----
const wrap = (fn) => async (req, res) => {
    try { return res.json({ success: true, ...(await fn(req)) }); }
    catch (err) { return handle(res, err); }
};
const supplySearch = wrap((req) => formulary.supplySearch(req.query));
const supplyGet = wrap(async (req) => ({ supply: await formulary.supplyGet(req.params.id) }));
const supplyUpdate = wrap(async (req) => ({ supply: await formulary.supplyUpdate(req.params.id, req.body || {}, req.user) }));
const supplyMerge = wrap(async (req) => ({ supply: await formulary.supplyMerge(req.params.id, (req.body || {}).intoId, req.user) }));
const supplyRestore = wrap(async (req) => ({ supply: await formulary.supplyRestore(req.params.id, req.user) }));
const supplyAdd = wrap((req) => formulary.supplyAdd(req.body || {}, req.user));

module.exports = {
    search, get, update, merge, restore, add, similar,
    supplySearch, supplyGet, supplyUpdate, supplyMerge, supplyRestore, supplyAdd,
};
