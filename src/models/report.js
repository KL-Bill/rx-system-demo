const db = require('../_db/db_functions');

const LOW_STOCK = 15;

// A demand & supply report: every medicine prescribed in the period (and station),
// with how often, how much, how much went unmet, fulfillment %, and the priority score.
const build = ({ stationId, from, to } = {}) => {
    const items = db.getRxItems({ stationId, from, to });
    const records = db.getRxRecords({ stationId, from, to });

    const agg = new Map();
    for (const it of items) {
        let r = agg.get(it.medId);
        if (!r) {
            const med = db.getMed(it.medId) || {};
            r = {
                id: it.medId,
                name: it.medName,
                strength: med.strength || '',
                form: med.form || '',
                inDatabase: it.inDatabase,
                stock: med.stock ?? null,
                demand: 0, qty: 0, unmet: 0,
            };
            agg.set(it.medId, r);
        }
        r.demand += 1;
        r.qty += it.quantity;
        if (!it.inStock) r.unmet += 1;
    }

    const rows = [...agg.values()]
        .map((r) => ({
            ...r,
            fulfillment: r.demand ? Math.round(((r.demand - r.unmet) / r.demand) * 100) : 100,
            score: r.demand + r.unmet * 2,
        }))
        .sort((a, b) => b.score - a.score);

    return {
        generatedAt: Date.now(),
        scope: stationId ? db.getStation(stationId) : null,
        period: { from: from ?? null, to: to ?? null },
        summary: {
            prescriptions: records.length,
            items: items.length,
            totalQty: items.reduce((s, i) => s + i.quantity, 0),
            distinctMeds: rows.length,
            notInDbCount: rows.filter((r) => !r.inDatabase).length,
            lowStockCount: rows.filter((r) => r.inDatabase && r.stock != null && r.stock <= LOW_STOCK).length,
        },
        rows,
    };
};

module.exports = { build };
