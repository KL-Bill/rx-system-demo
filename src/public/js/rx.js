(async function () {
    const meRes = await api('/api/auth/me');
    if (meRes.ok) { window.location.href = '/dashboard'; return; }

    mountRail({ mode: 'nurse', active: 'rx' });

    const $ = (id) => document.getElementById(id);
    const items = [];   // { genericName, brandName, formName, strength, quantity, sig, isNew, inPnf, outOfStock }
    let savedRxId = null, dragFrom = null, masterDoctors = [];
    let localDoctors = JSON.parse(localStorage.getItem('rx_doctors') || '{}');

    // ----- stations -----
    const stationsRes = await api('/api/rx/stations');
    const stationSel = $('station');
    (stationsRes.data.stations || []).forEach((s) => {
        const o = document.createElement('option');
        o.value = s.id; o.textContent = `${s.name} (${s.department})`;
        stationSel.appendChild(o);
    });
    const hasOption = (v) => [...stationSel.options].some((o) => o.value === v);
    const urlStation = new URLSearchParams(location.search).get('station');
    const savedStation = localStorage.getItem('rx_station');
    if (urlStation && hasOption(urlStation)) {
        stationSel.value = urlStation; stationSel.disabled = true;
        localStorage.setItem('rx_station', urlStation);
        $('stationNote').innerHTML = 'Locked to this station. <a href="#" id="unlockStation">change</a>';
        $('unlockStation').onclick = (e) => { e.preventDefault(); localStorage.removeItem('rx_station'); location.href = '/'; };
    } else if (savedStation && hasOption(savedStation)) { stationSel.value = savedStation; }
    stationSel.addEventListener('change', () => { localStorage.setItem('rx_station', stationSel.value); renderPreview(); });

    // ----- doctors (master list + localStorage for PTR/S2 and remembered details) -----
    masterDoctors = (await api('/api/rx/doctors')).data.doctors || [];
    function mergedDoctors() {
        const map = new Map();
        masterDoctors.forEach((d) => map.set(d.name.toLowerCase(), { name: d.name, license: d.license || '', ptr: '', s2: '' }));
        Object.values(localDoctors).forEach((d) => {
            const k = d.name.toLowerCase(); const ex = map.get(k) || {};
            map.set(k, { name: d.name, license: d.license || ex.license || '', ptr: d.ptr || '', s2: d.s2 || '' });
        });
        return [...map.values()];
    }
    const docInput = $('doctor'), docSug = $('sg-doctor');
    function showDocSug() {
        const q = docInput.value.trim().toLowerCase();
        let list = mergedDoctors();
        if (q) list = list.filter((d) => d.name.toLowerCase().includes(q));
        list = list.slice(0, 40);
        if (!list.length) { docSug.style.display = 'none'; return; }
        docSug.innerHTML = list.map((d, i) => `<div class="opt" data-i="${i}"><span>${escapeHtml(d.name)}</span><span class="muted">${escapeHtml(d.license || '')}</span></div>`).join('');
        docSug.style.display = 'block';
        docSug.querySelectorAll('.opt').forEach((opt) => {
            opt.addEventListener('mousedown', (e) => {
                e.preventDefault();
                const d = list[Number(opt.dataset.i)];
                docInput.value = d.name; $('docLicense').value = d.license || ''; $('docPtr').value = d.ptr || ''; $('docS2').value = d.s2 || '';
                docSug.style.display = 'none'; renderPreview();
            });
        });
    }
    docInput.addEventListener('input', () => { showDocSug(); renderPreview(); });
    docInput.addEventListener('focus', showDocSug);
    docInput.addEventListener('blur', () => setTimeout(() => { docSug.style.display = 'none'; }, 150));
    function saveDoctor() {
        const name = docInput.value.trim(); if (!name) return;
        localDoctors[name.toLowerCase()] = { name, license: $('docLicense').value.trim(), ptr: $('docPtr').value.trim(), s2: $('docS2').value.trim() };
        localStorage.setItem('rx_doctors', JSON.stringify(localDoctors));
    }

    // ----- cascading builder (top-down: Generic -> Brand -> Form -> Strength) -----
    // Searching happens on the server (/api/rx/suggest). This page used to pull
    // the whole catalog — ~34k combinations, 5.2 MB — and filter it here, which
    // meant every keystroke in Brand rebuilt and re-sorted 24k names on the main
    // thread. Typing lagged and holding backspace locked the tab up hard enough
    // that the only way out was closing the browser. Now each keystroke is
    // debounced, superseded by the next one, and answered with at most 50 rows.
    const FIELDS = ['generic', 'brand', 'form', 'strength'];
    // a field is narrowed only by the fields above it in the cascade
    const PARENTS = { generic: [], brand: ['generic'], form: ['generic', 'brand'], strength: ['generic', 'brand', 'form'] };

    const DEBOUNCE_MS = 120;
    const MIN_Q = 2;
    // Mirrors db.suggestWorthRunning() on the server. A "contains" search cannot
    // use an index, so an empty box asks Postgres to read the whole catalog —
    // and resetBuilder() focuses Generic after every Add, which fired exactly
    // that on the way into the next medicine. An empty box still earns a query
    // when a parent narrows it ("every form this brand comes in"); otherwise
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
    // cascade that asked: the Add panel and the edit dialog must never cancel
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
    // treat that as "not in the Formulary"; that is a clinical claim.
    // Deliberately NOT cached, unlike the suggestions above. This is the
    // Formulary answer — a clinical claim — so it is asked fresh every time. The
    // browser used to remember it for the life of the page, which meant a
    // medicine approved by the pharmacy mid-shift kept reading "not in the
    // Formulary" off a note taken before the approval, until someone reloaded.
    // The cost is a handful of exact, indexed lookups per medicine (this only
    // fires once generic, form and strength are all filled), which is affordable
    // now that autocomplete no longer touches the database at all.
    async function fetchProduct(s) {
        const params = new URLSearchParams({ generic: s.generic, brand: s.brand, form: s.form, strength: s.strength });
        const res = await api(`/api/rx/product?${params}`);
        if (!res.ok) return { ok: false, product: null };
        return { ok: true, product: res.data.product || null };
    }

    // Two of these exist — the Add panel and the edit dialog. They are the same
    // widget over different inputs, so the search, the debounce, the abort
    // handling and the Formulary line are written once here, and the two
    // instances differ only by which element ids they drive.
    //   ids/sug: field -> element id of the input / of its suggestion box
    //   clearsBelow: touching a field empties the ones under it. Right when you
    //     are narrowing a medicine down from nothing, wrong when you are
    //     correcting one that already exists — changing the brand there would
    //     wipe the form and strength the nurse came in with, which is the very
    //     retyping the edit dialog is meant to save. The dialog leaves them be
    //     and lets the Formulary line (and the check on Save) judge the result.
    function createCascade({ ids, sug, statusId, noteId, volId, clearsBelow = true }) {
        const timers = {}, seqs = {}, aborts = {};
        let statusSeq = 0;
        const $f = (field) => $(ids[field]);
        const values = () => {
            const v = {};
            FIELDS.forEach((f) => { v[f] = $f(f).value.trim(); });
            return v;
        };
        const clearBelow = (field) => {
            if (!clearsBelow) return;
            FIELDS.slice(FIELDS.indexOf(field) + 1).forEach((f) => { $f(f).value = ''; });
        };

        function showSuggest(field) {
            clearTimeout(timers[field]);
            timers[field] = setTimeout(() => runSuggest(field), DEBOUNCE_MS);
        }
        async function runSuggest(field) {
            const box = $(sug[field]);
            const s = values();
            // claim the sequence even when we are not going to search: a request
            // fired at two letters must not land after a backspace drops us below
            // the threshold and repaint the box with rows for a query that is gone
            const mine = seqs[field] = (seqs[field] || 0) + 1;
            if (!worthSearching(field, s)) {
                if (aborts[field]) aborts[field].abort();
                box.innerHTML = `<div class="opt hint">Type ${MIN_Q} letters to search…</div>`;
                box.style.display = document.activeElement === $f(field) ? 'block' : 'none';
                return;
            }
            let opts;
            try { opts = await fetchOptions(field, s, aborts); }
            catch { return; }                                   // aborted or offline: leave the list alone
            if (mine !== seqs[field]) return;                   // a newer keystroke already won
            if (document.activeElement !== $f(field)) { box.style.display = 'none'; return; }
            if (!opts.length) { box.style.display = 'none'; return; }
            box.innerHTML = opts.map((o, i) => `<div class="opt" data-i="${i}"><span>${escapeHtml(o.value)}</span>${o.pnf ? '<span class="badge navy" title="In the Philippine National Formulary">PNF</span> ' : ''}<span class="badge ${o.ihf ? 'green' : 'amber'}" title="${o.ihf ? 'In hospital Formulary' : 'Not in hospital Formulary'}">${o.ihf ? '✓' : '✗'}</span></div>`).join('');
            box.style.display = 'block';
            box.querySelectorAll('.opt').forEach((el) => {
                el.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    const o = opts[Number(el.dataset.i)];
                    $f(field).value = o.value;
                    box.style.display = 'none';
                    clearBelow(field);
                    // a brand that belongs to exactly one generic fills the generic in
                    if (field === 'brand' && o.soleGeneric) $f('generic').value = o.soleGeneric;
                    updateStatus();
                });
            });
        }

        async function updateStatus() {
            const s = values(); const st = $(statusId); const note = $(noteId);
            const mine = ++statusSeq;
            note.style.display = 'none';
            if (!s.generic) { st.textContent = ''; st.className = 'mb-status'; return; }
            if (!(s.generic && s.form && s.strength)) { st.textContent = 'fill generic, form & strength'; st.className = 'mb-status muted'; return; }

            const { ok, product: c } = await fetchProduct(s).catch(() => ({ ok: false, product: null }));
            if (mine !== statusSeq) return;                     // the fields moved on while we asked
            if (!ok) { st.textContent = '… could not check — server unreachable'; st.className = 'mb-status muted'; return; }

            // liquids with a known volume (vaccines, IV bottles) prefill the Vol input
            if (c && c.volumeMl != null && volId && !$(volId).value) $(volId).value = c.volumeMl;
            const bits = [];
            if (c && c.inFormulary) {
                st.textContent = '✓ In the hospital Formulary'; st.className = 'mb-status ok';
                bits.push(c.inPnf ? 'In the PNF.' : 'Not in the PNF.');
            } else {
                st.textContent = '✗ NOT in the hospital Formulary'; st.className = 'mb-status new';
                if (c) bits.push(c.inPnf ? 'In the PNF.' : 'Not in the PNF.');
            }
            if (c && c.registrationNumber) bits.push(`Reg. No. ${c.registrationNumber}`);
            if (bits.length) { note.textContent = bits.join(' '); note.style.display = 'block'; }
        }

        FIELDS.forEach((field) => {
            const inp = $f(field);
            inp.addEventListener('input', () => {
                clearBelow(field);
                showSuggest(field);
                clearTimeout(timers.status);
                timers.status = setTimeout(updateStatus, DEBOUNCE_MS);
            });
            inp.addEventListener('focus', () => showSuggest(field));
            inp.addEventListener('blur', () => setTimeout(() => { $(sug[field]).style.display = 'none'; }, 150));
        });

        return {
            values,
            setValues: (v) => FIELDS.forEach((f) => { $f(f).value = v[f] || ''; }),
            hideBoxes: () => FIELDS.forEach((f) => { $(sug[f]).style.display = 'none'; }),
            focus: (field) => $f(field).focus(),
            updateStatus,
        };
    }

    const idsFor = (prefix) => Object.fromEntries(FIELDS.map((f) => [f, prefix + f]));
    const builder = createCascade({ ids: idsFor('f-'), sug: idsFor('sg-'), statusId: 'mbStatus', noteId: 'mbNote', volId: 'f-vol' });
    const editor = createCascade({ ids: idsFor('e-'), sug: idsFor('esg-'), statusId: 'edStatus', noteId: 'edNote', volId: 'e-vol', clearsBelow: false });

    function resetBuilder() {
        builder.setValues({});
        $('f-qty').value = '1'; $('f-vol').value = ''; $('f-sig').value = '';
        builder.updateStatus(); builder.focus('generic');
    }
    $('mbClear').onclick = resetBuilder;
    $('mbAdd').onclick = async () => {
        const s = builder.values(); const qty = Number($('f-qty').value) || 1;
        const vol = Number($('f-vol').value) > 0 ? Number($('f-vol').value) : null;
        if (!s.generic || !s.form || !s.strength) {
            // put the caret in the first box that is actually missing
            const miss = ['generic', 'form', 'strength'].find((f) => !s[f]);
            notify('Enter at least generic, form, and strength.', { kind: 'warn', focus: `f-${miss}` });
            return;
        }

        const btn = $('mbAdd'); btn.disabled = true;
        const { ok, product: c } = await fetchProduct(s).catch(() => ({ ok: false, product: null }));
        btn.disabled = false;
        // adding on a failed lookup would silently flag a stocked medicine as
        // not-in-the-Formulary, so refuse instead of guessing
        if (!ok) { notify('Could not reach the server to check the Formulary. Try again in a moment.'); return; }

        addItem({ genericName: s.generic, brandName: s.brand, formName: s.form, strength: s.strength, volumeMl: vol, quantity: qty, sig: $('f-sig').value.trim(), isNew: !(c && c.inFormulary), inPnf: c ? !!c.inPnf : false, outOfStock: false });
        resetBuilder();
    };

    // ----- edit a medicine already on the list -----
    // Correcting a brand or a strength used to mean removing the line and
    // building it again from scratch. This dialog is the same cascade over its
    // own inputs, so an edit is searched and checked against the Formulary
    // exactly the way an Add is.
    const edDlg = $('medEditDlg');
    let editIndex = -1;

    function openEditor(i) {
        const it = items[i];
        editIndex = i;
        editor.setValues({ generic: it.genericName, brand: it.brandName, form: it.formName, strength: it.strength });
        $('e-vol').value = it.volumeMl == null ? '' : it.volumeMl;
        $('e-qty').value = it.quantity;
        $('e-sig').value = it.sig || '';
        $('edErr').classList.remove('show');
        edDlg.showModal();
        editor.updateStatus();
    }

    function editError(msg, focusField) {
        const err = $('edErr');
        err.textContent = msg;
        err.classList.add('show');
        if (focusField) editor.focus(focusField);
    }

    $('edCancel').onclick = () => edDlg.close();
    $('edSave').onclick = async () => {
        const s = editor.values();
        $('edErr').classList.remove('show');
        if (!s.generic || !s.form || !s.strength) {
            editError('Enter at least generic, form, and strength.', ['generic', 'form', 'strength'].find((f) => !s[f]));
            return;
        }

        const btn = $('edSave'); btn.disabled = true;
        const { ok, product: c } = await fetchProduct(s).catch(() => ({ ok: false, product: null }));
        btn.disabled = false;
        // the same refusal as Add, for the same reason: carrying the old
        // not-in-the-Formulary flag onto a medicine that has just been edited
        // would print a claim nobody checked. The dialog stays open.
        if (!ok) { editError('Could not reach the server to check the Formulary. Try again in a moment.'); return; }

        const it = items[editIndex];
        it.genericName = s.generic; it.brandName = s.brand; it.formName = s.form; it.strength = s.strength;
        it.volumeMl = Number($('e-vol').value) > 0 ? Number($('e-vol').value) : null;
        it.quantity = Number($('e-qty').value) || 1;
        it.sig = $('e-sig').value.trim();
        it.isNew = !(c && c.inFormulary);
        it.inPnf = c ? !!c.inPnf : false;
        // "no stock" is a statement about a medicine the Formulary carries; if
        // the edit turned this into one it does not, the flag no longer means
        // anything (render() drops the toggle for those rows too)
        if (it.isNew) it.outOfStock = false;

        savedRxId = null;               // what was recorded no longer matches the list
        edDlg.close();
        render();
    };
    // Esc closes without saving, like Cancel; leave nothing hanging behind it
    edDlg.addEventListener('close', () => { editor.hideBoxes(); editIndex = -1; });

    // ----- items -----
    function medLabel(it) {
        const brand = it.brandName ? ` (${it.brandName})` : '';
        // show the dispense volume unless the strength already says it (e.g. "500ML")
        const strengthIsVol = String(it.strength || '').toLowerCase().replace(/[\s,]/g, '') === `${it.volumeMl}ml`;
        const vol = it.volumeMl && !strengthIsVol ? `, ${it.volumeMl} mL` : '';
        return `${it.genericName}${brand} ${it.formName} ${it.strength}${vol}`.replace(/\s+/g, ' ').trim();
    }
    function addItem(item) { items.push(item); savedRxId = null; render(); }
    function removeItem(i) { items.splice(i, 1); savedRxId = null; render(); }
    function moveItem(from, to) { const [it] = items.splice(from, 1); items.splice(to, 0, it); savedRxId = null; render(); }

    function render() {
        const list = $('items');
        $('items-empty').style.display = items.length ? 'none' : 'block';
        list.innerHTML = items.map((it, i) => {
            const cls = it.isNew ? 'isnew' : (it.outOfStock ? 'nostock' : '');
            const tags = (it.isNew ? '<span class="badge amber">new</span> <span class="np-note">Not in the Formulary</span>' : '')
                + (it.outOfStock ? '<span class="np-note">no / not enough stock</span>' : '')
                + (it.inPnf ? ' <span class="badge navy" title="In the Philippine National Formulary">PNF</span>' : '');
            const toggle = it.isNew ? '' :
                `<label class="stock-toggle"><input type="checkbox" data-stock="${i}" ${it.outOfStock ? 'checked' : ''}> No stock</label>`;
            return `<li data-i="${i}">
                <span class="grip" draggable="true" title="Drag to reorder">⠿</span>
                <span class="nm ${cls}">${escapeHtml(medLabel(it))} ${tags}
                    <input class="sig" type="text" data-sig="${i}" value="${escapeHtml(it.sig || '')}" placeholder="Sig — e.g. 1 tab TID for pain">
                </span>
                ${toggle}
                <input class="qty" type="number" min="1" value="${it.quantity}" data-i="${i}">
                <button class="edit" type="button" data-edit="${i}" title="Edit this medicine">Edit</button>
                <button class="x" data-x="${i}">✕</button>
            </li>`;
        }).join('');

        list.querySelectorAll('li').forEach((li) => {
            const grip = li.querySelector('.grip');
            grip.addEventListener('dragstart', (e) => { dragFrom = Number(li.dataset.i); li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; if (e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(li, 0, 0); });
            grip.addEventListener('dragend', () => { dragFrom = null; list.querySelectorAll('li').forEach((x) => x.classList.remove('dragging', 'drag-over')); });
            li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('drag-over'); });
            li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
            li.addEventListener('drop', (e) => { e.preventDefault(); const to = Number(li.dataset.i); if (dragFrom !== null && dragFrom !== to) moveItem(dragFrom, to); });
        });
        list.querySelectorAll('input.qty').forEach((inp) => {
            inp.addEventListener('input', () => { items[Number(inp.dataset.i)].quantity = Number(inp.value) || 1; savedRxId = null; renderPreview(); });
        });
        // editable in place, like qty — an instruction is the kind of thing you
        // notice is wrong while reading the preview, and re-adding the medicine
        // just to fix a typo is worse. renderPreview() only, never render():
        // rebuilding the list would drop focus on every keystroke.
        list.querySelectorAll('input.sig').forEach((inp) => {
            inp.addEventListener('input', () => { items[Number(inp.dataset.sig)].sig = inp.value; savedRxId = null; renderPreview(); });
        });
        list.querySelectorAll('input[data-stock]').forEach((cb) => {
            cb.addEventListener('change', () => { items[Number(cb.dataset.stock)].outOfStock = cb.checked; savedRxId = null; render(); });
        });
        list.querySelectorAll('button.edit').forEach((b) => { b.addEventListener('click', () => openEditor(Number(b.dataset.edit))); });
        list.querySelectorAll('button.x').forEach((b) => { b.addEventListener('click', () => removeItem(Number(b.dataset.x))); });
        renderPreview();
    }

    // ----- printable slip (shared renderer: fixed 4.25in x 5.5in, auto-paginated) -----
    function rxData() {
        const now = new Date();
        const v = (id) => ($(id) ? $(id).value.trim() : '');
        return {
            date: now.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' }),
            time: now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
            patient: v('patient'), address: v('address'), age: v('age'), sex: v('sex'),
            doctor: { name: v('doctor'), license: v('docLicense'), ptr: v('docPtr'), s2: v('docS2') },
            meds: items.map((it) => ({
                label: medLabel(it),
                quantity: it.quantity,
                sig: it.sig || '',
                cls: it.isNew ? 'isnew' : (it.outOfStock ? 'nostock' : ''),
            })),
        };
    }
    function renderPreview() { $('preview').innerHTML = slipPagesHtml(rxData()); }

    // ----- print -----
    // window.print() opens a native OS dialog, and Chromium does not reliably
    // hand keyboard focus back to the page when it closes — the same deafness
    // alert() caused (see notify() in js/api.js). Nothing here is cleared by
    // printing, so after Cancel the station's work was always still on screen;
    // the keyboard had just stopped reaching it, which reads as "cancelling
    // threw my prescription away". So the page takes focus back itself.
    let lastField = null;
    document.addEventListener('focusin', (e) => {
        if (e.target instanceof HTMLElement && e.target.matches('input, select, textarea')) lastField = e.target;
    });

    let printRestored = true;
    function restoreFocusAfterPrint() {
        if (printRestored) return;      // afterprint and the print() return both land here
        printRestored = true;
        // the sig/qty inputs are rebuilt by render(), so the remembered field
        // may no longer be in the document
        const target = () => (lastField && document.body.contains(lastField) ? lastField : $('f-generic'));
        // the dialog tears down asynchronously and takes focus with it on the
        // way out, so restoring straight away can be undone; the second pass
        // only fires if focus really did end up nowhere
        setTimeout(() => { window.focus(); target().focus(); }, 0);
        setTimeout(() => {
            if (document.activeElement && document.activeElement !== document.body) return;
            window.focus(); target().focus();
        }, 200);
    }
    window.addEventListener('afterprint', restoreFocusAfterPrint);

    $('printBtn').onclick = async () => {
        if (!items.length) { notify('Add at least one medicine first.', { kind: 'warn', focus: 'f-generic' }); return; }
        if (!savedRxId) {
            const payload = {
                stationId: stationSel.value,
                patient: $('patient').value.trim(), address: $('address').value.trim(), age: $('age').value.trim(), sex: $('sex').value.trim(),
                doctor: { name: $('doctor').value.trim(), license: $('docLicense').value.trim(), ptr: $('docPtr').value.trim(), s2: $('docS2').value.trim() },
                items: items.map((it) => ({ genericName: it.genericName, brandName: it.brandName, formName: it.formName, strength: it.strength, volumeMl: it.volumeMl, quantity: it.quantity, sig: it.sig || '', outOfStock: !!it.outOfStock })),
            };
            const res = await api('/api/rx', { body: payload });
            if (!res.ok) { notify(res.data.message || 'Could not save prescription'); return; }
            savedRxId = true;
            saveDoctor();
        }
        $('print-area').innerHTML = slipPagesHtml(rxData());
        printRestored = false;
        window.print();
        // afterprint covers the dialog closing; this covers the browsers that
        // never fire it. Whichever lands first wins, the other is a no-op.
        restoreFocusAfterPrint();
    };
    $('clearBtn').onclick = () => {
        items.length = 0; savedRxId = null;
        ['patient', 'address', 'age', 'sex'].forEach((id) => { $(id).value = ''; });
        render();
    };
    ['patient', 'address', 'age', 'sex', 'docLicense', 'docPtr', 'docS2'].forEach((id) => {
        const el = $(id); if (el) el.addEventListener('input', renderPreview);
    });

    builder.updateStatus();
    render();
})();
