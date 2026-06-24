const db = require('../_db/db_functions');

const httpError = (status, message) => Object.assign(new Error(message), { status });

const listStations = () => db.getStations();
const listDoctors = () => db.getDoctors();
const getCatalog = () => ({ generics: db.getGenerics(), combos: db.getCombos() });

// items: [{ genericName, brandName, formName, strength, quantity, outOfStock }]
const createRx = ({ stationId, patient, address, age, sex, doctor, items }) => {
    const station = db.getStation(stationId);
    if (!station) throw httpError(400, 'Unknown station');
    if (!Array.isArray(items) || items.length === 0) throw httpError(400, 'No medicines on the prescription');

    const resolved = items.map((raw) => {
        const genericName = (raw.genericName || '').trim();
        const brandName = (raw.brandName || '').trim();
        const formName = (raw.formName || '').trim();
        const strength = (raw.strength || '').trim();
        if (!genericName) throw httpError(400, 'A medicine is missing a generic name');

        const inFormulary = db.comboExists({ generic: genericName, brand: brandName, form: formName, strength });
        // mutually exclusive: not-in-formulary wins; else the nurse's stock toggle; else normal
        const reason = !inFormulary ? 'not_in_formulary' : (raw.outOfStock ? 'out_of_stock' : 'normal');

        return { genericName, brandName, formName, strength, quantity: Number(raw.quantity) || 1, reason };
    });

    const doc = doctor || {};
    db.addPrescription({
        stationId,
        department: station.department,
        doctor: { name: (doc.name || '').trim(), license: (doc.license || '').trim(), ptr: (doc.ptr || '').trim(), s2: (doc.s2 || '').trim() },
        patient: patient || '', address: address || '', age: age || '', sex: sex || '',
        items: resolved,
    });

    return { station, items: resolved };
};

module.exports = { listStations, listDoctors, getCatalog, createRx };
