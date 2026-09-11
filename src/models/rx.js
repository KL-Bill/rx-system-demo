const crypto = require('crypto');
const db = require('../_db/db_functions');

const httpError = (status, message) => Object.assign(new Error(message), { status });

// ----- kiosk receipts -----
// The nurse page has no login, yet "Previous prescriptions" shows patient
// names. So a kiosk only ever sees what it printed itself: each save hands the
// kiosk an unguessable receipt for that one prescription (an HMAC of its id
// under the server secret), the kiosk keeps its receipts, and the history and
// reprint calls answer only for receipts they are shown. Another computer on
// the network has no receipts, so it gets nothing. No table: the receipt can
// always be recomputed from the id, so there is nothing to store or leak.
const SECRET = process.env.SECRET_KEY || 'demo-secret-key';
const receiptFor = (id) => crypto.createHmac('sha256', SECRET).update('rx-receipt:' + id).digest('base64url').slice(0, 32);
const receiptOk = (id, receipt) => {
    if (typeof id !== 'string' || typeof receipt !== 'string') return false;
    const want = Buffer.from(receiptFor(id));
    const got = Buffer.from(receipt);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
};
const MAX_RECEIPTS = 1000;          // what one kiosk may present at once
const MAX_RESULTS = 200;

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

// ----- supply picker -----
// the Supply box: gloves, catheters... searched by description or Bizbox code
const supplies = async (q) => ({ supplies: await db.searchSupplies({ q, limit: 30 }) });
// the exact supply, or null — the Bizbox answer for the nurse's status line
const getSupply = async ({ description, code }) => ({ supply: await db.findSupply({ description, code }) });

const stitch = (brand, strength, form) => [brand, strength, form].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

// A supply line follows the medicine rules: not in Bizbox wins, else the
// nurse's out-of-stock tick, else normal. It keeps the medicine field names —
// genericName carries the description, brand/form/strength stay blank — so
// the slip, the demand grouping and every report read it without a branch.
const resolveSupply = async (raw) => {
    const typed = String(raw.description || raw.genericName || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!typed) throw httpError(400, 'A supply is missing its description');
    const supply = await db.findSupply({ description: typed, code: String(raw.supplyCode || '').trim() || null });
    const inBizbox = !!(supply && supply.inBizbox);
    const reason = !inBizbox ? 'not_in_formulary' : (raw.outOfStock ? 'out_of_stock' : 'normal');
    const description = (supply && supply.description) || typed;
    return {
        kind: 'supply', supplyCode: (supply && supply.code) || null,
        genericName: description, brandName: '', formName: '', strength: '', description,
        volumeMl: null, registrationNumber: null,
        quantity: Number(raw.quantity) || 1, sig: String(raw.sig || '').trim().slice(0, 300), reason,
    };
};

// items: [{ genericName, brandName, formName, strength, description, quantity, outOfStock }]
const createRx = async ({ stationId, patient, address, age, sex, doctor, items }) => {
    const station = await db.getStation(stationId);
    if (!station) throw httpError(400, 'Unknown station');
    if (!Array.isArray(items) || items.length === 0) throw httpError(400, 'No medicines on the prescription');

    const resolved = await Promise.all(items.map(async (raw) => {
        if (raw.kind === 'supply') return resolveSupply(raw);
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
    const saved = await db.addPrescription({
        stationId,
        department: station.department,
        doctor: { name: (doc.name || '').trim(), license: (doc.license || '').trim(), ptr: (doc.ptr || '').trim(), s2: (doc.s2 || '').trim() },
        patient: patient || '', address: address || '', age: age || '', sex: sex || '',
        items: resolved,
    });

    // the kiosk keeps this receipt; it is the only way back to this prescription from the nurse page
    return { station, items: resolved, id: saved.id, createdAt: saved.createdAt, receipt: receiptFor(saved.id) };
};

// "Previous prescriptions": search what this kiosk printed.
//   receipts: [{ id, receipt }] from the kiosk's own storage
//   q:        patient, address, doctor or any medicine
//   from/to:  YYYY-MM-DD, either may be blank
const history = async ({ receipts, q, from, to }) => {
    if (!Array.isArray(receipts)) throw httpError(400, 'No receipts');
    const ids = receipts.slice(0, MAX_RECEIPTS).filter((r) => r && receiptOk(r.id, r.receipt)).map((r) => r.id);
    if (!ids.length) return { prescriptions: [], total: 0, capped: false };

    const start = from ? new Date(from + 'T00:00:00').getTime() : null;
    const end = to ? new Date(to + 'T23:59:59.999').getTime() : null;
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    const hay = (rx) => [rx.patient, rx.address, rx.age, rx.sex, rx.doctor && rx.doctor.name, rx.station, rx.department,
        ...(rx.items || []).map((i) => `${i.genericName} ${i.brandName} ${i.formName} ${i.strength} ${i.description || ''}`)]
        .join(' ').toLowerCase();

    const all = (await db.getPrescriptionsByIds(ids))
        .filter((rx) => (start == null || rx.createdAt >= start) && (end == null || rx.createdAt <= end))
        .filter((rx) => { const h = hay(rx); return words.every((w) => h.includes(w)); });
    return { prescriptions: all.slice(0, MAX_RESULTS), total: all.length, capped: all.length > MAX_RESULTS };
};

// a reprint records nothing new (demand is never counted twice); it is only
// checked and logged
const reprint = async ({ id, receipt }) => {
    if (!receiptOk(id, receipt)) throw httpError(403, 'This prescription was not printed on this computer');
    const [rx] = await db.getPrescriptionsByIds([id]);
    if (!rx) throw httpError(404, 'This prescription is no longer available — it may have been deleted');
    return { id: rx.id, station: rx.station, department: rx.department, createdAt: rx.createdAt };
};

module.exports = { listStations, listDoctors, suggest, forms, getProduct, supplies, getSupply, createRx, history, reprint };
