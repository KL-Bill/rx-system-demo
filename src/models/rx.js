const db = require('../_db/db_functions');

const httpError = (status, message) => Object.assign(new Error(message), { status });

const listStations = () => db.getStations();
const listDoctors = () => db.getDoctors();

// ----- medicine picker -----
// combo = the Brand/Form/Strength box: one search over the product description
const FIELDS = ['generic', 'brand', 'form', 'strength', 'combo'];

// one cascade step: the values available for `field`, given what is already picked
const suggest = async (field, sel) => {
    if (!FIELDS.includes(field)) throw httpError(400, 'Unknown field');
    return { options: await db.suggestOptions(field, sel) };
};

// the catalog's form names — the nurse's Form dropdown and the splitter's dictionary
const forms = async () => ({ forms: await db.getFormNames() });

// the exact generic+brand+form+strength product, or null when Bizbox has no
// such row — what decides "in Bizbox" for the nurse's status line
const getProduct = async ({ generic, brand, form, strength }) => {
    if (!String(generic || '').trim()) return { product: null };
    return { product: await db.findProduct({ generic, brand, form, strength }) };
};

const stitch = (brand, strength, form) => [brand, strength, form].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

// items: [{ genericName, brandName, formName, strength, description, quantity, outOfStock }]
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

        // One lookup, two answers. These used to be separate inHospitalFormulary()
        // and findRegistration() calls that each ran the same query — two pool
        // checkouts per item, and Promise.all fans that out over every item at
        // once, so a six-medicine Rx asked for twelve of the pool's ten clients
        // and queued against itself.
        const product = await db.findProduct({ generic: genericName, brand: brandName, form: formName, strength });
        // visible in the PNDF master list, but "new" when Bizbox lacks the product
        const inFormulary = !!(product && product.inFormulary);
        // mutually exclusive: not-in-Bizbox wins; else the nurse's stock toggle; else normal
        const reason = !inFormulary ? 'not_in_formulary' : (raw.outOfStock ? 'out_of_stock' : 'normal');
        const registrationNumber = (product && product.registrationNumber) || null;
        const volumeMl = Number(raw.volumeMl) > 0 ? Number(raw.volumeMl) : null;   // liquids: total mL to dispense
        // free text, exactly as the doctor wrote it ("1 tab TID for pain").
        // Deliberately absent from db.drugKey() — the same medicine with two
        // different instructions is still one medicine for demand and review.
        const sig = String(raw.sig || '').trim().slice(0, 300);
        // the Brand/Form/Strength wording: Bizbox's own when the product is
        // known, else what the nurse saw, else the parts stitched. Display
        // only — brand/form/strength above stay the fields that identify it.
        const description = ((product && product.description) || String(raw.description || '').replace(/\s+/g, ' ').trim()
            || stitch(brandName, strength, formName)).slice(0, 200);

        return { genericName, brandName, formName, strength, description, volumeMl, registrationNumber, quantity: Number(raw.quantity) || 1, sig, reason };
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

module.exports = { listStations, listDoctors, suggest, forms, getProduct, createRx };
