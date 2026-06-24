const { db, save, newId } = require('./store');

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

// ---------- catalog (generic -> brands -> forms -> strengths) ----------
const strengthLabel = (s) => s.label || (s.value != null ? `${s.value}${s.unit}` : (s.unit || ''));
const getGenerics = () => db().generics;

const getCombos = () => {
    const out = [];
    for (const g of db().generics) {
        for (const b of g.brands || []) {
            for (const f of b.forms || []) {
                for (const s of f.strengths || []) {
                    out.push({
                        generic: g.genericName, brand: b.brandName, form: f.formName,
                        strength: strengthLabel(s), value: s.value, unit: s.unit, nonPndf: !!s.nonPndf,
                    });
                }
            }
        }
    }
    return out;
};

const comboExists = ({ generic, brand, form, strength }) => {
    const eq = (a, b) => norm(a) === norm(b);
    return getCombos().some((c) =>
        eq(c.generic, generic) && eq(c.brand, brand) && eq(c.form, form) && eq(c.strength, strength));
};

// add a medicine into the Formulary, creating generic/brand/form/strength as needed
const addToCatalog = ({ genericName, brandName, formName, value, unit }) => {
    const eq = (a, b) => norm(a) === norm(b);
    const generics = db().generics;
    let g = generics.find((x) => eq(x.genericName, genericName));
    if (!g) { g = { id: newId('g'), genericName, brands: [] }; generics.push(g); }
    let b = (g.brands ||= []).find((x) => eq(x.brandName, brandName));
    if (!b) { b = { id: newId('b'), brandName: brandName || '', forms: [] }; g.brands.push(b); }
    let f = (b.forms ||= []).find((x) => eq(x.formName, formName));
    if (!f) { f = { id: newId('f'), formName, strengths: [] }; b.forms.push(f); }
    const exists = (f.strengths ||= []).some((s) => Number(s.value) === Number(value) && eq(s.unit, unit));
    if (!exists) {
        const v = value != null && value !== '' ? Number(value) : null;
        f.strengths.push({ id: newId('s'), value: v, unit, label: v != null ? `${v}${unit}` : (unit || ''), nonPndf: false });
    }
    save();
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
    strengthLabel, getGenerics, getCombos, comboExists, addToCatalog,
    addPrescription, getPrescriptions,
    getStatus, setStatus,
    addAudit, getAudit,
};
