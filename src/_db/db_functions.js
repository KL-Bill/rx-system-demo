const fs = require('fs');
const path = require('path');
const { db, save, newId } = require('./store');

// The single merged drug catalog (built by scripts/build-medicines.js):
// PNDF master list + TMC hospital formulary in one tree. Each strength carries
// { label, registrationNumber, classification, ihf } — ihf = in hospital Formulary.
// Temporary JSON store; this moves to a proper indexed database later.
const MEDICINES_FILE = path.join(__dirname, 'medicines.json');
let medicines = null;
const meds = () => medicines || (medicines = JSON.parse(fs.readFileSync(MEDICINES_FILE, 'utf8')));
const saveMedicines = () => fs.writeFileSync(MEDICINES_FILE, JSON.stringify(medicines, null, 1));

const norm = (x) => String(x || '').trim().toLowerCase();
// stable identity for a prescribed product, used to group demand and key review status
const drugKey = (m) => [m.genericName, m.brandName, m.formName, m.strength].map(norm).join('|');

// ---------- users ----------
const getUserByUsername = (username) => db().users.find((u) => u.username === username) || null;
const getUserById = (id) => db().users.find((u) => u.id === id) || null;
const getAdmins = () => db().users.filter((u) => u.role === 'superadmin' || u.role === 'subadmin');

// ---------- stations / doctors ----------
const getStations = () => db().stations;
const getStation = (id) => db().stations.find((s) => s.id === id) || null;
const getDoctors = () => db().doctors;

// ---------- catalog (merged medicines.json: PNDF + hospital formulary) ----------
const strengthLabel = (s) => s.label || (s.value != null ? `${s.value}${s.unit}` : (s.unit || ''));
const getGenerics = () => meds();

let combosCache = null;
const invalidateCombos = () => { combosCache = null; };

const getCombos = () => {
    if (combosCache) return combosCache;
    const out = [];
    for (const g of meds()) {
        for (const b of g.brands || []) {
            for (const f of b.forms || []) {
                for (const s of f.strengths || []) {
                    out.push({
                        generic: g.genericName, brand: b.brandName, form: f.formName,
                        strength: strengthLabel(s), registrationNumber: s.registrationNumber || null,
                        volumeMl: s.volumeMl != null ? s.volumeMl : null,
                        inFormulary: !!s.ihf, nonPndf: !!s.nonPndf,
                    });
                }
            }
        }
    }
    combosCache = out;
    return out;
};

const findProduct = ({ generic, brand = '', form = '', strength = '' }) => {
    const eq = (a, b) => norm(a) === norm(b);
    return getCombos().find((c) =>
        eq(c.generic, generic) && eq(c.brand, brand) && eq(c.form, form) && eq(c.strength, strength)) || null;
};

// STRICT product-level membership: a medicine is in the hospital Formulary only
// when this exact generic+brand+form+strength combination is a hospital product.
// Anything else — custom strength, different brand, unknown drug — is new.
const inHospitalFormulary = (product) => {
    const c = findProduct(product);
    return !!(c && c.inFormulary);
};

const findRegistration = (product) => {
    const c = findProduct(product);
    return (c && c.registrationNumber) || null;
};

// mark a product as part of the hospital Formulary, creating the node when the
// pharmacy approves something not in the merged catalog at all
const addToCatalog = ({ genericName, brandName, formName, strength }) => {
    const eq = (a, b) => norm(a) === norm(b);
    let g = meds().find((x) => eq(x.genericName, genericName));
    if (!g) { g = { id: newId('g'), genericName, brands: [] }; meds().push(g); }
    let b = (g.brands ||= []).find((x) => eq(x.brandName, brandName));
    if (!b) { b = { id: newId('b'), brandName: brandName || '', forms: [] }; g.brands.push(b); }
    let f = (b.forms ||= []).find((x) => eq(x.formName, formName));
    if (!f) { f = { id: newId('f'), formName, strengths: [] }; b.forms.push(f); }
    let s = (f.strengths ||= []).find((x) => eq(strengthLabel(x), strength));
    if (!s) { s = { id: newId('s'), label: strength, registrationNumber: null, classification: null }; f.strengths.push(s); }
    s.ihf = true;
    invalidateCombos();
    saveMedicines();
};

// ---------- prescriptions ----------
const addPrescription = (record) => {
    const rx = { id: newId('rx'), createdAt: Date.now(), ...record };
    db().prescriptions.push(rx);
    save();
    return rx;
};
const getPrescriptions = () => db().prescriptions;

// ---------- review status ----------
const statusKey = (reason, key) => `${reason}::${key}`;
const getStatus = (reason, key) => db().reviewStatus[statusKey(reason, key)] || null;
const setStatus = (reason, key, rec) => {
    db().reviewStatus[statusKey(reason, key)] = { ...rec, at: Date.now() };
    save();
    return db().reviewStatus[statusKey(reason, key)];
};

// ---------- audit ----------
const addAudit = (entry) => { db().audit.unshift({ id: newId('aud'), at: Date.now(), ...entry }); save(); };
const getAudit = () => db().audit;

module.exports = {
    norm, drugKey,
    getUserByUsername, getUserById, getAdmins,
    getStations, getStation, getDoctors,
    strengthLabel, getGenerics, getCombos, inHospitalFormulary, findRegistration, addToCatalog,
    addPrescription, getPrescriptions,
    getStatus, setStatus,
    addAudit, getAudit,
};
