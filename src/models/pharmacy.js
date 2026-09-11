const db = require('../_db/db_functions');
const demand = require('./demand');
const { verifyAuthorizer } = require('./auth');

const httpError = (status, message) => Object.assign(new Error(message), { status });

// admins act with their own session; staff must supply an admin password
const authorizeMutation = async (actor, authorizerPassword) => {
    if (actor.role === 'admin') return actor;
    const admin = await verifyAuthorizer(authorizerPassword);
    if (!admin) throw httpError(403, 'This change must be authorized by an admin password.');
    return admin;
};

// from/to: the Review page's Period — only prescriptions written in it are counted
const getReview = ({ reason, department, from, to } = {}) => demand.aggregate({ reason, department, from, to });

// full prescription log for auditing (newest first)
const listPrescriptions = async ({ from, to, department, reason, q } = {}) => {
    const needle = (q || '').trim().toLowerCase();
    return (await db.getPrescriptions())
        .filter((rx) => {
            if (from != null && rx.createdAt < from) return false;
            if (to != null && rx.createdAt > to) return false;
            if (department && department !== 'all' && rx.department !== department) return false;
            if (reason && reason !== 'all' && !rx.items.some((i) => i.reason === reason)) return false;
            if (needle) {
                const hay = [rx.patient, rx.doctor && rx.doctor.name, rx.department,
                    ...rx.items.map((i) => `${i.genericName} ${i.brandName}`)].join(' ').toLowerCase();
                if (!hay.includes(needle)) return false;
            }
            return true;
        })
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt);
};
const getDetail = (key, reason) => demand.detail(key, reason);
const getAudit = () => db.getAudit();

const VALID = {
    not_in_formulary: ['under_therapeutics', 'added_to_formulary'],
    out_of_stock: ['restocked'],
};

const setStatus = async (key, reason, action, drug, actor, authorizerPassword) => {
    if (!VALID[reason] || !VALID[reason].includes(action)) throw httpError(400, 'Invalid status action for this reason');
    const authorizedBy = await authorizeMutation(actor, authorizerPassword);

    await db.setStatus(reason, key, { status: action, statusDate: Date.now(), actor: actor.name, authorizedBy: authorizedBy.name });

    // adding to Bizbox flips the product's ihf flag in the merged catalog
    if (action === 'added_to_formulary' && drug) {
        await db.addToCatalog({ genericName: drug.generic, brandName: drug.brand, formName: drug.form, strength: drug.strength });
    }

    await db.addAudit({ action: 'review_status', drug: drug && drug.label, reason, status: action, actor: actor.name, authorizedBy: authorizedBy.name });
    return demand.detail(key, reason);
};

// apply one action to many selected drugs (authorized once)
const setStatusBulk = async (drugs, action, actor, authorizerPassword) => {
    if (!Array.isArray(drugs) || !drugs.length) throw httpError(400, 'Nothing selected');
    for (const d of drugs) {
        if (!VALID[d.reason] || !VALID[d.reason].includes(action)) {
            throw httpError(400, `"${action}" is not valid for ${d.reason.replace(/_/g, ' ')}`);
        }
    }
    const authorizedBy = await authorizeMutation(actor, authorizerPassword);

    for (const d of drugs) {
        await db.setStatus(d.reason, d.key, { status: action, statusDate: Date.now(), actor: actor.name, authorizedBy: authorizedBy.name });
        if (action === 'added_to_formulary') {
            await db.addToCatalog({ genericName: d.generic, brandName: d.brand, formName: d.form, strength: d.strength });
        }
        await db.addAudit({ action: 'review_status', drug: d.label, reason: d.reason, status: action, actor: actor.name, authorizedBy: authorizedBy.name });
    }
    return { updated: drugs.length };
};

// ----- remarks -----
// Why a reviewed drug is still open, or how it was closed. Presets so the
// audit can be filtered; the note carries the specifics. Every preset but one
// is an annotation only. "Available in Bizbox" says the medicine should never
// have been prescribed here — so it also resolves the row the way "Mark Added
// to Bizbox" does, with the product the reviewer confirmed in the stepper.
const REMARKS = {
    available_in_bizbox: 'Available in Bizbox',
    ordered: 'Ordered',
    for_order: 'For Order',
    other_brand_only: 'Only other brand available',
    under_therapeutics: 'Under Therapeutics review',
    other: 'Other',
};

const listRemarks = (key, reason) => db.getRemarks(reason, key);

const cleanProduct = (p = {}) => ({
    genericName: String(p.generic || '').trim(),
    brandName: String(p.brand || '').trim(),
    formName: String(p.form || '').trim(),
    strength: String(p.strength || '').trim(),
    description: String(p.description || '').replace(/\s+/g, ' ').trim() || undefined,
    registrationNumber: String(p.registrationNumber || '').trim() || undefined,
    volumeMl: Number(p.volumeMl) > 0 ? Number(p.volumeMl) : undefined,
});

const addRemark = async ({ key, reason, remark, note, drug, resolve }, actor, authorizerPassword) => {
    if (!key || !reason) throw httpError(400, 'Missing drug');
    if (!REMARKS[remark]) throw httpError(400, 'Unknown remark');
    note = String(note || '').trim().slice(0, 500);
    const authorizedBy = await authorizeMutation(actor, authorizerPassword);

    let resolvedStatus = null;
    if (remark === 'available_in_bizbox') {
        if (reason === 'not_in_formulary') {
            const product = cleanProduct(resolve);
            if (!product.genericName) throw httpError(400, 'Confirm the medicine to add to Bizbox first');
            await db.addToCatalog(product);
            resolvedStatus = 'added_to_formulary';
        } else if (reason === 'out_of_stock') {
            resolvedStatus = 'restocked';
        }
        // an in-stock anomaly has no status to move; the remark alone records it
        if (resolvedStatus) {
            await db.setStatus(reason, key, { status: resolvedStatus, statusDate: Date.now(), actor: actor.name, authorizedBy: authorizedBy.name });
            await db.addAudit({ action: 'review_status', drug: drug && drug.label, reason, status: resolvedStatus, actor: actor.name, authorizedBy: authorizedBy.name });
        }
    }

    const rec = await db.addRemark({ reason, drugKey: key, remark, note, actor: actor.name, authorizedBy: authorizedBy.name });
    await db.addAudit({ action: 'remark', drug: drug && drug.label, reason, status: remark + (note ? `: ${note}` : ''), actor: actor.name, authorizedBy: authorizedBy.name });
    return { remark: rec, resolvedStatus, detail: await demand.detail(key, reason) };
};

// ----- catalog (admin) -----
const similarProducts = ({ generic, brand }) => {
    if (!String(generic || '').trim()) return [];
    return db.findSimilarProducts({ generic, brand: brand || '' });
};

// Add one product to Bizbox by hand — when Bizbox gained a medicine and the
// system still says "not in Bizbox". If the same product is being tracked in
// review, the caller is told first (needsConfirm) and, on confirm, those rows
// are resolved as Added to Bizbox — the medicine is in Bizbox now, so the
// question the review asked is answered.
const addCatalogProduct = async (body, actor) => {
    const product = cleanProduct(body);
    if (!product.genericName) throw httpError(400, 'Generic is required');
    if (!product.formName && !product.strength) throw httpError(400, 'Enter at least the form or the strength');

    const existing = await db.findProduct({ generic: product.genericName, brand: product.brandName, form: product.formName, strength: product.strength });
    if (existing && existing.inFormulary) throw httpError(409, 'This exact medicine is already in Bizbox.');

    const key = db.drugKey(product);
    const tracked = (await demand.aggregate({ reason: 'all' })).filter((r) => r.key === key && !r.resolved && r.reason !== 'normal');
    if (tracked.length && !body.confirm) {
        return {
            needsConfirm: true,
            matches: tracked.map((r) => ({ reason: r.reason, label: r.label, description: r.description, prescriptions: r.prescriptions, status: r.status })),
        };
    }

    await db.addToCatalog(product);
    let resolved = 0;
    for (const r of tracked) {
        if (r.reason !== 'not_in_formulary') continue;
        await db.setStatus(r.reason, r.key, { status: 'added_to_formulary', statusDate: Date.now(), actor: actor.name, authorizedBy: actor.name });
        await db.addAudit({ action: 'review_status', drug: r.label, reason: r.reason, status: 'added_to_formulary', actor: actor.name, authorizedBy: actor.name });
        resolved += 1;
    }
    const label = demand.labelOf(product);
    await db.addAudit({ action: 'catalog_add', drug: label, reason: null, status: existing ? 'flagged' : 'created', actor: actor.name, authorizedBy: actor.name });
    return { added: true, created: !existing, resolved, label };
};

module.exports = {
    getReview, getDetail, setStatus, setStatusBulk, getAudit, listPrescriptions,
    REMARKS, listRemarks, addRemark, similarProducts, addCatalogProduct,
};
