const db = require('../_db/db_functions');

const httpError = (status, message) => Object.assign(new Error(message), { status });

const listStations = () => db.getStations();
const listDoctors = () => db.getDoctors();
const getCatalog = async () => ({ combos: await db.getCombos() });

// items: [{ genericName, brandName, formName, strength, quantity, outOfStock }]
const createRx = async ({ stationId, patient, address, age, sex, doctor, items }) => {
    const station = await db.getStation(stationId);
    if (!station) throw httpError(400, 'Unknown station');
    if (!Array.isArray(items) || items.length === 0) throw httpError(400, 'No medicines on the prescription');

    const resolved = await Promise.all(items.map(async (raw) => {
        const genericName = (raw.genericName || '').trim();
        const brandName = (raw.brandName || '').trim();
        const formName = (raw.formName || '').trim();
        const strength = (raw.strength || '').trim();
        if (!genericName) throw httpError(400, 'A medicine is missing a generic name');

        // visible in the PNDF master list, but "new" when the hospital formulary lacks the product
        const inFormulary = await db.inHospitalFormulary({ generic: genericName, brand: brandName, form: formName, strength });
        // mutually exclusive: not-in-formulary wins; else the nurse's stock toggle; else normal
        const reason = !inFormulary ? 'not_in_formulary' : (raw.outOfStock ? 'out_of_stock' : 'normal');
        const registrationNumber = await db.findRegistration({ generic: genericName, brand: brandName, form: formName, strength });
        const volumeMl = Number(raw.volumeMl) > 0 ? Number(raw.volumeMl) : null;   // liquids: total mL to dispense

        return { genericName, brandName, formName, strength, volumeMl, registrationNumber, quantity: Number(raw.quantity) || 1, reason };
    }));

    const doc = doctor || {};
    await db.addPrescription({
        stationId,
        department: station.department,
        doctor: { name: (doc.name || '').trim(), license: (doc.license || '').trim(), ptr: (doc.ptr || '').trim(), s2: (doc.s2 || '').trim() },
        patient: patient || '', address: address || '', age: age || '', sex: sex || '',
        items: resolved,
    });

    return { station, items: resolved };
};

module.exports = { listStations, listDoctors, getCatalog, createRx };
