// The RX Formulary page: browse the app's own medicine list, fix a row,
// merge a duplicate, add one by hand. Shared by the pharmacy head and IT.
// (Bizbox is the hospital's main system; the RX Formulary is this list.)
const db = require('../_db/db_functions');
const pharmacy = require('./pharmacy');

const httpError = (status, message) => Object.assign(new Error(message), { status });
const clean = (x) => String(x || '').replace(/\s+/g, ' ').trim();

const search = ({ q, bizbox, brand, limit, offset }) => db.searchCatalog({ q, bizbox, brand, limit, offset });

const get = async (id) => {
    const row = await db.getCatalogRow(Number(id));
    if (!row) throw httpError(404, 'Medicine not found');
    return row;
};

const update = async (id, body, actor) => {
    id = Number(id);
    const before = await db.getCatalogRow(id);
    if (!before) throw httpError(404, 'Medicine not found');
    const patch = {
        genericName: clean(body.generic), brandName: clean(body.brand), formName: clean(body.form), strength: clean(body.strength),
        description: clean(body.description), registrationNumber: clean(body.registrationNumber) || null,
        volumeMl: Number(body.volumeMl) > 0 ? Number(body.volumeMl) : null,
        ihf: body.inFormulary === undefined ? before.inFormulary : !!body.inFormulary,
    };
    if (!patch.genericName) throw httpError(400, 'Generic is required');
    if (!patch.formName && !patch.strength) throw httpError(400, 'Enter at least the form or the strength');
    const { conflict } = await db.updateCatalogRow(id, patch);
    if (conflict) {
        const other = await db.getCatalogRow(conflict);
        const err = httpError(409, 'An entry with exactly these details already exists.');
        err.existing = other;
        throw err;
    }
    await db.addAudit({
        action: 'catalog_edit', drug: `${before.generic} — ${before.description}`, reason: null,
        status: `-> ${patch.genericName} — ${patch.description || [patch.brandName, patch.strength, patch.formName].filter(Boolean).join(' ')}${patch.ihf !== before.inFormulary ? (patch.ihf ? ' (marked In Bizbox)' : ' (unmarked)') : ''}`,
        actor: actor.name, authorizedBy: actor.name,
    });
    return db.getCatalogRow(id);
};

const restore = async (id, actor) => {
    const row = await db.getCatalogRow(Number(id));
    if (!row) throw httpError(404, 'Medicine not found');
    if (row.deletedAt == null) return row;
    await db.restoreCatalogRow(Number(id));
    await db.addAudit({ action: 'catalog_restore', drug: `${row.generic} — ${row.description}`, reason: null, status: 'restored', actor: actor.name, authorizedBy: actor.name });
    return db.getCatalogRow(Number(id));
};

const merge = async (fromId, intoId, actor) => {
    fromId = Number(fromId); intoId = Number(intoId);
    if (!fromId || !intoId || fromId === intoId) throw httpError(400, 'Pick two different entries');
    const from = await db.getCatalogRow(fromId), into = await db.getCatalogRow(intoId);
    if (!from || !into) throw httpError(404, 'Medicine not found');
    await db.mergeCatalogRows(fromId, intoId);
    await db.addAudit({
        action: 'catalog_merge', drug: `${from.generic} — ${from.description}`, reason: null,
        status: `merged into ${into.generic} — ${into.description}`, actor: actor.name, authorizedBy: actor.name,
    });
    return db.getCatalogRow(intoId);
};

// same rules as the pharmacy's Add Medicine, reachable by IT too
const add = (body, actor) => pharmacy.addCatalogProduct(body, actor);
const similar = (q) => pharmacy.similarProducts(q);

// ----- medical supplies: the same page, a flat list -----
const supplySearch = ({ q, bizbox, limit, offset }) => db.listSuppliesPage({ q, bizbox, limit, offset });

const supplyGet = async (id) => {
    const row = await db.getSupply(Number(id));
    if (!row) throw httpError(404, 'Supply not found');
    return row;
};

const supplyUpdate = async (id, body, actor) => {
    const before = await supplyGet(id);
    const patch = {
        code: clean(body.code) || null, description: clean(body.description).slice(0, 200),
        ihf: body.inBizbox === undefined ? before.inBizbox : !!body.inBizbox,
    };
    if (!patch.description) throw httpError(400, 'Enter the supply');
    const { conflict } = await db.updateSupply(before.id, patch);
    if (conflict) {
        const err = httpError(409, 'A supply with this code or wording already exists.');
        err.existing = await db.getSupply(conflict);
        throw err;
    }
    await db.addAudit({
        action: 'catalog_edit', drug: `Supply — ${before.description}`, reason: null,
        status: `-> ${patch.description}${patch.code ? ` (${patch.code})` : ''}${patch.ihf !== before.inBizbox ? (patch.ihf ? ' (marked In Bizbox)' : ' (unmarked)') : ''}`,
        actor: actor.name, authorizedBy: actor.name,
    });
    return db.getSupply(before.id);
};

const supplyMerge = async (fromId, intoId, actor) => {
    fromId = Number(fromId); intoId = Number(intoId);
    if (!fromId || !intoId || fromId === intoId) throw httpError(400, 'Pick two different entries');
    const from = await db.getSupply(fromId), into = await db.getSupply(intoId);
    if (!from || !into) throw httpError(404, 'Supply not found');
    await db.mergeSupplies(fromId, intoId);
    await db.addAudit({
        action: 'catalog_merge', drug: `Supply — ${from.description}`, reason: null,
        status: `merged into ${into.description}`, actor: actor.name, authorizedBy: actor.name,
    });
    return db.getSupply(intoId);
};

const supplyRestore = async (id, actor) => {
    const row = await supplyGet(id);
    if (row.deletedAt == null) return row;
    // a live row with the same wording would make two of one supply
    const live = await db.findSupply({ description: row.description, code: row.code });
    if (live && live.id !== row.id) throw httpError(409, `"${live.description}" is already in the list. Edit that one instead.`);
    await db.restoreSupply(row.id);
    await db.addAudit({ action: 'catalog_restore', drug: `Supply — ${row.description}`, reason: null, status: 'restored', actor: actor.name, authorizedBy: actor.name });
    return db.getSupply(row.id);
};

const supplyAdd = (body, actor) => pharmacy.addCatalogSupply(body, actor);

module.exports = {
    search, get, update, merge, restore, add, similar,
    supplySearch, supplyGet, supplyUpdate, supplyMerge, supplyRestore, supplyAdd,
};
