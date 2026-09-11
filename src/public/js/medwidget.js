/* The medicine widget: Generic + one "Brand / Form / Strength" box, the way
 * Bizbox lists a product, with the three fields behind it for a medicine
 * Bizbox does not have. Shared by the nurse page (Add panel + Edit dialog)
 * and the pharmacy's Add Medicine dialog, so the search, the debounce, the
 * split logic and the Bizbox line exist once.
 *
 *   MedWidget.create({ p, sg, statusId, noteId, splitNoteId, clearsBelow, confirmBizbox })
 *     p / sg         id prefix of the inputs / of their suggestion boxes
 *                    (inputs: generic, combo, brand, form, strength, nobrand,
 *                    and optionally oos, vol, qty, sig)
 *     clearsBelow    changing the generic clears the product (Add panel: yes,
 *                    Edit dialog: no)
 *     confirmBizbox  ask "already in Bizbox, are you sure?" on picking a Bizbox
 *                    generic/product (nurse: yes; pharmacy adding to Bizbox: no)
 *   MedWidget.fetchProduct(values)  -> { ok, product }
 *   MedWidget.missingField(widget, values) -> null | field to focus
 *
 * Needs api.js (api, escapeHtml, showDialog) and split.js (splitDescription).
 */
(function (global) {
    const $ = (id) => document.getElementById(id);

    // ----- the catalog's form names: the Form field's fallback list and the splitter's dictionary -----
    let formNames = [];
    api('/api/rx/forms').then((r) => { if (r.ok) formNames = r.data.forms || []; }).catch(() => {});

    // ----- medicine search -----
    // Searching happens on the server (/api/rx/suggest). This page used to pull
    // the whole catalog — ~34k combinations, 5.2 MB — and filter it here, which
    // meant every keystroke in Brand rebuilt and re-sorted 24k names on the main
    // thread. Typing lagged and holding backspace locked the tab up hard enough
    // that the only way out was closing the browser. Now each keystroke is
    // debounced, superseded by the next one, and answered with at most 50 rows.
    //
    // Fields: generic, then ONE box for brand/form/strength ("combo") that
    // searches the product the way Bizbox writes it — "ALLERKID 5MG/5ML 60ML
    // SYRUP". brand/form/strength are the separate fields behind it, shown
    // only when the nurse types something Bizbox does not list, or ticks No
    // brand.
    const FIELDS = ['generic', 'combo', 'brand', 'form', 'strength'];
    // a field is narrowed only by the fields above it
    const PARENTS = { generic: [], combo: ['generic'], brand: ['generic'], form: ['generic', 'brand'], strength: ['generic', 'brand', 'form'] };

    const DEBOUNCE_MS = 120;
    const MIN_Q = 2;
    // Mirrors db.suggestWorthRunning() on the server. A "contains" search cannot
    // use an index, so an empty box asks Postgres to read the whole catalog —
    // and resetBuilder() focuses Generic after every Add, which fired exactly
    // that on the way into the next medicine. An empty box still earns a query
    // when a parent narrows it ("every product of this generic"); otherwise
    // the nurse types two letters first.
    const worthSearching = (field, s) => s[field].length >= MIN_Q || PARENTS[field].some((p) => s[p]);
    const CACHE_MAX = 200;          // backspacing walks back through queries already answered

    const optCache = new Map();
    function remember(cache, key, value) {
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
        cache.set(key, value);
        return value;
    }

    // in-flight requests for a field are aborted by the next keystroke, so a
    // slow reply can never repaint over a newer one. `aborts` belongs to the
    // widget that asked: the Add panel and the edit dialog must never cancel
    // each other's lookups.
    async function fetchOptions(field, s, aborts) {
        const params = new URLSearchParams({ field, q: s[field] });
        PARENTS[field].forEach((p) => { if (s[p]) params.set(p, s[p]); });
        const key = params.toString();
        if (optCache.has(key)) return optCache.get(key);
        if (aborts[field]) aborts[field].abort();
        aborts[field] = new AbortController();
        const res = await api(`/api/rx/suggest?${key}`, { signal: aborts[field].signal });
        if (!res.ok) return [];
        return remember(optCache, key, res.data.options || []);
    }

    // -> { ok, product } — ok:false means we could not reach the server. Never
    // treat that as "not in Bizbox"; that is a clinical claim.
    // Deliberately NOT cached, unlike the suggestions above. This is the Bizbox
    // answer — a clinical claim — so it is asked fresh every time. The browser
    // used to remember it for the life of the page, which meant a medicine
    // added to Bizbox mid-shift kept reading "not in Bizbox" off a note taken
    // before the approval, until someone reloaded. The cost is a handful of
    // exact, indexed lookups per medicine (this only fires once the product is
    // fully described), which is affordable now that autocomplete no longer
    // touches the database at all.
    async function fetchProduct(s) {
        const params = new URLSearchParams({ generic: s.generic, brand: s.brand, form: s.form, strength: s.strength });
        const res = await api(`/api/rx/product?${params}`);
        if (!res.ok) return { ok: false, product: null };
        return { ok: true, product: res.data.product || null };
    }

    const bizBadges = (o) => `<span class="badges">${o.pnf ? '<span class="badge navy" title="In the Philippine National Formulary">PNF</span>' : ''}<span class="badge ${o.ihf ? 'green' : 'amber'}">${o.ihf ? 'In Bizbox' : 'Not in Bizbox'}</span></span>`;

    // The two-step check the pharmacy asked for: a nurse who picks a medicine
    // Bizbox already carries is told so and asked again. Anything prescribed
    // here should be something Bizbox would not release.
    const confirmInBizbox = (what) => showDialog({
        kind: 'warn', title: 'Already in Bizbox',
        message: `${what} is already in Bizbox.\nAre you sure you want to select it here?`,
        actions: [
            { label: 'Yes, select it', value: true, variant: 'primary' },
            { label: 'No', value: false, variant: 'ghost', cancel: true },
        ],
    });

    // Two of these exist — the Add panel and the edit dialog. They are the same
    // widget over different inputs, so the search, the debounce, the abort
    // handling, the split logic and the Bizbox line are written once here, and
    // the two instances differ only by which element ids they drive.
    //   p / sg: id prefix of the inputs / of their suggestion boxes
    //   clearsBelow: changing the generic empties the product under it. Right
    //     when you are narrowing a medicine down from nothing, wrong when you
    //     are correcting one that already exists — the edit dialog leaves the
    //     product be and lets the Bizbox line (and the check on Save) judge.
    //
    // Modes (which fields are visible; CSS reads .mode-* on the row):
    //   search  — generic + the combo box. The normal case.
    //   split   — the combo text matches nothing Bizbox lists: brand, form and
    //             strength open under it, prefilled by splitDescription(), for
    //             the nurse to confirm. Once she edits one, the combo box locks
    //             and shows the stitched result — what will be saved.
    //   nobrand — "No brand" ticked: generic + form + strength, no combo box.
    function createWidget({ p, sg, statusId, noteId, splitNoteId, clearsBelow = true, confirmBizbox = true, active = () => true }) {
        const el = (f) => $(p + f);
        const box = (f) => $(sg + f);
        const fields = el('generic').closest('.mb-fields');
        // qty/sig/vol/oos are the nurse's; the pharmacy's Add Medicine dialog
        // has none of them, so a missing input reads as blank and writes nowhere
        const stub = () => ({ value: '', checked: false, addEventListener() {} });
        const noBrand = el('nobrand') || stub(), oos = el('oos') || stub();
        const vol = el('vol') || stub(), qty = el('qty') || stub(), sig = el('sig') || stub();
        const timers = {}, seqs = {}, aborts = {};
        let statusSeq = 0;
        let picked = null;          // the catalog product chosen from the combo list
        let touched = false;        // the nurse edited brand/form/strength herself
        let noMatch = false;        // the last combo search came back empty
        let confirmedKey = '';      // last Bizbox pick she said yes to — no double prompt

        // split only once the list has nothing for what was typed — while
        // suggestions are still matching the nurse is meant to pick one
        const mode = () => (noBrand.checked ? 'nobrand' : (!picked && el('combo').value.trim() && (noMatch || touched)) ? 'split' : 'search');

        function applyMode() {
            const m = mode();
            fields.classList.remove('mode-search', 'mode-split', 'mode-nobrand');
            fields.classList.add('mode-' + m);
            const note = $(splitNoteId);
            if (m === 'split') {
                note.innerHTML = 'Not in the Bizbox list — check the brand, form and strength below before adding.'
                    + (touched ? '<a href="#" data-reset>Start over</a>' : '');
                note.style.display = 'block';
                const reset = note.querySelector('[data-reset]');
                if (reset) reset.addEventListener('click', (e) => { e.preventDefault(); resetProduct(); el('combo').focus(); });
            } else {
                note.style.display = 'none';
            }
            const lock = m === 'split' && touched;
            el('combo').readOnly = lock;
            el('combo').classList.toggle('locked', lock);
        }

        // what the inputs literally say — what the searches are narrowed by
        const raw = () => {
            const v = {};
            FIELDS.forEach((f) => { v[f] = el(f).value.trim(); });
            if (noBrand.checked) v.brand = '';
            return v;
        };

        // what would be saved: generic + brand/form/strength + the description
        const values = () => {
            const m = mode();
            const r = raw();
            const v = { generic: r.generic, picked: !!picked && m === 'search' };
            if (v.picked) { v.brand = picked.brand; v.form = picked.form; v.strength = picked.strength; v.description = picked.value; }
            else { v.brand = m === 'nobrand' ? '' : r.brand; v.form = r.form; v.strength = r.strength; v.description = ''; }
            if (!v.description) v.description = splitDescription.stitch({ brand: v.brand, strength: v.strength, form: v.form });
            v.volumeMl = Number(vol.value) > 0 ? Number(vol.value) : null;
            v.outOfStock = oos.checked;
            v.quantity = Number(qty.value) || 1;
            v.sig = sig.value.trim();
            return v;
        };

        function resetProduct() {
            picked = null; touched = false; noMatch = false;
            ['combo', 'brand', 'form', 'strength'].forEach((f) => { el(f).value = ''; });
            applyMode(); scheduleStatus();
        }

        // split mode, untouched: the three fields follow the combo text
        function prefill() {
            if (mode() !== 'split' || touched) return;
            const sp = splitDescription(el('combo').value, { forms: formNames, generic: el('generic').value });
            el('brand').value = sp.brand; el('form').value = sp.form; el('strength').value = sp.strength;
            if (sp.volumeMl != null && !vol.value) vol.value = sp.volumeMl;
        }
        // split mode, touched: the combo box shows the stitched fields
        function syncCombo() {
            if (mode() !== 'split') return;
            const r = raw();
            el('combo').value = splitDescription.stitch({ brand: r.brand, strength: r.strength, form: r.form });
        }

        function showSuggest(field) {
            clearTimeout(timers[field]);
            timers[field] = setTimeout(() => runSuggest(field), DEBOUNCE_MS);
        }
        async function runSuggest(field) {
            const b = box(field);
            const s = raw();
            // claim the sequence even when we are not going to search: a request
            // fired at two letters must not land after a backspace drops us below
            // the threshold and repaint the box with rows for a query that is gone
            const mine = seqs[field] = (seqs[field] || 0) + 1;
            if (!worthSearching(field, s)) {
                if (aborts[field]) aborts[field].abort();
                b.innerHTML = `<div class="opt hint">Type ${MIN_Q} letters to search…</div>`;
                b.style.display = document.activeElement === el(field) ? 'block' : 'none';
                return;
            }
            let opts;
            try { opts = await fetchOptions(field, s, aborts); }
            catch { return; }                                   // aborted or offline: leave the list alone
            if (mine !== seqs[field]) return;                   // a newer keystroke already won
            // the answer that decides whether the three fields open: Bizbox
            // has nothing like what was typed, so it is a new medicine
            if (field === 'combo' && !picked) {
                const empty = !opts.length;
                if (empty !== noMatch) { noMatch = empty; prefill(); applyMode(); scheduleStatus(); }
            }
            if (document.activeElement !== el(field)) { b.style.display = 'none'; return; }
            // a brand Bizbox does not know narrows Form to nothing — fall back
            // to every form the catalog has, so the nurse still picks a real one
            if (field === 'form' && !opts.length && formNames.length) {
                const q = s.form.toLowerCase();
                opts = formNames.filter((f) => f.toLowerCase().includes(q)).slice(0, 50).map((f) => ({ value: f, ihf: false, pnf: false, plain: true }));
            }
            if (!opts.length) { b.style.display = 'none'; return; }
            b.innerHTML = opts.map((o, i) => `<div class="opt" data-i="${i}"><span>${escapeHtml(o.value)}</span>`
                + (field === 'combo' && !s.generic && o.soleGeneric ? `<span class="sub">${escapeHtml(o.soleGeneric)}</span>` : '')
                + (o.plain ? '' : bizBadges(o)) + '</div>').join('');
            b.style.display = 'block';
            b.querySelectorAll('.opt').forEach((node) => {
                node.addEventListener('mousedown', (e) => { e.preventDefault(); pick(field, opts[Number(node.dataset.i)], s); });
            });
        }

        async function pick(field, o, s) {
            box(field).style.display = 'none';
            // the Bizbox confirmation — for the generic and for the product
            if (confirmBizbox && (field === 'generic' || field === 'combo') && o.ihf) {
                const key = field + '|' + o.value;
                if (confirmedKey !== key) {
                    const what = field === 'generic' ? o.value : `${s.generic || o.soleGeneric || ''} ${o.value}`.trim();
                    const yes = await confirmInBizbox(what);
                    if (!yes) {
                        el(field).value = '';
                        if (field === 'combo') { picked = null; touched = false; noMatch = false; }
                        applyMode(); scheduleStatus(); el(field).focus();
                        return;
                    }
                    confirmedKey = key;
                }
            }
            el(field).value = o.value;
            if (field === 'generic') {
                if (clearsBelow) resetProduct();
            } else if (field === 'combo') {
                picked = o; touched = false; noMatch = false;
                el('brand').value = o.brand || ''; el('form').value = o.form || ''; el('strength').value = o.strength || '';
                if (o.volumeMl != null && !vol.value) vol.value = o.volumeMl;
                // a product that belongs to exactly one generic fills the generic in
                if (o.soleGeneric && !el('generic').value.trim()) el('generic').value = o.soleGeneric;
            } else {
                touched = true;
                if (field === 'brand' && o.soleGeneric && !el('generic').value.trim()) el('generic').value = o.soleGeneric;
                syncCombo();
            }
            applyMode(); scheduleStatus();
        }

        const scheduleStatus = () => { clearTimeout(timers.status); timers.status = setTimeout(updateStatus, DEBOUNCE_MS); };

        async function updateStatus() {
            if (!active()) return;          // the Supply box has the status line
            const s = values(); const st = $(statusId); const note = $(noteId);
            const mine = ++statusSeq;
            note.style.display = 'none';
            if (!s.generic) { st.textContent = ''; st.className = 'mb-status'; return; }
            if (!s.picked && !(s.form && s.strength)) {
                st.textContent = mode() === 'search' ? (el('combo').value.trim() ? 'pick from the list' : 'pick the brand / form / strength') : 'fill in form & strength';
                st.className = 'mb-status muted'; return;
            }

            const { ok, product: c } = await fetchProduct(s).catch(() => ({ ok: false, product: null }));
            if (mine !== statusSeq || !active()) return;        // the fields moved on while we asked
            if (!ok) { st.textContent = '… could not check — server unreachable'; st.className = 'mb-status muted'; return; }

            // liquids with a known volume (vaccines, IV bottles) prefill the Vol input
            if (c && c.volumeMl != null && !vol.value) vol.value = c.volumeMl;
            const bits = [];
            if (c && c.inFormulary) {
                st.textContent = 'In Bizbox'; st.className = 'mb-status ok';
                bits.push(c.inPnf ? 'In the PNF.' : 'Not in the PNF.');
            } else {
                st.textContent = 'NOT in Bizbox'; st.className = 'mb-status new';
                if (c) bits.push(c.inPnf ? 'In the PNF.' : 'Not in the PNF.');
            }
            if (c && c.registrationNumber) bits.push(`Reg. No. ${c.registrationNumber}`);
            if (bits.length) { note.textContent = bits.join(' '); note.style.display = 'block'; }
        }

        // ---- wiring ----
        el('generic').addEventListener('input', () => {
            if (clearsBelow) resetProduct();
            showSuggest('generic'); scheduleStatus();
        });
        el('combo').addEventListener('input', () => {
            picked = null; touched = false;         // typing again abandons the pick
            if (!el('combo').value.trim()) noMatch = false;
            prefill(); applyMode(); showSuggest('combo'); scheduleStatus();
        });
        ['brand', 'form', 'strength'].forEach((f) => {
            el(f).addEventListener('input', () => {
                touched = true; syncCombo(); applyMode();
                showSuggest(f); scheduleStatus();
            });
        });
        FIELDS.forEach((f) => {
            el(f).addEventListener('focus', () => { if (!el(f).readOnly) showSuggest(f); });
            el(f).addEventListener('blur', () => setTimeout(() => { box(f).style.display = 'none'; }, 150));
        });
        noBrand.addEventListener('change', () => {
            picked = null; touched = false; noMatch = false;
            el('combo').value = ''; el('brand').value = '';
            if (!noBrand.checked) { el('form').value = ''; el('strength').value = ''; }
            applyMode(); scheduleStatus();
            el(noBrand.checked ? 'form' : 'combo').focus();
        });
        oos.addEventListener('change', scheduleStatus);

        applyMode();
        return {
            values, mode, updateStatus,
            hideBoxes: () => FIELDS.forEach((f) => { box(f).style.display = 'none'; }),
            focus: (field) => el(field).focus(),
            reset: () => {
                el('generic').value = ''; noBrand.checked = false; oos.checked = false;
                vol.value = ''; qty.value = '1'; sig.value = '';
                confirmedKey = '';
                resetProduct();
            },
            // load an existing line: a catalog pick becomes picked again, an
            // unbranded one opens in nobrand mode, anything else in split mode
            load: (it) => {
                el('generic').value = it.genericName || '';
                oos.checked = !!it.outOfStock;
                vol.value = it.volumeMl == null ? '' : it.volumeMl;
                qty.value = it.quantity; sig.value = it.sig || '';
                confirmedKey = '';
                picked = null; touched = false; noMatch = false;
                el('brand').value = it.brandName || ''; el('form').value = it.formName || ''; el('strength').value = it.strength || '';
                if (!it.brandName) {
                    noBrand.checked = true; el('combo').value = '';
                } else if (it.fromCatalog) {
                    noBrand.checked = false;
                    picked = { value: it.description, brand: it.brandName, form: it.formName, strength: it.strength, volumeMl: it.volumeMl };
                    el('combo').value = it.description;
                } else {
                    noBrand.checked = false; touched = true;
                    el('combo').value = splitDescription.stitch({ brand: it.brandName, strength: it.strength, form: it.formName });
                }
                applyMode(); updateStatus();
            },
        };
    }

    // -> null when complete, else the field to send the caret to
    const missingField = (w, s) => {
        if (!s.generic) return 'generic';
        if (s.picked) return null;
        if (w.mode() === 'search') return 'combo';
        if (!s.form) return 'form';
        if (!s.strength) return 'strength';
        return null;
    };

    // The widget's markup, for pages that build their dialogs in script (the
    // pharmacy's Add Medicine and the resolve stepper). index.html carries the
    // same structure inline for the nurse. opts: { oos, vol, qty, sig } — which
    // of the nurse-only inputs to include.
    const html = (p, sg, opts = {}) => {
        const field = (f, label, extra = '', mode = '') => `
            <div class="search-wrap ${extra}" ${mode ? `data-mode="${mode}"` : ''}>
                <label for="${p}${f}">${label}</label>
                <input id="${p}${f}" autocomplete="off" placeholder="Enter ${label.toLowerCase()}…">
                <div class="suggestions" id="${sg}${f}" style="display:none"></div>
            </div>`;
        return `
            <div class="mb-fields">
                <div class="mb-row">
                    ${field('generic', 'Generic', 'mb-f2')}
                    <div class="search-wrap mb-f3" data-mode="search split nobrand">
                        <label for="${p}combo">Brand / Form / Strength</label>
                        <input id="${p}combo" autocomplete="off" placeholder="Enter brand, form, strength…">
                        <div class="suggestions" id="${sg}combo" style="display:none"></div>
                        <label class="mb-check under"><input type="checkbox" id="${p}nobrand"> No brand</label>
                    </div>
                    ${opts.oos ? `<label class="mb-check"><input type="checkbox" id="${p}oos"> Out of stock in Bizbox</label>` : ''}
                    ${opts.vol ? `<div class="mb-qty"><label for="${p}vol">Vol (mL)</label><input id="${p}vol" type="number" min="0" step="any" placeholder="—"></div>` : ''}
                    ${opts.qty ? `<div class="mb-qty"><label for="${p}qty">Qty</label><input id="${p}qty" type="number" min="1" value="1"></div>` : ''}
                </div>
                <div class="mb-row mb-row-split" data-mode="split nobrand">
                    ${field('brand', 'Brand', '', 'split')}
                    ${field('form', 'Form', '', 'split nobrand')}
                    ${field('strength', 'Strength', '', 'split nobrand')}
                </div>
            </div>
            <div id="${p}splitNote" class="mb-splitnote" style="display:none"></div>
            ${opts.sig ? `<div class="mb-row mb-row3"><div class="mb-sig"><label for="${p}sig">Sig (instructions — optional)</label><input id="${p}sig" autocomplete="off"></div></div>` : ''}`;
    };

    // ----- medical supplies: one box, the same Bizbox rules -----
    // Gloves, catheters, sutures... no generic/brand/form/strength, just the
    // description Bizbox lists (and its item code). Picking one Bizbox carries
    // asks the same "are you sure?"; typing one it does not carry is allowed
    // and prints bold, exactly like a medicine.
    //   SupplyBox.create({ p, sg, statusId, noteId, active })
    //     inputs: <p>supply (box), and the shared <p>oos / <p>qty / <p>sig
    //     active: () => bool — the Add panel shares its status line with the
    //             medicine widget, so only the kind on screen may write to it
    //   SupplyBox.fetchSupply({ description, code }) -> { ok, supply }
    async function fetchSupply(s) {
        const params = new URLSearchParams({ description: s.description || '', code: s.code || '' });
        const res = await api(`/api/rx/supply?${params}`);
        if (!res.ok) return { ok: false, supply: null };
        return { ok: true, supply: res.data.supply || null };
    }

    function createSupplyBox({ p, sg, statusId, noteId, active = () => true }) {
        const input = $(p + 'supply'), list = $(sg + 'supply');
        const stub = () => ({ value: '', checked: false });
        const oos = $(p + 'oos') || stub(), qty = $(p + 'qty') || stub(), sig = $(p + 'sig') || stub();
        let picked = null, confirmedKey = '', timer = null, statusTimer = null, seq = 0, statusSeq = 0, abort = null;

        const values = () => {
            const description = input.value.replace(/\s+/g, ' ').trim();
            const same = picked && picked.description.toLowerCase() === description.toLowerCase();
            return {
                description, code: same ? (picked.code || '') : '', picked: !!same,
                outOfStock: oos.checked, quantity: Number(qty.value) || 1, sig: sig.value.trim(),
            };
        };

        async function search() {
            const q = input.value.trim();
            const mine = ++seq;
            if (q.length < MIN_Q) {
                list.innerHTML = `<div class="opt hint">Type ${MIN_Q} letters to search…</div>`;
                list.style.display = document.activeElement === input ? 'block' : 'none';
                return;
            }
            if (abort) abort.abort();
            abort = new AbortController();
            let rows;
            try {
                const res = await api(`/api/rx/supplies?${new URLSearchParams({ q })}`, { signal: abort.signal });
                rows = res.ok ? (res.data.supplies || []) : [];
            } catch { return; }
            if (mine !== seq || document.activeElement !== input) { if (mine === seq) list.style.display = 'none'; return; }
            if (!rows.length) { list.style.display = 'none'; return; }
            list.innerHTML = rows.map((r, i) => `<div class="opt" data-i="${i}"><span>${escapeHtml(r.description)}</span>`
                + (r.code ? `<span class="sub">${escapeHtml(r.code)}</span>` : '')
                + `<span class="badges"><span class="badge ${r.inBizbox ? 'green' : 'amber'}">${r.inBizbox ? 'In Bizbox' : 'Not in Bizbox'}</span></span></div>`).join('');
            list.style.display = 'block';
            list.querySelectorAll('.opt').forEach((node) => {
                node.addEventListener('mousedown', (e) => { e.preventDefault(); pick(rows[Number(node.dataset.i)]); });
            });
        }

        async function pick(r) {
            list.style.display = 'none';
            if (r.inBizbox && confirmedKey !== r.description) {
                const yes = await confirmInBizbox(r.description);
                if (!yes) { input.value = ''; picked = null; scheduleStatus(); input.focus(); return; }
                confirmedKey = r.description;
            }
            input.value = r.description;
            picked = { description: r.description, code: r.code || '' };
            scheduleStatus();
        }

        const scheduleStatus = () => { clearTimeout(statusTimer); statusTimer = setTimeout(updateStatus, DEBOUNCE_MS); };
        async function updateStatus() {
            if (!active()) return;
            const s = values(); const st = $(statusId); const note = $(noteId);
            const mine = ++statusSeq;
            note.style.display = 'none';
            if (!s.description) { st.textContent = ''; st.className = 'mb-status'; return; }
            const { ok, supply } = await fetchSupply(s).catch(() => ({ ok: false, supply: null }));
            if (mine !== statusSeq || !active()) return;
            if (!ok) { st.textContent = '… could not check — server unreachable'; st.className = 'mb-status muted'; return; }
            const inBizbox = !!(supply && supply.inBizbox);
            st.textContent = inBizbox ? 'In Bizbox' : 'NOT in Bizbox';
            st.className = 'mb-status ' + (inBizbox ? 'ok' : 'new');
            if (supply && supply.code) { note.textContent = `Bizbox code ${supply.code}`; note.style.display = 'block'; }
        }

        input.addEventListener('input', () => {
            picked = null;
            clearTimeout(timer); timer = setTimeout(search, DEBOUNCE_MS);
            scheduleStatus();
        });
        input.addEventListener('focus', () => { if (input.value.trim().length >= MIN_Q) search(); });
        input.addEventListener('blur', () => setTimeout(() => { list.style.display = 'none'; }, 150));

        return {
            values, updateStatus,
            hideBoxes: () => { list.style.display = 'none'; },
            focus: () => input.focus(),
            reset: () => {
                input.value = ''; picked = null; confirmedKey = '';
                oos.checked = false; qty.value = '1'; sig.value = '';
                scheduleStatus();
            },
            load: (it) => {
                input.value = it.description || it.genericName || '';
                picked = it.fromCatalog ? { description: input.value, code: it.supplyCode || '' } : null;
                confirmedKey = '';
                oos.checked = !!it.outOfStock; qty.value = it.quantity; sig.value = it.sig || '';
                updateStatus();
            },
        };
    }

    global.MedWidget = { create: createWidget, fetchProduct, missingField, html, confirmInBizbox, formNames: () => formNames };
    global.SupplyBox = { create: createSupplyBox, fetchSupply };
})(window);
