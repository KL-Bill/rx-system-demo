/* In-memory medicine catalog, used only for autocomplete.
 *
 * Why this exists: the typeahead search matches mid-string ("mox" inside
 * "Amoxicillin"), which no index can serve, so every keystroke made Postgres
 * scan and sort the whole generic->brand->form->strength tree. Worse, a
 * keystroke cancelled only the *browser's* request — Postgres never hears about
 * that and kept running the abandoned query while holding one of the pool's ten
 * clients. Type an eleven-letter drug name and most of the pool is busy with
 * searches nobody is waiting for; the next query then waits for a free client,
 * and the page freezes rather than fails.
 *
 * The catalog is ~33k rows, changes only when the pharmacy approves a product
 * or a Bizbox export is imported, and costs about 10 MB held flat in memory —
 * so it does not belong in a per-keystroke query at all.
 *
 * SCOPE — deliberately only the suggestions. The "is this in Bizbox?" check
 * (db.findProduct) stays a live query: it is an exact match that already uses
 * an index, so it was never slow, and it is the one that makes a clinical
 * claim. That split is what makes staleness harmless here — the worst a stale
 * cache can do is fail to *suggest* a newly-approved medicine, which the nurse
 * then types by hand (prescribing outside the list is the whole point of this
 * app). It can never report "not in Bizbox" for something that is.
 */
const { pool } = require('./store');

const norm = (x) => String(x || '').trim().toLowerCase();

// Mirrors the LEFT JOIN chain the SQL version walked, so the row universe is
// identical: a generic with no products still contributes a row, and the blank
// brand/form/strength it brings is dropped later by the `value !== ''` test.
const LOAD_SQL = `
    SELECT g.generic_name                AS g,
           COALESCE(b.brand_name, '')    AS b,
           COALESCE(f.form_name, '')     AS f,
           COALESCE(s.label, '')         AS s,
           COALESCE(s.description, '')   AS d,
           s.volume_ml                   AS v,
           COALESCE(s.ihf, false)        AS ihf,
           g.in_pnf                      AS pnf
    FROM generics g
    LEFT JOIN brands b ON b.generic_id = g.id
    LEFT JOIN forms f ON f.brand_id = b.id
    LEFT JOIN strengths s ON s.form_id = f.id`;

const FIELD_KEY = { generic: 'g', brand: 'b', form: 'f', strength: 's' };
const PARENTS = {
    generic: [],
    brand: ['generic'],
    form: ['generic', 'brand'],
    strength: ['generic', 'brand', 'form'],
};
const LIMIT = 50;
const REFRESH_MS = 10 * 60 * 1000;

let rows = null;            // [{ g,b,f,s,d,v, ihf,pnf, lg,lb,lf,ls,ld }] — l* are pre-lowered
let formNames = [];         // distinct non-blank form names, sorted
let loading = null;

const load = async () => {
    const res = await pool.query(LOAD_SQL);
    // pre-lowering once at load is what keeps a search to one pass with no
    // per-row allocation; toLowerCase() on 33k rows per keystroke would undo
    // most of the point of holding them in memory
    const next = res.rows.map((r) => ({
        g: r.g, b: r.b, f: r.f, s: r.s, d: r.d, v: r.v == null ? null : Number(r.v),
        ihf: !!r.ihf, pnf: !!r.pnf,
        lg: norm(r.g), lb: norm(r.b), lf: norm(r.f), ls: norm(r.s), ld: norm(r.d),
    }));
    // only the forms Bizbox products carry (TABLET, VIAL, NEBULE...). The PNDF
    // half of the catalog has thousands of one-off form strings — "(IM)",
    // "Syrup (Grape Flavor)" — that would bury the dropdown.
    const forms = new Map();
    for (const r of next) if (r.ihf && r.f && !forms.has(r.lf)) forms.set(r.lf, r.f);
    formNames = [...forms.values()].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
    rows = next;
    return rows;
};

// Never leaves a half-loaded cache behind: on failure `rows` keeps whatever it
// had (possibly null, which makes isLoaded() false and sends callers back to
// the SQL path) rather than an empty list that would read as "no such medicine".
const reload = async () => {
    if (loading) return loading;
    loading = load()
        .catch((err) => { console.error('catalog cache load failed:', err.message); return rows; })
        .finally(() => { loading = null; });
    return loading;
};

const isLoaded = () => Array.isArray(rows);

// exact match, then starts-with, then contains; compounds ("Foo + Bar") after
// plain names — the same ordering the SQL used, so the list a nurse sees does
// not shuffle just because the search moved in-process
const rankOf = (value, q) => {
    if (!q) return 0;
    const lv = value.toLowerCase();
    const base = lv === q ? 0 : lv.startsWith(q) ? 1 : 2;
    return base * 2 + (value.includes('+') ? 1 : 0);
};

// Plain < / > on the lowered value, not localeCompare: the deployed
// postgres:16-alpine is musl-based and collates bytewise, so this is what
// actually matches what the SQL produced.
const sortRanked = (out) => out.sort((a, b) => {
    if (a._r !== b._r) return a._r - b._r;
    const la = a.value.toLowerCase(), lb = b.value.toLowerCase();
    if (la !== lb) return la < lb ? -1 : 1;
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
});

/* -> [{ value, ihf, pnf, soleGeneric }] — same shape db.suggestOptions returned.
 *    ihf/pnf: true when ANY product under this value carries the flag
 *    soleGeneric: the generic when exactly one sits behind this value, which is
 *    what lets picking a brand fill the generic in for the nurse
 */
const suggest = (field, sel = {}) => {
    if (field === 'combo') return suggestCombo(sel);
    const key = FIELD_KEY[field];
    if (!key || !isLoaded()) return null;         // null = "cannot answer", caller falls back

    const q = norm(sel.q);
    const parents = PARENTS[field]
        .map((p) => [FIELD_KEY[p], norm(sel[p])])
        .filter(([, v]) => v);

    // one pass: filter and aggregate together
    const groups = new Map();
    for (const r of rows) {
        const value = r[key];
        if (value === '') continue;
        if (q && !r['l' + key].includes(q)) continue;
        let skip = false;
        for (const [pk, pv] of parents) { if (r['l' + pk] !== pv) { skip = true; break; } }
        if (skip) continue;

        let acc = groups.get(value);
        if (!acc) groups.set(value, (acc = { value, ihf: false, pnf: false, gen: r.g, multi: false }));
        if (r.ihf) acc.ihf = true;
        if (r.pnf) acc.pnf = true;
        if (!acc.multi && r.g !== acc.gen) acc.multi = true;
    }

    const out = [...groups.values()];
    for (const o of out) o._r = rankOf(o.value, q);
    sortRanked(out);

    return out.slice(0, LIMIT).map((o) => ({
        value: o.value,
        ihf: o.ihf,
        pnf: o.pnf,
        soleGeneric: o.multi ? null : o.gen,
    }));
};

/* The nurse's Brand/Form/Strength box: one search over the product's
 * description ("ALLERKID 5MG/5ML 60ML SYRUP"), narrowed by the generic when
 * one is filled. Every word typed must appear somewhere in the description or
 * its parts, in any order — "60ml allerkid" finds it too.
 *   -> [{ value, brand, form, strength, volumeMl, ihf, pnf, soleGeneric, generics }]
 * Grouped by generic + description: the same unbranded "500MG TABLET" exists
 * under many generics, and when no generic narrows the search each is its own
 * row (the nurse picks one and the generic fills in).
 */
const suggestCombo = (sel = {}) => {
    if (!isLoaded()) return null;
    const q = norm(sel.q);
    const words = q.split(/\s+/).filter(Boolean);
    const gen = norm(sel.generic);
    if (!words.length && !gen) return [];

    const groups = new Map();
    for (const r of rows) {
        if (r.d === '') continue;
        if (gen && r.lg !== gen) continue;
        if (words.length) {
            const hay = r.ld + ' ' + r.lb + ' ' + r.lf + ' ' + r.ls;
            let ok = true;
            for (const w of words) { if (!hay.includes(w)) { ok = false; break; } }
            if (!ok) continue;
        }
        const k = r.lg + '|' + r.ld;
        let acc = groups.get(k);
        if (!acc) {
            groups.set(k, (acc = {
                value: r.d, brand: r.b, form: r.f, strength: r.s, volumeMl: r.v,
                ihf: false, pnf: false, gen: r.g,
            }));
        }
        if (r.ihf) acc.ihf = true;
        if (r.pnf) acc.pnf = true;
    }

    const out = [...groups.values()];
    for (const o of out) {
        // starts-with on the description or the brand beats a mid-string hit
        const first = words[0] || '';
        const lv = o.value.toLowerCase(), lb = o.brand.toLowerCase();
        o._r = !first ? 0 : (lv.startsWith(first) || lb.startsWith(first)) ? 0 : (lv.includes(first) ? 1 : 2);
    }
    sortRanked(out);

    return out.slice(0, LIMIT).map((o) => ({
        value: o.value, brand: o.brand, form: o.form, strength: o.strength, volumeMl: o.volumeMl,
        ihf: o.ihf, pnf: o.pnf, soleGeneric: o.gen,
    }));
};

// the catalog's live form names, for the nurse's Form dropdown and as the
// splitter's dictionary. Empty until the first load; callers fall back to SQL.
const forms = () => (isLoaded() ? formNames : null);

/* ---- keeping copies in step ----
 * server.js runs a cluster of workers, each with its own copy. A worker that
 * changes the catalog therefore has to tell the others; the primary relays
 * (see server.js). The periodic refresh is the backstop for a message missed
 * while a worker was restarting.
 */
const RELOAD_MSG = 'catalog:reload';

const invalidate = () => {
    reload();
    if (typeof process.send === 'function') process.send({ type: RELOAD_MSG });
};

process.on('message', (msg) => { if (msg && msg.type === RELOAD_MSG) reload(); });

const start = () => {
    reload();
    setInterval(reload, REFRESH_MS).unref();     // must never hold the process open
};

// the flat rows, for the Bizbox import's analyzer — it matches a thousand
// descriptions against the catalog and does that in memory in one pass
const all = () => rows;

module.exports = { start, reload, invalidate, suggest, forms, all, isLoaded, RELOAD_MSG };
