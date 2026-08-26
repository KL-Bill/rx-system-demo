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
 * The catalog is ~33k rows, changes only when the pharmacy approves a product,
 * and costs about 9 MB held flat in memory — so it does not belong in a
 * per-keystroke query at all.
 *
 * SCOPE — deliberately only the suggestions. The "is this in the hospital
 * Formulary?" check (db.findProduct) stays a live query: it is an exact
 * four-field match that already uses an index, so it was never slow, and it is
 * the one that makes a clinical claim. That split is what makes staleness
 * harmless here — the worst a stale cache can do is fail to *suggest* a
 * newly-approved medicine, which the nurse then types by hand (prescribing
 * outside the list is the whole point of this app). It can never report "not in
 * the Formulary" for something that is.
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

let rows = null;            // [{ g,b,f,s, ihf,pnf, lg,lb,lf,ls }] — l* are pre-lowered
let loading = null;

const load = async () => {
    const res = await pool.query(LOAD_SQL);
    // pre-lowering once at load is what keeps a search to one pass with no
    // per-row allocation; toLowerCase() on 33k rows per keystroke would undo
    // most of the point of holding them in memory
    rows = res.rows.map((r) => ({
        g: r.g, b: r.b, f: r.f, s: r.s,
        ihf: !!r.ihf, pnf: !!r.pnf,
        lg: norm(r.g), lb: norm(r.b), lf: norm(r.f), ls: norm(r.s),
    }));
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

/* -> [{ value, ihf, pnf, soleGeneric }] — same shape db.suggestOptions returned.
 *    ihf/pnf: true when ANY product under this value carries the flag
 *    soleGeneric: the generic when exactly one sits behind this value, which is
 *    what lets picking a brand fill the generic in for the nurse
 */
const suggest = (field, sel = {}) => {
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

    // Plain < / > on the lowered value, not localeCompare: the deployed
    // postgres:16-alpine is musl-based and collates bytewise, so this is what
    // actually matches what the SQL produced.
    const out = [...groups.values()];
    for (const o of out) o._r = rankOf(o.value, q);
    out.sort((a, b) => {
        if (a._r !== b._r) return a._r - b._r;
        const la = a.value.toLowerCase(), lb = b.value.toLowerCase();
        if (la !== lb) return la < lb ? -1 : 1;
        return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
    });

    return out.slice(0, LIMIT).map((o) => ({
        value: o.value,
        ihf: o.ihf,
        pnf: o.pnf,
        soleGeneric: o.multi ? null : o.gen,
    }));
};

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

module.exports = { start, reload, invalidate, suggest, isLoaded, RELOAD_MSG };
