const db = require('../_db/db_functions');

const labelOf = (it) => {
    const brand = it.brandName ? ` (${it.brandName})` : '';
    return `${it.genericName}${brand} ${it.formName} ${it.strength}`.replace(/\s+/g, ' ').trim();
};

// reasons a medicine can land on one of these prescriptions
const PROBLEM = ['not_in_formulary', 'out_of_stock'];
const ALL_REASONS = [...PROBLEM, 'normal'];

// 'normal' = in the hospital Formulary AND in stock. It should NEVER be on one of these
// slips (in-stock items go through the main system so PhilHealth records them), so a
// normal item here is an anomaly worth monitoring — not a legitimate grouping.
const reasonsWanted = (reason) => {
    if (reason === 'all') return ALL_REASONS;
    if (!reason || reason === 'both') return PROBLEM;
    return [reason];
};

// every prescription item, within an optional date range
async function allItems({ from, to } = {}) {
    const out = [];
    for (const rx of await db.getPrescriptions()) {
        if (from != null && rx.createdAt < from) continue;
        if (to != null && rx.createdAt > to) continue;
        for (const it of rx.items) out.push({ rx, it });
    }
    return out;
}

const statusInfo = async (reason, key) => {
    const rec = await db.getStatus(reason, key);
    const status = rec ? rec.status : 'pending';
    return { status, statusDate: rec ? rec.statusDate : null, resolved: status === 'added_to_formulary' || status === 'restocked' };
};

const tally = (map, name, qty, date) => {
    const k = name || '—';
    const e = map.get(k) || { name: k, prescriptions: 0, volume: 0, lastDate: 0 };
    e.prescriptions += 1; e.volume += qty; e.lastDate = Math.max(e.lastDate, date || 0);
    map.set(k, e);
};
const listOf = (map) => [...map.values()].sort((a, b) => b.volume - a.volume || b.prescriptions - a.prescriptions);

// grouped by drug + reason, ranked by demand. Optional department scope.
async function aggregate({ reason, from, to, department } = {}) {
    const wanted = reasonsWanted(reason);
    const groups = new Map();
    for (const { rx, it } of await allItems({ from, to })) {
        if (!wanted.includes(it.reason)) continue;
        if (department && department !== 'all' && rx.department !== department) continue;
        const key = db.drugKey(it);
        const gk = it.reason + '::' + key;
        let g = groups.get(gk);
        if (!g) {
            g = {
                key, reason: it.reason, label: labelOf(it),
                generic: it.genericName, brand: it.brandName, form: it.formName, strength: it.strength,
                registrationNumber: it.registrationNumber || null,
                prescriptions: 0, volume: 0, departments: new Set(), doctors: new Set(),
                byDept: new Map(), byDoctor: new Map(), lastDate: 0,
            };
            groups.set(gk, g);
        }
        g.prescriptions += 1;
        g.volume += it.quantity;
        if (rx.department) g.departments.add(rx.department);
        if (rx.doctor && rx.doctor.name) g.doctors.add(rx.doctor.name);
        tally(g.byDept, rx.department, it.quantity, rx.createdAt);
        tally(g.byDoctor, rx.doctor && rx.doctor.name, it.quantity, rx.createdAt);
        g.lastDate = Math.max(g.lastDate, rx.createdAt);
    }
    const results = await Promise.all([...groups.values()].map(async (g) => ({
        key: g.key, reason: g.reason, label: g.label,
        generic: g.generic, brand: g.brand, form: g.form, strength: g.strength,
        registrationNumber: g.registrationNumber,
        prescriptions: g.prescriptions, volume: g.volume,
        departments: [...g.departments], doctors: [...g.doctors],
        byDepartment: listOf(g.byDept), byDoctor: listOf(g.byDoctor),
        lastDate: g.lastDate,
        ...(await statusInfo(g.reason, g.key)),
    })));
    return results.sort((a, b) => b.prescriptions - a.prescriptions || b.volume - a.volume);
}

// per-prescription detail for one drug + reason (who, which dept, how much)
async function detail(key, reason, { from, to } = {}) {
    let label = '', generic = '', brand = '', form = '', strength = '', registrationNumber = null;
    const rows = [];
    for (const { rx, it } of await allItems({ from, to })) {
        if (it.reason !== reason || db.drugKey(it) !== key) continue;
        if (!label) { label = labelOf(it); generic = it.genericName; brand = it.brandName; form = it.formName; strength = it.strength; registrationNumber = it.registrationNumber || null; }
        rows.push({ date: rx.createdAt, department: rx.department, doctor: rx.doctor ? rx.doctor.name : '', patient: rx.patient, quantity: it.quantity, volumeMl: it.volumeMl || null });
    }
    rows.sort((a, b) => b.date - a.date);
    return {
        key, reason, label, generic, brand, form, strength, registrationNumber,
        prescriptions: rows.length,
        volume: rows.reduce((s, r) => s + r.quantity, 0),
        departments: [...new Set(rows.map((r) => r.department))],
        doctors: [...new Set(rows.map((r) => r.doctor).filter(Boolean))],
        rows,
        ...(await statusInfo(reason, key)),
    };
}

module.exports = { aggregate, detail, labelOf };
