const db = require('../_db/db_functions');
const { verifyAuthorizer } = require('./auth');

const httpError = (status, message) => Object.assign(new Error(message), { status });

// superadmin/subadmin authorize with their own session.
// staff must supply a superadmin/subadmin password to mutate anything.
const authorizeMutation = async (actor, authorizerPassword) => {
    if (actor.role === 'superadmin' || actor.role === 'subadmin') return actor;
    const admin = await verifyAuthorizer(authorizerPassword);
    if (!admin) {
        throw httpError(403, 'This change must be authorized by a superadmin or subadmin password.');
    }
    return admin;
};

// pending meds (not in DB) with how much they're being demanded
const getReviewQueue = ({ stationId } = {}) => {
    const items = db.getRxItems({ stationId });
    return db.getAllMeds()
        .filter((m) => !m.inDatabase)
        .map((m) => {
            const events = items.filter((i) => i.medId === m.id);
            const departments = [...new Set(events.map((e) => e.department))];
            return {
                id: m.id,
                name: m.name,
                strength: m.strength,
                form: m.form,
                status: m.status,
                demand: events.length,
                totalQty: events.reduce((s, e) => s + e.quantity, 0),
                departments,
                lastRequested: events.reduce((max, e) => Math.max(max, e.createdAt), 0) || m.createdAt,
            };
        })
        .filter((m) => !stationId || m.demand > 0)
        .sort((a, b) => b.demand - a.demand);
};

const confirmMed = async (id, edits, actor, authorizerPassword) => {
    const med = db.getMed(id);
    if (!med) throw httpError(404, 'Medicine not found');

    const authorizedBy = await authorizeMutation(actor, authorizerPassword);

    const updated = db.updateMed(id, {
        name: edits.name ?? med.name,
        strength: edits.strength ?? med.strength,
        form: edits.form ?? med.form,
        unit: edits.form ?? med.form,
        stock: edits.stock != null ? Number(edits.stock) : (med.stock ?? 0),
        inDatabase: true,
        status: 'active',
    });

    db.addAudit({
        action: 'confirm_med',
        medId: id,
        medName: updated.name,
        actor: actor.name,
        authorizedBy: authorizedBy.name,
    });

    return updated;
};

const editMed = async (id, edits, actor, authorizerPassword) => {
    const med = db.getMed(id);
    if (!med) throw httpError(404, 'Medicine not found');

    const authorizedBy = await authorizeMutation(actor, authorizerPassword);

    const clean = {};
    for (const k of ['name', 'strength', 'form', 'stock']) {
        if (edits[k] != null && edits[k] !== '') clean[k] = edits[k];
    }
    if (clean.stock != null) clean.stock = Number(clean.stock);
    if (clean.form) clean.unit = clean.form;

    const updated = db.updateMed(id, clean);

    db.addAudit({
        action: 'edit_med',
        medId: id,
        medName: updated.name,
        actor: actor.name,
        authorizedBy: authorizedBy.name,
        changes: clean,
    });

    return updated;
};

const getAudit = () => db.getAudit();

module.exports = { getReviewQueue, confirmMed, editMed, getAudit };
