(async function () {
    const meRes = await api('/api/auth/me');
    if (meRes.ok) { window.location.href = '/dashboard'; return; }

    mountRail({ mode: 'nurse', active: 'rx' });

    const $ = (id) => document.getElementById(id);
    const items = [];   // { genericName, brandName, formName, strength, quantity, isNew, inPnf, outOfStock }
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
    const fEl = { generic: 'f-generic', brand: 'f-brand', form: 'f-form', strength: 'f-strength' };
    const sEl = { generic: 'sg-generic', brand: 'sg-brand', form: 'sg-form', strength: 'sg-strength' };
    // a field is narrowed only by the fields above it in the cascade
    const PARENTS = { generic: [], brand: ['generic'], form: ['generic', 'brand'], strength: ['generic', 'brand', 'form'] };
    const sel = () => ({ generic: $('f-generic').value.trim(), brand: $('f-brand').value.trim(), form: $('f-form').value.trim(), strength: $('f-strength').value.trim() });

    const DEBOUNCE_MS = 120;
    const CACHE_MAX = 200;          // backspacing walks back through queries already answered
    const timers = {}, seqs = {}, aborts = {};
    let statusSeq = 0;

    const optCache = new Map(), productCache = new Map();
    function remember(cache, key, value) {
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
        cache.set(key, value);
        return value;
    }

    // in-flight requests for a field are aborted by the next keystroke, so a
    // slow reply can never repaint over a newer one
    async function fetchOptions(field, s) {
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
    async function fetchProduct(s) {
        const params = new URLSearchParams({ generic: s.generic, brand: s.brand, form: s.form, strength: s.strength });
        const key = params.toString();
        if (productCache.has(key)) return { ok: true, product: productCache.get(key) };
        const res = await api(`/api/rx/product?${key}`);
        if (!res.ok) return { ok: false, product: null };
        return { ok: true, product: remember(productCache, key, res.data.product || null) };
    }

    function showSuggest(field) {
        clearTimeout(timers[field]);
        timers[field] = setTimeout(() => runSuggest(field), DEBOUNCE_MS);
    }
    async function runSuggest(field) {
        const box = $(sEl[field]);
        const mine = seqs[field] = (seqs[field] || 0) + 1;
        let opts;
        try { opts = await fetchOptions(field, sel()); }
        catch { return; }                                   // aborted or offline: leave the list alone
        if (mine !== seqs[field]) return;                   // a newer keystroke already won
        if (document.activeElement !== $(fEl[field])) { box.style.display = 'none'; return; }
        if (!opts.length) { box.style.display = 'none'; return; }
        box.innerHTML = opts.map((o, i) => `<div class="opt" data-i="${i}"><span>${escapeHtml(o.value)}</span>${o.pnf ? '<span class="badge navy" title="In the Philippine National Formulary">PNF</span> ' : ''}<span class="badge ${o.ihf ? 'green' : 'amber'}" title="${o.ihf ? 'In hospital Formulary' : 'Not in hospital Formulary'}">${o.ihf ? '✓' : '✗'}</span></div>`).join('');
        box.style.display = 'block';
        box.querySelectorAll('.opt').forEach((el) => {
            el.addEventListener('mousedown', (e) => {
                e.preventDefault();
                const o = opts[Number(el.dataset.i)];
                $(fEl[field]).value = o.value;
                box.style.display = 'none';
                clearBelow(field);
                // a brand that belongs to exactly one generic fills the generic in
                if (field === 'brand' && o.soleGeneric) $('f-generic').value = o.soleGeneric;
                updateStatus();
            });
        });
    }
    const clearBelow = (field) => FIELDS.slice(FIELDS.indexOf(field) + 1).forEach((f) => { $(fEl[f]).value = ''; });

    async function updateStatus() {
        const s = sel(); const st = $('mbStatus'); const note = $('mbNote');
        const mine = ++statusSeq;
        note.style.display = 'none';
        if (!s.generic) { st.textContent = ''; st.className = 'mb-status'; return; }
        if (!(s.generic && s.form && s.strength)) { st.textContent = 'fill generic, form & strength'; st.className = 'mb-status muted'; return; }

        const { ok, product: c } = await fetchProduct(s).catch(() => ({ ok: false, product: null }));
        if (mine !== statusSeq) return;                     // the fields moved on while we asked
        if (!ok) { st.textContent = '… could not check — server unreachable'; st.className = 'mb-status muted'; return; }

        // liquids with a known volume (vaccines, IV bottles) prefill the Vol input
        if (c && c.volumeMl != null && !$('f-vol').value) $('f-vol').value = c.volumeMl;
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
        const inp = $(fEl[field]);
        inp.addEventListener('input', () => {
            clearBelow(field);
            showSuggest(field);
            clearTimeout(timers.status);
            timers.status = setTimeout(updateStatus, DEBOUNCE_MS);
        });
        inp.addEventListener('focus', () => showSuggest(field));
        inp.addEventListener('blur', () => setTimeout(() => { $(sEl[field]).style.display = 'none'; }, 150));
    });
    function resetBuilder() { FIELDS.forEach((f) => { $(fEl[f]).value = ''; }); $('f-qty').value = '1'; $('f-vol').value = ''; updateStatus(); $('f-generic').focus(); }
    $('mbClear').onclick = resetBuilder;
    $('mbAdd').onclick = async () => {
        const s = sel(); const qty = Number($('f-qty').value) || 1;
        const vol = Number($('f-vol').value) > 0 ? Number($('f-vol').value) : null;
        if (!s.generic || !s.form || !s.strength) { alert('Enter at least generic, form, and strength.'); return; }

        const btn = $('mbAdd'); btn.disabled = true;
        const { ok, product: c } = await fetchProduct(s).catch(() => ({ ok: false, product: null }));
        btn.disabled = false;
        // adding on a failed lookup would silently flag a stocked medicine as
        // not-in-the-Formulary, so refuse instead of guessing
        if (!ok) { alert('Could not reach the server to check the Formulary. Try again in a moment.'); return; }

        addItem({ genericName: s.generic, brandName: s.brand, formName: s.form, strength: s.strength, volumeMl: vol, quantity: qty, isNew: !(c && c.inFormulary), inPnf: c ? !!c.inPnf : false, outOfStock: false });
        resetBuilder();
    };

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
                <span class="nm ${cls}">${escapeHtml(medLabel(it))} ${tags}</span>
                ${toggle}
                <input class="qty" type="number" min="1" value="${it.quantity}" data-i="${i}">
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
        list.querySelectorAll('input[data-stock]').forEach((cb) => {
            cb.addEventListener('change', () => { items[Number(cb.dataset.stock)].outOfStock = cb.checked; savedRxId = null; render(); });
        });
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
                cls: it.isNew ? 'isnew' : (it.outOfStock ? 'nostock' : ''),
            })),
        };
    }
    function renderPreview() { $('preview').innerHTML = slipPagesHtml(rxData()); }

    // ----- print -----
    $('printBtn').onclick = async () => {
        if (!items.length) { alert('Add at least one medicine first.'); return; }
        if (!savedRxId) {
            const payload = {
                stationId: stationSel.value,
                patient: $('patient').value.trim(), address: $('address').value.trim(), age: $('age').value.trim(), sex: $('sex').value.trim(),
                doctor: { name: $('doctor').value.trim(), license: $('docLicense').value.trim(), ptr: $('docPtr').value.trim(), s2: $('docS2').value.trim() },
                items: items.map((it) => ({ genericName: it.genericName, brandName: it.brandName, formName: it.formName, strength: it.strength, volumeMl: it.volumeMl, quantity: it.quantity, outOfStock: !!it.outOfStock })),
            };
            const res = await api('/api/rx', { body: payload });
            if (!res.ok) { alert(res.data.message || 'Could not save prescription'); return; }
            savedRxId = true;
            saveDoctor();
        }
        $('print-area').innerHTML = slipPagesHtml(rxData());
        window.print();
    };
    $('clearBtn').onclick = () => {
        items.length = 0; savedRxId = null;
        ['patient', 'address', 'age', 'sex'].forEach((id) => { $(id).value = ''; });
        render();
    };
    ['patient', 'address', 'age', 'sex', 'docLicense', 'docPtr', 'docS2'].forEach((id) => {
        const el = $(id); if (el) el.addEventListener('input', renderPreview);
    });

    updateStatus();
    render();
})();
