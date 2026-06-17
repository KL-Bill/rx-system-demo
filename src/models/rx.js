const db = require('../_db/db_functions');

const httpError = (status, message) => Object.assign(new Error(message), { status });

const shapeMed = (m) => ({
    id: m.id,
    name: m.name,
    strength: m.strength,
    form: m.form,
    stock: m.stock,
    inDatabase: m.inDatabase,
    status: m.status,
});

const listStations = () => db.getStations();

const searchMeds = (q) => db.searchMeds(q).map(shapeMed);

// items: [{ medId?, name, strength?, form?, quantity }]
const createRx = ({ stationId, patient, prescriber, items }) => {
    const station = db.getStation(stationId);
    if (!station) throw httpError(400, 'Unknown station');
    if (!Array.isArray(items) || items.length === 0) throw httpError(400, 'No medicines on the prescription');

    const resolved = items.map((raw) => {
        const qty = Number(raw.quantity) || 1;
        let med = raw.medId ? db.getMed(raw.medId) : db.findMedByName(raw.name || '');
        let isNew = false;

        if (!med) {
            if (!raw.name) throw httpError(400, 'A medicine is missing a name');
            // nurse prescribed something not in the database -> queue it for pharmacy review
            med = db.addPendingMed({ name: raw.name, strength: raw.strength, form: raw.form });
            isNew = true;
        }

        const inStock = med.inDatabase && med.stock != null && med.stock >= qty;
        return { med, qty, inStock, isNew };
    });

    const rx = db.addRxRecord({
        stationId,
        department: station.department,
        patient: patient || '',
        prescriber: prescriber || '',
    });

    const printItems = resolved.map(({ med, qty, inStock, isNew }) => {
        db.addRxItem({
            rxId: rx.id,
            medId: med.id,
            medName: med.name,
            quantity: qty,
            stationId,
            department: station.department,
            inStock,
            inDatabase: med.inDatabase,
        });
        return {
            name: med.name,
            strength: med.strength,
            form: med.form,
            quantity: qty,
            inStock,
            inDatabase: med.inDatabase,
            isNew,
        };
    });

    return { rx, station, items: printItems };
};

module.exports = { listStations, searchMeds, createRx };
