const db = require('../_db/db_functions');

const labelOf = (it) => {
    const brand = it.brandName ? ` (${it.brandName})` : '';
    return `${it.genericName}${brand} ${it.formName} ${it.strength}`.replace(/\s+/g, ' ').trim();
};

// The "Brand/Form/Strength" column: the Bizbox wording when the item was
// picked from the catalog (it.description), else the same parts stitched in
// Bizbox order — brand, strength, form — e.g. "BIOGESIC 500MG TABLET".
// A supply has no brand/form/strength: its description sits in the Generic
// column (it.genericName) and this column stays blank. The pages mark the row
// as a supply themselves (kind + supplyCode), under the name.
const isSupply = (it) => it.kind === 'supply';
const descriptionOf = (it) => (isSupply(it)
    ? ''
    : it.description || [it.brandName, it.strength, it.formName].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim());

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

// every prescription item, within an optional date range. The range goes to
// SQL, not to a filter here — see db.getPrescriptions.
//
// Reading and parsing a year of prescriptions is the expensive part of this
// file, and a single screen does it more than once: Review asks twice (the
// problems and the anomalies), opening a row asks again, and the report and
// the log sit on the same rows. So a window is remembered for a few seconds —
// long enough to serve one screen's burst, short enough that a prescription
// printed on a ward shows up on the next refresh.
const ITEMS_TTL_MS = 8000;
const itemsCache = new Map();           // "from|to" -> { at, items }
async function allItems({ from, to } = {}) {
    const key = `${from == null ? '' : from}|${to == null ? '' : to}`;
    const hit = itemsCache.get(key);
    if (hit && Date.now() - hit.at < ITEMS_TTL_MS) return hit.items;

    const out = [];
    for (const rx of await db.getPrescriptions({ from, to })) {
        for (const it of rx.items) out.push({ rx, it });
    }
    if (itemsCache.size > 8) itemsCache.clear();
    itemsCache.set(key, { at: Date.now(), items: out });
    return out;
}
// a new prescription, or a deletion, must not wait for the TTL
const forgetItems = () => itemsCache.clear();

// Where a drug stands, and whether the ward has prescribed it AGAIN since it
// was closed. "Restocked" means stock arrived; a prescription written after
// that says it ran out again, so the row is reopened rather than left sitting
// in Resolved where nobody looks. The old decision is kept — it is in the
// timeline, and `reopenedFrom` says what it was.
//   dates: every prescription date in this group, for this reason
// `rec` is the review_status row, or null. Pass one in from a batch when
// looking at many drugs at once (aggregate); leave it out for a single row.
const statusInfoFrom = (rec, dates = []) => {
    const status = rec ? rec.status : 'pending';
    const closed = status === 'added_to_formulary' || status === 'restocked';
    const statusDate = rec ? rec.statusDate : null;
    const since = closed && statusDate ? dates.filter((d) => d > statusDate).sort((a, b) => a - b) : [];
    const reopened = since.length > 0;
    return {
        status, statusDate,
        resolved: closed && !reopened,
        reopened,
        reopenedFrom: reopened ? status : null,          // what it had been closed as
        reopenedSince: reopened ? since[0] : null,       // the prescription that brought it back
        sinceCount: since.length,                        // how many since it was closed
    };
};
const statusInfo = async (reason, key, dates = []) => statusInfoFrom(await db.getStatus(reason, key), dates);

// the pharmacy's remarks, grouped per reason::key, newest first
const remarksByDrug = async () => {
    const map = new Map();
    for (const r of await db.getAllRemarks()) {
        const k = r.reason + '::' + r.drugKey;
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(r);
    }
    return map;
};
// the whole history for a single row; for a list, the latest and a count —
// plus the time of the newest, which is what tells the Review tabs whether
// somebody has spoken since the row came back
const remarkInfo = (list, summary = false) => (summary
    ? { remarkCount: (list || []).length, lastRemark: (list && list[0]) || null, lastRemarkAt: (list && list[0] && list[0].at) || null }
    : { remarks: list || [], remarkCount: (list || []).length, lastRemark: (list && list[0]) || null, lastRemarkAt: (list && list[0] && list[0].at) || null });

// NOTE: `volume` here means TOTAL QUANTITY PRESCRIBED — a count of units, not
// millilitres. A liquid medicine also has a real volume (item.volumeMl, the mL
// to dispense) and the two are completely different numbers. Every screen
// labels this one "Total qty" / "Qty" for that reason; only mL is ever called
// volume in the UI.
const tally = (map, name, qty, date) => {
    const k = name || '—';
    const e = map.get(k) || { name: k, prescriptions: 0, volume: 0, lastDate: 0 };
    e.prescriptions += 1; e.volume += qty; e.lastDate = Math.max(e.lastDate, date || 0);
    map.set(k, e);
};
const listOf = (map) => [...map.values()].sort((a, b) => b.volume - a.volume || b.prescriptions - a.prescriptions);

// grouped by drug + reason, ranked by demand. Optional department scope.
//
// summary:true leaves out the per-doctor and per-department breakdowns. They
// are 89% of the bytes on a year of data (2.9 MB of a 4.3 MB answer) and the
// Review table shows none of it — the detail panel asks for the one row the
// reviewer opened. Reports still takes the full shape: it prints the
// breakdowns.
async function aggregate({ reason, from, to, department, summary = false } = {}) {
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
                key, reason: it.reason, label: labelOf(it), description: descriptionOf(it),
                kind: isSupply(it) ? 'supply' : 'medicine', supplyCode: it.supplyCode || null,
                generic: it.genericName, brand: it.brandName, form: it.formName, strength: it.strength,
                registrationNumber: it.registrationNumber || null,
                prescriptions: 0, volume: 0, departments: new Set(), doctors: new Set(),
                byDept: new Map(), byDoctor: new Map(), lastDate: 0, dates: [],
            };
            groups.set(gk, g);
        }
        g.prescriptions += 1;
        g.volume += it.quantity;
        g.dates.push(rx.createdAt);
        if (rx.department) g.departments.add(rx.department);
        if (rx.doctor && rx.doctor.name) g.doctors.add(rx.doctor.name);
        tally(g.byDept, rx.department, it.quantity, rx.createdAt);
        tally(g.byDoctor, rx.doctor && rx.doctor.name, it.quantity, rx.createdAt);
        g.lastDate = Math.max(g.lastDate, rx.createdAt);
    }
    const remarks = await remarksByDrug();
    // one query for every status, instead of one per row
    const statuses = new Map((await db.getAllStatuses()).map((r) => [r.reason + '::' + r.drugKey, r]));
    const results = await Promise.all([...groups.values()].map(async (g) => ({
        key: g.key, reason: g.reason, label: g.label, description: g.description,
        kind: g.kind, supplyCode: g.supplyCode,
        generic: g.generic, brand: g.brand, form: g.form, strength: g.strength,
        registrationNumber: g.registrationNumber,
        prescriptions: g.prescriptions, volume: g.volume,
        departments: [...g.departments], doctors: [...g.doctors],
        ...(summary ? {} : { byDepartment: listOf(g.byDept), byDoctor: listOf(g.byDoctor) }),
        lastDate: g.lastDate,
        ...statusInfoFrom(statuses.get(g.reason + '::' + g.key) || null, g.dates),
        ...remarkInfo(remarks.get(g.reason + '::' + g.key), summary),
    })));
    return results.sort((a, b) => b.prescriptions - a.prescriptions || b.volume - a.volume);
}

// One dated story for a drug: when it was prescribed here, when the pharmacy
// said something about it, and when its status moved — newest first. Reading
// it top to bottom answers "prescribed on these days, restocked on that one,
// prescribed again after".
const STATUS_WORDS = {
    pending: 'Pending', under_therapeutics: 'Sent to Therapeutics',
    added_to_formulary: 'Marked Added to Bizbox', restocked: 'Marked Restocked',
};
async function buildTimeline(reason, key, rows, remarks) {
    const out = [];
    for (const r of rows) {
        out.push({
            at: r.date, type: 'prescribed',
            text: `Prescribed · ${r.department || '—'}`,
            detail: [r.doctor ? drName(r.doctor) : '', r.quantity ? `qty ${r.quantity}` : ''].filter(Boolean).join(' · '),
        });
    }
    for (const r of remarks || []) {
        out.push({
            at: r.at, type: 'remark', remark: r.remark,
            text: `Remark · ${r.remark.replace(/_/g, ' ')}`,
            detail: [r.note || '', r.actor || ''].filter(Boolean).join(' — '),
        });
    }
    for (const e of await db.getRemarkEdits(reason, key)) {
        const was = `${e.oldRemark.replace(/_/g, ' ')}${e.oldNote ? `: ${e.oldNote}` : ''}`;
        const now = `${e.newRemark.replace(/_/g, ' ')}${e.newNote ? `: ${e.newNote}` : ''}`;
        out.push({
            at: e.at, type: 'edit',
            text: 'Remark corrected',
            detail: `was "${was}" — now "${now}"${e.actor ? ` · ${e.actor}` : ''}`,
        });
    }
    for (const r of await db.getRemovedRemarks(reason, key)) {
        out.push({
            at: r.deletedAt, type: 'edit',
            text: 'Remark removed',
            detail: `"${r.remark.replace(/_/g, ' ')}${r.note ? `: ${r.note}` : ''}" by ${r.actor || '—'}${r.deletedBy ? ` · removed by ${r.deletedBy}` : ''}`,
        });
    }
    for (const e of await db.getStatusEvents(reason, key)) {
        out.push({
            at: e.at, type: 'status', status: e.status,
            text: STATUS_WORDS[e.status] || e.status.replace(/_/g, ' '),
            detail: [e.actor || '', e.authorizedBy && e.authorizedBy !== e.actor ? `auth. ${e.authorizedBy}` : ''].filter(Boolean).join(' · '),
        });
    }
    return out.sort((a, b) => b.at - a.at);
}

// the doctor's name as the pages show it
const drName = (n) => (/^dr\.?\s/i.test(String(n || '').trim()) ? String(n).trim() : `Dr. ${String(n || '').trim()}`);

// per-prescription detail for one drug + reason (who, which dept, how much)
async function detail(key, reason, { from, to } = {}) {
    let label = '', description = '', generic = '', brand = '', form = '', strength = '', registrationNumber = null;
    let kind = 'medicine', supplyCode = null;
    const rows = [];
    for (const { rx, it } of await allItems({ from, to })) {
        if (it.reason !== reason || db.drugKey(it) !== key) continue;
        if (!label) { label = labelOf(it); description = descriptionOf(it); generic = it.genericName; brand = it.brandName; form = it.formName; strength = it.strength; registrationNumber = it.registrationNumber || null; kind = isSupply(it) ? 'supply' : 'medicine'; supplyCode = it.supplyCode || null; }
        rows.push({ date: rx.createdAt, department: rx.department, doctor: rx.doctor ? rx.doctor.name : '', patient: rx.patient, quantity: it.quantity, volumeMl: it.volumeMl || null });
    }
    rows.sort((a, b) => b.date - a.date);
    // The dispense volumes actually seen for this drug, as a distinct list.
    // A list rather than one number because drugKey() is
    // generic|brand|form|strength — no volume — so a syrup prescribed as 60 mL
    // and as 120 mL is one row here. Showing a single figure would be picking
    // one arbitrarily and calling it the answer.
    const volumesMl = [...new Set(rows.map((r) => r.volumeMl).filter((v) => v != null))]
        .sort((a, b) => a - b);
    // the same tallies aggregate() builds, for the one drug being opened.
    // The detail used to leave these out and the pages read them off the list
    // row instead — which stopped working the moment the list became a
    // summary, and left the breakdown tables empty.
    const byDept = new Map(), byDoctor = new Map();
    for (const r of rows) {
        tally(byDept, r.department, r.quantity, r.date);
        tally(byDoctor, r.doctor, r.quantity, r.date);
    }

    const info = await statusInfo(reason, key, rows.map((r) => r.date));
    const remarks = await db.getRemarks(reason, key);
    return {
        key, reason, label, description, kind, supplyCode, generic, brand, form, strength, registrationNumber,
        timeline: await buildTimeline(reason, key, rows, remarks),
        prescriptions: rows.length,
        volume: rows.reduce((s, r) => s + r.quantity, 0),   // total qty, not mL — see tally()
        volumesMl,
        departments: [...new Set(rows.map((r) => r.department))],
        doctors: [...new Set(rows.map((r) => r.doctor).filter(Boolean))],
        byDepartment: listOf(byDept), byDoctor: listOf(byDoctor),
        rows,
        ...info,
        ...remarkInfo(remarks),
    };
}

module.exports = { aggregate, detail, labelOf, descriptionOf, forgetItems };
