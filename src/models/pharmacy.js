const db = require('../_db/db_functions');
const demand = require('./demand');
const { verifyAuthorizer } = require('./auth');

const httpError = (status, message) => Object.assign(new Error(message), { status });

// superadmin/subadmin act with their own session; staff must supply an admin password
const authorizeMutation = async (actor, authorizerPassword) => {
    if (actor.role === 'superadmin' || actor.role === 'subadmin') return actor;
    const admin = await verifyAuthorizer(authorizerPassword);
    if (!admin) throw httpError(403, 'This change must be authorized by a superadmin or subadmin password.');
    return admin;
};

const getReview = ({ reason, department } = {}) => demand.aggregate({ reason, department });

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

    // adding to the Formulary flips the product's ihf flag in the merged catalog
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

module.exports = { getReview, getDetail, setStatus, setStatusBulk, getAudit, listPrescriptions };
