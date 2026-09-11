// Bizbox import: an uploaded export becomes a job that is analyzed, reviewed
// by a person, then applied. The job lives in catalog_imports — the app runs
// several workers, so progress and decisions cannot sit in one process's
// memory; every step reads and writes the row, and the page polls it.
//
// Lifecycle (status):
//   uploaded        the sheet is parsed and stored; waiting for the column choice
//   analyzing       classifying rows against the catalog, in batches (progress)
//   awaiting_review the reviewer edits, accepts, excludes; decisions saved as they go
//   applying        writing the catalog, in batches (progress)
//   done | cancelled | failed
//
// Nothing is removed or unflagged, ever. A Bizbox product missing from the
// file is reported in the result and left alone.
//
// Two kinds of file (summary.kind):
//   medicine  generic + description; split into brand/form/strength and
//             matched against the medicine tree (most of this file)
//   supply    Bizbox item code + description (MEDSUPP: Pk_iwitems, Itemdesc);
//             a flat list matched by code, then by wording. Nothing to split,
//             so nothing lands in "Needs your decision".

const db = require('../_db/db_functions');
const catalogCache = require('../_db/catalog-cache');
const splitDescription = require('../public/js/split.js');
const { readSheet } = require('../lib/xlsx');

const httpError = (status, message) => Object.assign(new Error(message), { status });
const norm = (x) => String(x || '').replace(/\s+/g, ' ').trim().toLowerCase();
const BATCH = 100;
const STALE_MS = 2 * 60 * 1000;     // a job with no heartbeat this long lost its worker

// ---- row categories (what the reviewer sees as tabs) ----
//   unchanged  already in Bizbox: seen before, or the exact product is flagged
//   flag       the exact product exists in the catalog but is not flagged
//   same       same generic + brand, matched by form family -- a suggestion to confirm
//   similar    same generic + brand, a different strength or form (new product)
//   new        nothing close
//   attention  the split is doubtful (no form / no strength / digits in the brand)
//   excluded   matches a remembered exclusion
// and actions: flag | same | new | skip | review (attention rows start here)

// spelling-insensitive keys for "possibly the same"
const strengthKey = (s) => norm(s).replace(/\s+/g, '').replace(/gms?\b/g, 'g').replace(/i\.u\./g, 'iu').replace(/,/g, '');
// The catalog built before this import kept the volume beside the strength
// ("5MG/5ML" + volume_ml 60) while the Bizbox text carries it inside
// ("5MG/5ML 60ML"). The same product, two conventions — so a strength is
// also compared with its trailing volume set aside, provided the volumes
// agree (or the old row never recorded one).
const VOL_TAIL = /\s*\d[\d,]*(?:\.\d+)?\s?(?:ml|l)$/i;
const withoutVolume = (s) => String(s || '').trim().replace(VOL_TAIL, '').trim();
const sameStrength = (oldRow, sp) => {
    if (strengthKey(oldRow.s) === strengthKey(sp.strength)) return true;
    const trimmed = withoutVolume(sp.strength);
    if (!trimmed || trimmed === sp.strength.trim()) return false;
    if (strengthKey(oldRow.s) !== strengthKey(trimmed)) return false;
    return oldRow.v == null || sp.volumeMl == null || Number(oldRow.v) === Number(sp.volumeMl);
};
const formKey = (f) => {
    const canon = { tab: 'tablet', tabs: 'tablet', tablets: 'tablet', cap: 'capsule', caps: 'capsule', capsules: 'capsule', amp: 'ampoule', ampule: 'ampoule', ampules: 'ampoule', ampoules: 'ampoule', vials: 'vial', susp: 'suspension', suspensio: 'suspension', soln: 'solution', inj: 'injection', oinment: 'ointment', nebules: 'nebule', sachets: 'sachet', pfs: 'prefilled syringe', 'pre-filled syringe': 'prefilled syringe' };
    const k = norm(f);
    return canon[k] || k;
};

// The PNDF half of the catalog names the salt — "Cetirizine Dihydrochloride",
// "Ketorolac (as Trometamol)" — where Bizbox writes "CETIRIZINE". Same
// molecule, so generics are compared with the salt words and parentheses
// stripped. Only for finding a twin; the stored generic is never rewritten.
const SALTS = /\b(?:hydrochloride|dihydrochloride|hcl|hbr|hydrobromide|sodium|potassium|calcium|magnesium|trometamol|tromethamine|tromethamol|maleate|sulfate|sulphate|acetate|besylate|besilate|mesylate|mesilate|citrate|tartrate|bitartrate|succinate|phosphate|diphosphate|bromide|nitrate|fumarate|oxalate|lactate|gluconate|stearate|palmitate|propionate|valerate|dipropionate|monohydrate|dihydrate|trihydrate|anhydrous|micronized|micronised|base|as|salt)\b/gi;
const genericKey = (g) => norm(String(g || '').replace(/\([^)]*\)/g, ' ')).replace(SALTS, ' ').replace(/[^a-z0-9+% ]/g, ' ').replace(/\s+/g, ' ').trim();
// "Syrup (Grape Flavor)" and "Film-Coated Tablet" are, for matching, a syrup
// and a tablet: compare the base form word once the extras are gone
const BASE_FORMS = ['tablet', 'capsule', 'syrup', 'suspension', 'solution', 'drops', 'vial', 'ampoule', 'sachet', 'nebule', 'respule', 'cream', 'ointment', 'gel', 'spray', 'suppository', 'syringe', 'pen', 'inhaler', 'injection', 'infusion', 'powder', 'patch', 'lotion', 'lozenge', 'granules', 'bag', 'bottle'];
const baseForm = (f) => {
    const k = formKey(String(f || '').replace(/\([^)]*\)/g, ' '));
    if (/prefilled syringe|pre-filled syringe/.test(k)) return 'prefilled syringe';
    const words = k.split(/[\s\-\/]+/);
    for (let i = words.length - 1; i >= 0; i--) { const w = formKey(words[i]); if (BASE_FORMS.includes(w)) return w; }
    return k;
};
// Beyond the base word, the two lists describe one product from different
// angles: Bizbox says the container ("AMPOULE", "VIAL"), the PNDF the
// preparation ("Solution for Injection", "Powder For Injection"). Same brand,
// same strength, forms in the same family = the same product, proposed as
// such and left for the reviewer to confirm. Tablet and capsule stay apart.
const FORM_FAMILY = {
    injectable: ['ampoule', 'vial', 'injection', 'infusion', 'prefilled syringe', 'syringe', 'bag', 'bottle', 'powder', 'polyamp'],
    oral_liquid: ['syrup', 'suspension', 'drops', 'solution', 'elixir'],
    tablet: ['tablet'], capsule: ['capsule'], sachet: ['sachet', 'granules'],
    topical: ['cream', 'ointment', 'gel', 'lotion'], inhaled: ['nebule', 'respule', 'inhaler', 'spray'],
    rectal: ['suppository', 'enema'], patch: ['patch'], pen: ['pen'], lozenge: ['lozenge'],
};
const familyOf = (f) => {
    const k = formKey(String(f || ''));
    if (/inject|infusion|ampoule|vial|syringe|iv\b/.test(k)) return 'injectable';
    const b = baseForm(f);
    return Object.keys(FORM_FAMILY).find((fam) => FORM_FAMILY[fam].includes(b)) || null;
};
const sameForm = (oldForm, newForm) => {
    if (!String(oldForm || '').trim()) return true;                 // the old row never recorded a form
    if (formKey(oldForm) === formKey(newForm)) return true;
    const bo = baseForm(oldForm), bn = baseForm(newForm);
    if (bo && bo === bn) return true;
    const fo = familyOf(oldForm), fn = familyOf(newForm);
    return !!fo && fo === fn;
};

const guessColumns = (headers) => {
    const h = headers.map((x) => norm(x));
    const find = (...needles) => h.findIndex((x) => needles.some((n) => x.includes(n)));
    let generic = find('generic', 'itemdesc');
    let desc = find('abbrev', 'description', 'brand', 'item name');
    if (generic < 0) generic = 0;
    if (desc < 0 || desc === generic) desc = generic === 0 ? 1 : 0;
    // a code column and no generic column: the supplies export
    const code = find('pk_iwitems', 'itemcode', 'item code', 'code');
    const kind = code >= 0 && find('generic') < 0 ? 'supply' : 'medicine';
    let supDesc = find('itemdesc', 'description', 'item name');
    if (supDesc < 0 || supDesc === code) supDesc = code === 0 ? 1 : 0;
    return { genericCol: generic, descCol: desc, kind, codeCol: code, supplyDescCol: supDesc };
};

// ----- upload -----
const createFromUpload = async ({ name, buffer, actor }) => {
    if (!buffer || !buffer.length) throw httpError(400, 'The upload is empty');
    let sheet;
    try { sheet = readSheet(buffer, name); } catch (e) { throw httpError(400, `Could not read the file: ${e.message}`); }
    if (sheet.length < 2) throw httpError(400, 'The sheet has no data rows under the header');
    const headers = sheet[0].map((x, i) => x || `Column ${i + 1}`);
    const data = sheet.slice(1).filter((r) => r.some((x) => x));
    const id = await db.createImport({
        file: String(name || 'upload.xlsx').slice(0, 200), uploadedBy: actor && actor.name, status: 'uploaded',
        rows: { sheet: data },
        summary: { headers, guess: guessColumns(headers), rowCount: data.length },
    });
    return { id, headers, guess: guessColumns(headers), rowCount: data.length, sample: data.slice(0, 5) };
};

// ----- analyze -----
const analyze = async (id, { genericCol, descCol, kind, codeCol }, actor) => {
    const job = await db.getImport(id);
    if (!job) throw httpError(404, 'Import not found');
    if (job.status !== 'uploaded') throw httpError(409, `This import is already ${job.status.replace(/_/g, ' ')}`);
    if (kind === 'supply') {
        descCol = Number(descCol); codeCol = codeCol === '' || codeCol == null ? -1 : Number(codeCol);
        if (!Number.isInteger(descCol) || descCol < 0) throw httpError(400, 'Pick the description column');
        if (codeCol === descCol) throw httpError(400, 'Pick two different columns');
        const sheet = job.rows.sheet || [];
        await db.updateImport(id, { status: 'analyzing', total: sheet.length, processed: 0, summary: { ...job.summary, kind: 'supply', codeCol, descCol, heartbeat: Date.now(), counts: {} } });
        setImmediate(() => runAnalyzeSupplies(id, sheet, codeCol, descCol).catch((e) => fail(id, e)));
        return { id };
    }
    genericCol = Number(genericCol); descCol = Number(descCol);
    if (!Number.isInteger(genericCol) || !Number.isInteger(descCol) || genericCol === descCol) throw httpError(400, 'Pick two different columns');
    const sheet = job.rows.sheet || [];
    await db.updateImport(id, { status: 'analyzing', total: sheet.length, processed: 0, summary: { ...job.summary, kind: 'medicine', genericCol, descCol, heartbeat: Date.now(), counts: {} } });
    setImmediate(() => runAnalyze(id, sheet, genericCol, descCol).catch((e) => fail(id, e)));
    return { id };
};

const fail = async (id, e) => {
    console.error(`import ${id} failed:`, e);
    const job = await db.getImport(id, { withRows: false });
    await db.updateImport(id, { status: 'failed', finishedAt: Date.now(), summary: { ...(job ? job.summary : {}), error: e.message } });
};

const emptyCounts = () => ({ unchanged: 0, flag: 0, same: 0, similar: 0, new: 0, attention: 0, excluded: 0 });

async function runAnalyze(id, sheet, genericCol, descCol) {
    if (!catalogCache.isLoaded()) await catalogCache.reload();
    const cat = catalogCache.all() || [];
    const forms = catalogCache.forms() || [];

    // indexes over the catalog, built once
    // byGenBrand is keyed on the salt-stripped generic + brand, so the PNDF
    // "Cetirizine Dihydrochloride / Allerkid" rows sit with Bizbox's
    // "CETIRIZINE / ALLERKID". Unbranded rows ('' brand) are kept apart.
    // byDescLoose: the same description under the salt-named spelling of the
    // generic ("Cetirizine Dihydrochloride" for "CETIRIZINE") is the same row
    const byDesc = new Map(), byDescLoose = new Map(), byKey = new Map(), byGenBrand = new Map(), generics = new Set();
    for (const r of cat) {
        generics.add(r.lg);
        if (r.d) { byDesc.set(r.lg + '|' + r.ld, r); byDescLoose.set(genericKey(r.g) + '|' + r.ld, r); }
        if (r.b || r.f || r.s) {
            byKey.set([r.lg, r.lb, r.lf, r.ls].join('|'), r);
            const gb = genericKey(r.g) + '|' + r.lb;
            if (!byGenBrand.has(gb)) byGenBrand.set(gb, []);
            byGenBrand.get(gb).push(r);
        }
    }
    // an old row claimed as the twin of one line in this file cannot also be
    // the twin of the next (30ML and 60ML syrups both matching one PNDF row)
    const claimed = new Set();
    const rowKey = (r) => [r.lg, r.lb, r.lf, r.ls].join('|');
    const excluded = new Map((await db.getExclusions()).map((x) => [x.key, x]));
    const product = (r) => ({ generic: r.g, brand: r.b, form: r.f, strength: r.s, description: r.d, ihf: r.ihf });

    const out = [];
    const counts = emptyCounts();
    let seenKeys = new Set();       // duplicates inside the file itself
    for (let i = 0; i < sheet.length; i++) {
        const cells = sheet[i];
        const description = String(cells[descCol] || '').replace(/\s+/g, ' ').trim();
        let generic = String(cells[genericCol] || '').replace(/\s+/g, ' ').trim();
        if (/^not applicable$|^n\/?a$|^none$|^-+$/i.test(generic)) generic = '';
        const row = { i, generic, description, brand: '', form: '', strength: '', volumeMl: null, warnings: [], category: 'new', action: 'new', match: null, siblings: [], note: '' };
        if (!description) { row.category = 'excluded'; row.excluded = true; row.action = 'skip'; row.note = 'blank description'; out.push(row); counts.excluded++; continue; }

        const sp = splitDescription(description, { forms, generic });
        Object.assign(row, { brand: sp.brand, form: sp.form, strength: sp.strength, volumeMl: sp.volumeMl, warnings: sp.warnings.slice() });
        if (sp.nonPndf) row.note = 'non-PNDF';

        const lg = norm(generic);
        const exKey = db.exclusionKey(description);
        if (excluded.has(exKey)) { row.category = 'excluded'; row.excluded = true; row.remember = true; row.action = 'skip'; row.note = 'excluded last time'; out.push(row); counts.excluded++; continue; }

        // the same line twice in one file: keep the first, skip the rest
        const dupKey = lg + '|' + norm(description);
        if (seenKeys.has(dupKey)) { row.category = 'excluded'; row.excluded = true; row.action = 'skip'; row.note = 'duplicate line in this file'; out.push(row); counts.excluded++; continue; }
        seenKeys.add(dupKey);

        if (!generic) { row.category = 'attention'; row.action = 'review'; row.warnings.unshift('no generic'); out.push(row); counts.attention++; continue; }

        // 1. seen before, word for word
        let m = byDesc.get(lg + '|' + norm(description)) || byDescLoose.get(genericKey(generic) + '|' + norm(description));
        // 2. the exact product, by its parts
        if (!m) m = byKey.get([lg, norm(sp.brand), norm(sp.form), norm(sp.strength)].join('|'));
        if (m) {
            row.match = product(m);
            row.category = m.ihf ? 'unchanged' : 'flag';
            row.action = m.ihf ? 'skip' : 'flag';
            out.push(row); counts[row.category]++; continue;
        }
        // 3. same generic + brand. A twin whose form and strength match once
        //    spelling is set aside is the same product, decided for the
        //    reviewer: already in Bizbox -> unchanged, else -> mark it. A twin
        //    that only matches by form FAMILY (AMPOULE vs Solution for
        //    injection) is a suggestion the reviewer confirms. Other strengths
        //    of the brand make it a new product, with those listed beside it.
        const sibs = (byGenBrand.get(genericKey(generic) + '|' + norm(sp.brand)) || []).filter((r) => !claimed.has(rowKey(r)));
        const ranked = [...sibs].sort((a, b) => (Number(b.ihf) - Number(a.ihf)) || (Number(b.lg === lg) - Number(a.lg === lg)));
        const exact = ranked.find((r) => (formKey(r.f) === formKey(sp.form) || (baseForm(r.f) && baseForm(r.f) === baseForm(sp.form)) || !String(r.f).trim()) && sameStrength(r, sp));
        const doubtful = sp.warnings.length && !(sp.warnings.length === 1 && sp.warnings[0] === 'no strength' && sp.form && sp.brand);
        if (exact && !doubtful) {
            claimed.add(rowKey(exact));
            row.match = product(exact);
            row.category = exact.ihf ? 'unchanged' : 'flag';
            row.action = exact.ihf ? 'skip' : 'same';
            out.push(row); counts[row.category]++; continue;
        }
        const family = exact || ranked.find((r) => sameForm(r.f, sp.form) && sameStrength(r, sp));
        if (family) {
            claimed.add(rowKey(family));
            row.match = product(family); row.category = 'same'; row.action = 'review';
            row.siblings = ranked.filter((r) => r !== family).slice(0, 5).map(product);
            out.push(row); counts.same++; continue;
        }
        if (doubtful) {
            // doubtful split. One exception: "BRAND TABLET" with no strength is
            // a real pattern (multivitamins) — that is New, not a problem.
            row.category = 'attention'; row.action = 'review';
            row.siblings = ranked.slice(0, 6).map(product);
            out.push(row); counts.attention++; continue;
        }
        if (sibs.length) {
            row.category = 'similar'; row.action = 'new';
            row.note = row.note ? row.note + '; other strengths of this brand exist' : 'other strengths of this brand exist';
            row.siblings = ranked.slice(0, 6).map(product);
            out.push(row); counts.similar++; continue;
        }
        if (!generics.has(lg)) row.note = row.note ? row.note + '; new generic' : 'new generic';
        // exact-by-description rows above also count as claimed, so a later
        // line cannot be linked onto them either
        if (row.match) claimed.add([norm(row.match.generic), norm(row.match.brand), norm(row.match.form), norm(row.match.strength)].join('|'));
        row.category = 'new'; row.action = 'new';
        out.push(row); counts.new++;

        if ((i + 1) % BATCH === 0) {
            const job = await db.getImport(id, { withRows: false });
            if (!job || job.status === 'cancelled') return;
            await db.updateImport(id, { processed: i + 1, summary: { ...job.summary, counts: { ...counts }, heartbeat: Date.now() } });
        }
    }
    const job = await db.getImport(id, { withRows: false });
    if (!job || job.status === 'cancelled') return;
    await db.updateImport(id, {
        status: 'awaiting_review', processed: sheet.length,
        rows: { sheet: undefined, items: out },
        summary: { ...job.summary, counts, heartbeat: Date.now(), analyzedAt: Date.now() },
    });
}

// Supplies: match by Bizbox code first (a code never changes when Bizbox
// rewords an item), then by wording (a supply a nurse typed has no code).
//   unchanged  in the list and In Bizbox — only the wording is refreshed
//   flag       in the list but not marked (typed by a nurse, or removed)
//   new        nothing like it
// The row keeps the medicine field names: generic carries the description,
// so the shared review screen and "left to decide" count need no branch.
async function runAnalyzeSupplies(id, sheet, codeCol, descCol) {
    const all = await db.getAllSupplies();
    // a live row wins over a removed one for the same code or wording
    const rank = (r) => (r.deletedAt ? 0 : 1) + (r.inBizbox ? 2 : 0);
    const byCode = new Map(), byDesc = new Map();
    for (const r of all) {
        const ck = norm(r.code), dk = norm(r.description);
        if (ck && (!byCode.has(ck) || rank(r) > rank(byCode.get(ck)))) byCode.set(ck, r);
        if (dk && (!byDesc.has(dk) || rank(r) > rank(byDesc.get(dk)))) byDesc.set(dk, r);
    }
    const excluded = new Map((await db.getExclusions()).map((x) => [x.key, x]));
    const seen = new Set();
    const out = [];
    const counts = emptyCounts();
    for (let i = 0; i < sheet.length; i++) {
        const cells = sheet[i];
        const description = String(cells[descCol] || '').replace(/\s+/g, ' ').trim();
        const code = codeCol >= 0 ? String(cells[codeCol] || '').trim() : '';
        const row = { i, kind: 'supply', code, generic: description, description, brand: '', form: '', strength: '', volumeMl: null, warnings: [], category: 'new', action: 'new', match: null, siblings: [], note: '' };
        const skip = (note, extra = {}) => { Object.assign(row, { category: 'excluded', excluded: true, action: 'skip', note }, extra); out.push(row); counts.excluded++; };
        if (!description) { skip('blank description'); continue; }
        if (excluded.has(db.exclusionKey(description))) { skip('excluded last time', { remember: true }); continue; }
        const dupKey = code ? 'c|' + norm(code) : 'd|' + norm(description);
        if (seen.has(dupKey)) { skip('duplicate line in this file'); continue; }
        seen.add(dupKey);

        const m = (code && byCode.get(norm(code))) || byDesc.get(norm(description));
        if (m) {
            row.match = { id: m.id, code: m.code, generic: m.description, description: m.code || '', ihf: m.inBizbox && !m.deletedAt, removed: !!m.deletedAt };
            const live = m.inBizbox && !m.deletedAt;
            row.category = live ? 'unchanged' : 'flag';
            row.action = live ? 'skip' : 'flag';
            const notes = [];
            if (norm(m.description) !== norm(description)) notes.push(`was "${m.description}"`);
            if (m.deletedAt) notes.push('was removed — comes back');
            row.note = notes.join('; ');
        }
        out.push(row); counts[row.category]++;

        if ((i + 1) % BATCH === 0) {
            const job = await db.getImport(id, { withRows: false });
            if (!job || job.status === 'cancelled') return;
            await db.updateImport(id, { processed: i + 1, summary: { ...job.summary, counts: { ...counts }, heartbeat: Date.now() } });
        }
    }
    const job = await db.getImport(id, { withRows: false });
    if (!job || job.status === 'cancelled') return;
    await db.updateImport(id, {
        status: 'awaiting_review', processed: sheet.length,
        rows: { sheet: undefined, items: out },
        summary: { ...job.summary, counts, heartbeat: Date.now(), analyzedAt: Date.now() },
    });
}

// ----- review -----
const get = async (id, { withRows = false } = {}) => {
    const job = await db.getImport(id, { withRows });
    if (!job) throw httpError(404, 'Import not found');
    // a worker that died mid-job leaves the status hanging; the page must not spin forever
    if ((job.status === 'analyzing' || job.status === 'applying') && Date.now() - (job.summary.heartbeat || job.startedAt) > STALE_MS) {
        await db.updateImport(id, { status: 'failed', finishedAt: Date.now(), summary: { ...job.summary, error: 'The server stopped while working on this import. Upload the file again.' } });
        job.status = 'failed'; job.summary.error = 'The server stopped while working on this import. Upload the file again.';
    }
    if (withRows && job.rows) job.rows = job.rows.items || [];
    return job;
};

const list = () => db.listImports(40);

// decisions: [{ i, action, generic, brand, form, strength, exclude, remember }]
// merged into the stored rows; a row the reviewer edited is re-classified
// against the catalog so the tabs stay honest
const saveDecisions = async (id, decisions, actor) => {
    const job = await db.getImport(id);
    if (!job) throw httpError(404, 'Import not found');
    if (job.status !== 'awaiting_review') throw httpError(409, 'This import is not open for review');
    if (!Array.isArray(decisions) || !decisions.length) return { updated: 0 };
    const items = job.rows.items || [];
    const byI = new Map(items.map((r) => [r.i, r]));
    if (!catalogCache.isLoaded()) await catalogCache.reload();
    const cat = catalogCache.all() || [];
    const byKey = new Map(cat.filter((r) => r.b || r.f || r.s).map((r) => [[r.lg, r.lb, r.lf, r.ls].join('|'), r]));
    let updated = 0;
    for (const d of decisions) {
        const row = byI.get(Number(d.i));
        if (!row) continue;
        let edited = false;
        for (const f of ['generic', 'brand', 'form', 'strength']) {
            if (d[f] !== undefined && String(d[f]).trim() !== row[f]) { row[f] = String(d[f]).replace(/\s+/g, ' ').trim(); edited = true; }
        }
        if (edited) {
            const m = byKey.get([norm(row.generic), norm(row.brand), norm(row.form), norm(row.strength)].join('|'));
            row.match = m ? { generic: m.g, brand: m.b, form: m.f, strength: m.s, description: m.d, ihf: m.ihf } : null;
            row.warnings = [];
            if (!row.generic) row.warnings.push('no generic');
            if (!row.form && !row.strength) row.warnings.push('no form or strength');
            row.edited = true;
            row.action = m ? (m.ihf ? 'skip' : 'flag') : 'new';
        }
        if (d.exclude !== undefined) {
            row.excluded = !!d.exclude;
            row.remember = !!d.remember && !!d.exclude;
            if (row.excluded) row.action = 'skip';
            else if (row.action === 'skip' && row.category !== 'unchanged') row.action = row.match ? (row.match.ihf ? 'skip' : 'flag') : 'new';
        }
        if (d.action !== undefined && ['flag', 'same', 'new', 'skip', 'review'].includes(d.action)) {
            row.action = d.action;
            if (d.action === 'same' && !row.match && d.sameAs) row.match = d.sameAs;
        }
        row.decidedBy = actor && actor.name;
        updated++;
    }
    await db.updateImport(id, { rows: { items } });
    return { updated };
};

// still needs a person: undecided, or set to create/link with no generic to file it under
const remainingToReview = (items) => items.filter((r) => !r.excluded && (r.action === 'review' || (r.action !== 'skip' && !r.generic))).length;

// ----- apply -----
const apply = async (id, actor) => {
    const job = await db.getImport(id);
    if (!job) throw httpError(404, 'Import not found');
    if (job.status !== 'awaiting_review') throw httpError(409, 'This import is not ready to apply');
    const items = job.rows.items || [];
    const left = remainingToReview(items);
    if (left) throw httpError(400, `${left} row${left === 1 ? '' : 's'} still need${left === 1 ? 's' : ''} a decision under Needs attention`);
    if (!items.some((r) => r.generic && r.action !== 'skip' && r.action !== 'review' && !r.excluded) && !items.some((r) => r.category === 'unchanged')) throw httpError(400, 'Nothing to apply');
    await db.updateImport(id, { status: 'applying', processed: 0, total: items.length, summary: { ...job.summary, heartbeat: Date.now(), appliedBy: actor && actor.name } });
    const run = job.summary.kind === 'supply' ? runApplySupplies : runApply;
    setImmediate(() => run(id, items, actor).catch((e) => fail(id, e)));
    return { id };
};

async function runApply(id, items, actor) {
    const now = Date.now();
    const result = { flagged: 0, created: 0, linked: 0, unchanged: 0, skipped: 0, excluded: 0, remembered: 0 };
    for (let i = 0; i < items.length; i++) {
        const r = items[i];
        try {
            if (r.excluded || r.category === 'excluded') {
                result.excluded++;
                if (r.remember && r.description) { await db.addExclusion({ description: r.description, excludedBy: actor && actor.name }); result.remembered++; }
            } else if (r.action === 'skip' && r.category === 'unchanged' && r.match) {
                // still listed: stamp it seen and take Bizbox's own wording
                await db.addToCatalog({ genericName: r.match.generic, brandName: r.match.brand, formName: r.match.form, strength: r.match.strength, description: r.description, seenAt: now, skipInvalidate: true });
                result.unchanged++;
            } else if (r.action === 'skip' || r.action === 'review' || !r.generic) {
                result.skipped++;
            } else if ((r.action === 'flag' || r.action === 'same') && r.match) {
                await db.addToCatalog({ genericName: r.match.generic, brandName: r.match.brand, formName: r.match.form, strength: r.match.strength, description: r.description, volumeMl: r.volumeMl, seenAt: now, skipInvalidate: true });
                r.action === 'flag' ? result.flagged++ : result.linked++;
            } else {
                await db.addToCatalog({ genericName: r.generic, brandName: r.brand, formName: r.form, strength: r.strength, description: r.description, volumeMl: r.volumeMl, seenAt: now, skipInvalidate: true });
                result.created++;
            }
            r.applied = true;
        } catch (e) {
            r.error = e.message;
            result.skipped++;
        }
        if ((i + 1) % BATCH === 0) {
            const job = await db.getImport(id, { withRows: false });
            if (!job || job.status === 'cancelled') return;
            await db.updateImport(id, { processed: i + 1, summary: { ...job.summary, heartbeat: Date.now(), result: { ...result } } });
        }
    }
    catalogCache.invalidate();
    const missing = await db.productsNotSeenSince(now);
    const job = await db.getImport(id, { withRows: false });
    await db.updateImport(id, {
        status: 'done', processed: items.length, finishedAt: Date.now(),
        rows: { items },
        summary: { ...job.summary, heartbeat: Date.now(), result, missingCount: missing.length, missing: missing.slice(0, 500).map((m) => ({ generic: m.generic, description: m.description, seenAt: m.seenAt })) },
    });
    await db.addAudit({
        action: 'catalog_import', drug: job.file, reason: null,
        status: `flagged ${result.flagged}, created ${result.created}, linked ${result.linked}, unchanged ${result.unchanged}, excluded ${result.excluded}, missing from file ${missing.length}`,
        actor: actor && actor.name, authorizedBy: actor && actor.name,
    });
}

async function runApplySupplies(id, items, actor) {
    const now = Date.now();
    const result = { flagged: 0, created: 0, linked: 0, unchanged: 0, skipped: 0, excluded: 0, remembered: 0 };
    for (let i = 0; i < items.length; i++) {
        const r = items[i];
        try {
            if (r.excluded || r.category === 'excluded') {
                result.excluded++;
                if (r.remember && r.description) { await db.addExclusion({ description: r.description, excludedBy: actor && actor.name }); result.remembered++; }
            } else if (r.action === 'skip' && r.category === 'unchanged' && r.match) {
                // still listed: stamp it seen and take Bizbox's own wording
                await db.addSupplyToCatalog({ id: r.match.id, code: r.code, description: r.description, seenAt: now });
                result.unchanged++;
            } else if (r.action === 'skip' || r.action === 'review') {
                result.skipped++;
            } else if ((r.action === 'flag' || r.action === 'same') && r.match) {
                await db.addSupplyToCatalog({ id: r.match.id, code: r.code, description: r.description, seenAt: now });
                result.flagged++;
            } else {
                await db.addSupplyToCatalog({ code: r.code, description: r.description, seenAt: now });
                result.created++;
            }
            r.applied = true;
        } catch (e) {
            r.error = e.message;
            result.skipped++;
        }
        if ((i + 1) % BATCH === 0) {
            const job = await db.getImport(id, { withRows: false });
            if (!job || job.status === 'cancelled') return;
            await db.updateImport(id, { processed: i + 1, summary: { ...job.summary, heartbeat: Date.now(), result: { ...result } } });
        }
    }
    const missing = await db.suppliesNotSeenSince(now);
    const job = await db.getImport(id, { withRows: false });
    await db.updateImport(id, {
        status: 'done', processed: items.length, finishedAt: Date.now(),
        rows: { items },
        summary: { ...job.summary, heartbeat: Date.now(), result, missingCount: missing.length, missing: missing.slice(0, 500).map((m) => ({ generic: m.description, description: m.code || '', seenAt: m.seenAt })) },
    });
    await db.addAudit({
        action: 'catalog_import', drug: job.file, reason: null,
        status: `supplies: marked ${result.flagged}, created ${result.created}, unchanged ${result.unchanged}, excluded ${result.excluded}, missing from file ${missing.length}`,
        actor: actor && actor.name, authorizedBy: actor && actor.name,
    });
}

const cancel = async (id) => {
    const job = await db.getImport(id, { withRows: false });
    if (!job) throw httpError(404, 'Import not found');
    if (job.status === 'done') throw httpError(409, 'This import is already applied');
    await db.updateImport(id, { status: 'cancelled', finishedAt: Date.now() });
    return { id };
};

// every row and what was decided, as CSV — the audit copy
const reportCsv = async (id) => {
    const job = await db.getImport(id);
    if (!job) throw httpError(404, 'Import not found');
    const items = (job.rows && job.rows.items) || [];
    const cell = (v) => { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const lines = [['Row', 'Generic', 'Bizbox description', 'Brand', 'Form', 'Strength', 'Code', 'Category', 'Action', 'Matched product', 'Warnings', 'Note', 'Decided by', 'Applied', 'Error'].join(',')];
    for (const r of items) {
        lines.push([r.i + 2, r.kind === 'supply' ? '' : r.generic, r.description, r.brand, r.form, r.strength, r.code || '', r.category, r.excluded ? 'excluded' : r.action,
            r.match ? `${r.match.generic} — ${r.match.description || [r.match.brand, r.match.strength, r.match.form].filter(Boolean).join(' ')}` : '',
            (r.warnings || []).join('; '), r.note || '', r.decidedBy || '', r.applied ? 'yes' : '', r.error || ''].map(cell).join(','));
    }
    return { file: `bizbox-import-${id}.csv`, csv: lines.join('\n') };
};

const exclusions = () => db.getExclusions();
const forgetExclusion = (key) => db.removeExclusion(key);

module.exports = { createFromUpload, analyze, get, list, saveDecisions, apply, cancel, reportCsv, exclusions, forgetExclusion };
