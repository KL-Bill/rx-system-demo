const db = require('../_db/db_functions');

const LOW_STOCK = 15; // units at or below this are flagged low

const baseRow = (m) => ({
    id: m.id,
    name: m.name,
    strength: m.strength || '',
    form: m.form || '',
    stock: m.stock,
    inDatabase: m.inDatabase,
    demand: 0,   // times prescribed
    qty: 0,      // total quantity prescribed
    unmet: 0,    // times prescribed while NOT in stock
    unmetQty: 0,
});

const scoreRow = (r) => {
    // fulfillment = share of prescriptions we could actually serve from stock
    const fulfillment = r.demand ? Math.round(((r.demand - r.unmet) / r.demand) * 100) : 100;
    // priority score: raw demand, with unmet demand weighted heavier (we keep failing those)
    const score = r.demand + r.unmet * 2;
    return { ...r, fulfillment, score };
};

const stationBreakdown = () =>
    db.getStations().map((s) => {
        const items = db.getRxItems({ stationId: s.id });
        return {
            id: s.id,
            name: s.name,
            department: s.department,
            items: items.length,
            notInDbDemand: items.filter((i) => !i.inDatabase).length,
        };
    });

const compute = ({ stationId } = {}) => {
    const items = db.getRxItems({ stationId });
    const records = db.getRxRecords({ stationId });
    const meds = db.getAllMeds();

    const agg = new Map();
    for (const m of meds) agg.set(m.id, baseRow(m));

    for (const it of items) {
        let row = agg.get(it.medId);
        if (!row) {
            row = baseRow({ id: it.medId, name: it.medName, inDatabase: it.inDatabase, stock: null });
            agg.set(it.medId, row);
        }
        row.demand += 1;
        row.qty += it.quantity;
        if (!it.inStock) {
            row.unmet += 1;
            row.unmetQty += it.quantity;
        }
    }

    const rows = [...agg.values()].map(scoreRow);

    const mostInDemandNotInDb = rows
        .filter((r) => !r.inDatabase && r.demand > 0)
        .sort((a, b) => b.score - a.score);

    const lowStock = rows
        .filter((r) => r.inDatabase && r.stock != null && r.stock <= LOW_STOCK)
        .sort((a, b) => a.stock - b.stock);

    const priority = rows
        .filter((r) => r.demand > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);

    return {
        scope: stationId ? db.getStation(stationId) : null,
        totals: {
            prescriptions: records.length,
            itemsPrescribed: items.length,
            pendingReview: mostInDemandNotInDb.length,
            lowStockCount: lowStock.length,
        },
        mostInDemandNotInDb,
        lowStock,
        priority,
        stations: stationBreakdown(),
    };
};

module.exports = { compute };
