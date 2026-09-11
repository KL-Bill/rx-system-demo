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

module.exports = { search, get, update, merge, restore, add, similar };
