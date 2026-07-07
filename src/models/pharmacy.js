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
const getDetail = (key, reason) => demand.detail(key, reason);
const getAudit = () => db.getAudit();

const VALID = {
    not_in_formulary: ['under_therapeutics', 'added_to_formulary'],
    out_of_stock: ['restocked'],
};

const setStatus = async (key, reason, action, drug, actor, authorizerPassword) => {
    if (!VALID[reason] || !VALID[reason].includes(action)) throw httpError(400, 'Invalid status action for this reason');
    const authorizedBy = await authorizeMutation(actor, authorizerPassword);

    db.setStatus(reason, key, { status: action, statusDate: Date.now(), actor: actor.name, authorizedBy: authorizedBy.name });

    // adding to the Formulary flips the product's ihf flag in the merged catalog
    if (action === 'added_to_formulary' && drug) {
        db.addToCatalog({ genericName: drug.generic, brandName: drug.brand, formName: drug.form, strength: drug.strength });
    }

    db.addAudit({ action: 'review_status', drug: drug && drug.label, reason, status: action, actor: actor.name, authorizedBy: authorizedBy.name });
    return demand.detail(key, reason);
};

module.exports = { getReview, getDetail, setStatus, getAudit };
