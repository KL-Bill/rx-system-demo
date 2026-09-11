(async function () {
    const meRes = await api('/api/auth/me');
    if (meRes.ok) { window.location.href = '/dashboard'; return; }

    mountRail({ mode: 'nurse', active: 'rx' });

    const $ = (id) => document.getElementById(id);
    // { kind, genericName, brandName, formName, strength, description, volumeMl, quantity, sig, isNew, inPnf, outOfStock }
    // kind 'supply': genericName carries the description, supplyCode its Bizbox code
    const items = [];
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

    // the medicine widget (search, split, Bizbox check) lives in js/medwidget.js
    const { create: createWidget, fetchProduct, missingField } = MedWidget;

    // Medicine or Supply: which boxes the Add panel shows. Both share the
    // status line, Out of stock, Qty and Sig; the kind not on screen stays quiet.
    let kind = 'med', editKind = 'med';
    const builder = createWidget({ p: 'f-', sg: 'sg-', statusId: 'mbStatus', noteId: 'mbNote', splitNoteId: 'f-splitNote', active: () => kind === 'med' });
    const editor = createWidget({ p: 'e-', sg: 'esg-', statusId: 'edStatus', noteId: 'edNote', splitNoteId: 'e-splitNote', clearsBelow: false, active: () => editKind === 'med' });
    const supBuilder = SupplyBox.create({ p: 'f-', sg: 'sg-', statusId: 'mbStatus', noteId: 'mbNote', active: () => kind === 'sup' });
    const supEditor = SupplyBox.create({ p: 'e-', sg: 'esg-', statusId: 'edStatus', noteId: 'edNote', active: () => editKind === 'sup' });

    function setKind(k) {
        kind = k;
        $('builder').classList.toggle('kind-sup', k === 'sup');
        document.querySelectorAll('[data-kind-btn]').forEach((b) => b.classList.toggle('on', b.dataset.kindBtn === k));
        builder.hideBoxes(); supBuilder.hideBoxes();
        (k === 'sup' ? supBuilder : builder).updateStatus();
        if (k === 'sup') supBuilder.focus(); else builder.focus('generic');
        try { localStorage.setItem('rx_add_kind', k); } catch { /* per-kiosk nicety only */ }
    }
    document.querySelectorAll('[data-kind-btn]').forEach((b) => { b.onclick = () => { if (b.dataset.kindBtn !== kind) setKind(b.dataset.kindBtn); }; });

    function resetBuilder() {
        if (kind === 'sup') { supBuilder.reset(); supBuilder.focus(); } else { builder.reset(); builder.focus('generic'); }
    }
    $('mbClear').onclick = resetBuilder;

    // a supply line: the same rules as a medicine — not in Bizbox prints bold,
    // out of stock only means something for one Bizbox carries
    async function checkSupply(s) {
        const { ok, supply } = await SupplyBox.fetchSupply(s).catch(() => ({ ok: false, supply: null }));
        return { ok, supply, inBizbox: !!(supply && supply.inBizbox) };
    }
    async function addSupply() {
        const s = supBuilder.values();
        if (!s.description) {
            await showDialog({ kind: 'warn', title: 'Missing details', message: 'Enter the supply first.' });
            supBuilder.focus();
            return;
        }
        const btn = $('mbAdd'); btn.disabled = true;
        const { ok, supply, inBizbox } = await checkSupply(s);
        btn.disabled = false;
        if (!ok) {
            await showDialog({ kind: 'danger', title: 'Cannot reach the server', message: 'Bizbox could not be checked, so the supply was not added. Try again in a moment.' });
            return;
        }
        const description = (supply && supply.description) || s.description;
        addItem({
            kind: 'supply', supplyCode: (supply && supply.code) || '', fromCatalog: !!supply,
            genericName: description, brandName: '', formName: '', strength: '', description,
            volumeMl: null, quantity: s.quantity, sig: s.sig,
            isNew: !inBizbox, inPnf: false, outOfStock: inBizbox && s.outOfStock,
        });
        resetBuilder();
    }

    $('mbAdd').onclick = async () => {
        if (kind === 'sup') return addSupply();
        const s = builder.values();
        const miss = missingField(builder, s);
        if (miss) {
            await showDialog({
                kind: 'warn', title: 'Missing details',
                message: miss === 'generic' ? 'Enter the generic name first.'
                    : miss === 'combo' ? 'Pick the brand, form and strength from the list — or type the medicine to add one Bizbox does not have.'
                    : 'Enter at least the form and strength before adding the medicine.',
            });
            builder.focus(miss);        // the caret goes to the first box actually missing
            return;
        }

        const btn = $('mbAdd'); btn.disabled = true;
        const { ok, product: c } = await fetchProduct(s).catch(() => ({ ok: false, product: null }));
        btn.disabled = false;
        // adding on a failed lookup would silently flag a stocked medicine as
        // not-in-Bizbox, so refuse instead of guessing
        if (!ok) {
            await showDialog({
                kind: 'danger', title: 'Cannot reach the server',
                message: 'Bizbox could not be checked, so the medicine was not added. Try again in a moment.',
            });
            return;
        }
        const inBizbox = !!(c && c.inFormulary);
        addItem({
            genericName: s.generic, brandName: s.brand, formName: s.form, strength: s.strength,
            description: (c && c.description) || s.description, fromCatalog: !!c,
            volumeMl: s.volumeMl, quantity: s.quantity, sig: s.sig,
            isNew: !inBizbox, inPnf: c ? !!c.inPnf : false,
            // "out of stock" is a statement about a medicine Bizbox carries
            outOfStock: inBizbox && s.outOfStock,
        });
        resetBuilder();
    };

    // ----- edit a medicine already on the list -----
    // Correcting a brand or a strength used to mean removing the line and
    // building it again from scratch. This dialog is the same widget over its
    // own inputs, so an edit is searched and checked against Bizbox exactly
    // the way an Add is.
    const edDlg = $('medEditDlg');
    let editIndex = -1;

    function openEditor(i) {
        editIndex = i;
        editKind = items[i].kind === 'supply' ? 'sup' : 'med';
        edDlg.classList.toggle('kind-sup', editKind === 'sup');
        $('edTitle').textContent = editKind === 'sup' ? 'Edit supply' : 'Edit medicine';
        $('edErr').classList.remove('show');
        edDlg.showModal();
        (editKind === 'sup' ? supEditor : editor).load(items[i]);
    }

    function editError(msg, focusField) {
        const err = $('edErr');
        err.textContent = msg;
        err.classList.add('show');
        if (focusField) editor.focus(focusField);
    }

    $('edCancel').onclick = () => edDlg.close();
    async function saveSupplyEdit() {
        const s = supEditor.values();
        $('edErr').classList.remove('show');
        if (!s.description) { editError('Enter the supply.'); supEditor.focus(); return; }
        const btn = $('edSave'); btn.disabled = true;
        const { ok, supply, inBizbox } = await checkSupply(s);
        btn.disabled = false;
        if (!ok) { editError('Could not reach the server to check Bizbox. Try again in a moment.'); return; }
        const it = items[editIndex];
        const description = (supply && supply.description) || s.description;
        Object.assign(it, {
            genericName: description, description, supplyCode: (supply && supply.code) || '', fromCatalog: !!supply,
            quantity: s.quantity, sig: s.sig, isNew: !inBizbox, outOfStock: inBizbox && s.outOfStock,
        });
        savedRxId = null;
        edDlg.close();
        render();
    }

    $('edSave').onclick = async () => {
        if (editKind === 'sup') return saveSupplyEdit();
        const s = editor.values();
        $('edErr').classList.remove('show');
        const miss = missingField(editor, s);
        if (miss) {
            editError(miss === 'generic' ? 'Enter the generic name.' : miss === 'combo' ? 'Pick the brand, form and strength, or type the medicine.' : 'Enter at least the form and strength.', miss);
            return;
        }

        const btn = $('edSave'); btn.disabled = true;
        const { ok, product: c } = await fetchProduct(s).catch(() => ({ ok: false, product: null }));
        btn.disabled = false;
        // the same refusal as Add, for the same reason: carrying the old
        // not-in-Bizbox flag onto a medicine that has just been edited would
        // print a claim nobody checked. The dialog stays open.
        if (!ok) { editError('Could not reach the server to check Bizbox. Try again in a moment.'); return; }

        const it = items[editIndex];
        const inBizbox = !!(c && c.inFormulary);
        it.genericName = s.generic; it.brandName = s.brand; it.formName = s.form; it.strength = s.strength;
        it.description = (c && c.description) || s.description; it.fromCatalog = !!c;
        it.volumeMl = s.volumeMl; it.quantity = s.quantity; it.sig = s.sig;
        it.isNew = !inBizbox;
        it.inPnf = c ? !!c.inPnf : false;
        it.outOfStock = inBizbox && s.outOfStock;

        savedRxId = null;               // what was recorded no longer matches the list
        edDlg.close();
        render();
    };
    // Esc closes without saving, like Cancel; leave nothing hanging behind it
    edDlg.addEventListener('close', () => { editor.hideBoxes(); supEditor.hideBoxes(); editIndex = -1; });

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
            const tags = (it.kind === 'supply' ? ' <span class="badge gray">Supply</span>' : '')
                + (it.isNew ? ' <span class="badge amber">Not in Bizbox</span>' : ' <span class="badge green">In Bizbox</span>')
                + (it.outOfStock ? ' <span class="np-note">out of stock</span>' : '')
                + (it.inPnf ? ' <span class="badge navy" title="In the Philippine National Formulary">PNF</span>' : '');
            return `<li data-i="${i}">
                <span class="grip" draggable="true" title="Drag to reorder">⠿</span>
                <span class="nm ${cls}">${escapeHtml(medLabel(it))}${tags}
                    <input class="sig" type="text" data-sig="${i}" value="${escapeHtml(it.sig || '')}" placeholder="Sig — e.g. 1 tab TID for pain">
                </span>
                <input class="qty" type="number" min="1" value="${it.quantity}" data-i="${i}">
                <button class="edit" type="button" data-edit="${i}" title="Edit this line">Edit</button>
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
    // alert() caused (see showDialog() in js/api.js). Nothing here is cleared by
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
        const target = () => (lastField && document.body.contains(lastField) ? lastField : $(kind === 'sup' ? 'f-supply' : 'f-generic'));
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

    // The prescription is recorded on the first Print, not on Add and not on
    // New patient: a line being built is not a prescription yet, and a
    // reprint of an unchanged list must not be counted twice.
    $('printBtn').onclick = async () => {
        if (!items.length) {
            await showDialog({
                kind: 'warn', title: 'Nothing to print',
                message: 'Add at least one medicine or supply to the prescription first.',
            });
            if (kind === 'sup') supBuilder.focus(); else builder.focus('generic');
            return;
        }
        if (!savedRxId) {
            const payload = {
                stationId: stationSel.value,
                patient: $('patient').value.trim(), address: $('address').value.trim(), age: $('age').value.trim(), sex: $('sex').value.trim(),
                doctor: { name: $('doctor').value.trim(), license: $('docLicense').value.trim(), ptr: $('docPtr').value.trim(), s2: $('docS2').value.trim() },
                items: items.map((it) => ({
                    kind: it.kind === 'supply' ? 'supply' : undefined, supplyCode: it.supplyCode || undefined,
                    genericName: it.genericName, brandName: it.brandName, formName: it.formName, strength: it.strength,
                    description: it.description || '', volumeMl: it.volumeMl, quantity: it.quantity, sig: it.sig || '', outOfStock: !!it.outOfStock,
                })),
            };
            const res = await api('/api/rx', { body: payload });
            if (!res.ok) {
                await showDialog({
                    kind: 'danger', title: 'Could not save the prescription',
                    message: res.data.message || 'The prescription was not recorded, so nothing was printed. Try again in a moment.',
                });
                return;
            }
            savedRxId = true;
            saveDoctor();
            keepReceipt(res.data);
        }
        $('print-area').innerHTML = slipPagesHtml(rxData());
        printRestored = false;
        window.print();
        // afterprint covers the dialog closing; this covers the browsers that
        // never fire it. Whichever lands first wins, the other is a no-op.
        restoreFocusAfterPrint();
    };

    // ----- previous prescriptions: this kiosk's own, to reprint a lost slip -----
    // Every save returns a receipt; the kiosk keeps them here and the server
    // answers history/reprint only for receipts it is shown. So this list is
    // exactly what this computer printed — nothing from anywhere else.
    const RECEIPTS_KEY = 'rx_receipts';
    const KEEP_DAYS = 90, KEEP_MAX = 1000;
    function readReceipts() {
        try { return JSON.parse(localStorage.getItem(RECEIPTS_KEY) || '[]') || []; } catch { return []; }
    }
    function keepReceipt(saved) {
        if (!saved || !saved.id || !saved.receipt) return;
        const cutoff = Date.now() - KEEP_DAYS * 86400000;
        const list = [{ id: saved.id, receipt: saved.receipt, at: saved.createdAt || Date.now() }]
            .concat(readReceipts().filter((r) => r.id !== saved.id && r.at >= cutoff))
            .slice(0, KEEP_MAX);
        try { localStorage.setItem(RECEIPTS_KEY, JSON.stringify(list)); } catch { /* storage full: history just won't show it */ }
    }

    const histDlg = $('histDlg');
    const histDr = DateRange.enhance($('hFrom'), $('hTo'), { defaultPreset: '7', onChange: () => loadHistory() });
    let histRows = [], histCurrent = null, histSeq = 0;
    const fmtWhen = (t) => new Date(t).toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit', hour: 'numeric', minute: '2-digit' });

    // the slip exactly as it was first printed, original date and time included
    function historySlip(p) {
        const d = new Date(p.createdAt);
        return {
            date: d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' }),
            time: d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
            patient: p.patient, address: p.address, age: p.age, sex: p.sex,
            doctor: p.doctor || {},
            meds: (p.items || []).map((it) => ({ label: medLabelOf(it), quantity: it.quantity, sig: it.sig || '', cls: reasonCls(it.reason) })),
        };
    }

    function showHistList() {
        histCurrent = null;
        $('histList').style.display = ''; $('histView').style.display = 'none';
        $('histBack').style.display = 'none'; $('histReprint').style.display = 'none';
    }
    async function loadHistory() {
        const receipts = readReceipts();
        const mine = ++histSeq;
        if (!receipts.length) {
            histRows = [];
            $('histTbl').innerHTML = '';
            $('histCount').textContent = '';
            $('histEmpty').innerHTML = 'Nothing printed on this computer yet. Prescriptions appear here from the next one you print.<br>For an older prescription, ask the pharmacy — they can find and reprint any prescription.';
            $('histEmpty').style.display = 'block';
            return;
        }
        const res = await api('/api/rx/history', { body: { receipts: receipts.map((r) => ({ id: r.id, receipt: r.receipt })), q: $('histQ').value.trim(), from: $('hFrom').value, to: $('hTo').value } });
        if (mine !== histSeq) return;                  // a newer search already answered
        if (!res.ok) {
            $('histTbl').innerHTML = '';
            $('histEmpty').textContent = res.data.message || 'Could not reach the server. Try again in a moment.';
            $('histEmpty').style.display = 'block';
            return;
        }
        histRows = res.data.prescriptions || [];
        const n = res.data.total || 0;
        $('histCount').textContent = n ? `${n} prescription${n === 1 ? '' : 's'}${res.data.capped ? ` — showing the newest ${histRows.length}, search to narrow` : ''}` : '';
        $('histEmpty').textContent = 'No prescriptions match. Try a wider date range, or fewer words.';
        $('histEmpty').style.display = histRows.length ? 'none' : 'block';
        $('histTbl').innerHTML = histRows.map((p, i) => {
            const meds = (p.items || []).map((it) => medLabelOf(it));
            return `<tr class="clickable" data-i="${i}">
                <td>${escapeHtml(fmtWhen(p.createdAt))}</td>
                <td><b>${escapeHtml(p.patient || '—')}</b>${p.age || p.sex ? `<div class="meds">${escapeHtml([p.age, p.sex].filter(Boolean).join(' · '))}</div>` : ''}</td>
                <td>${escapeHtml(drName(p.doctor && p.doctor.name) || '—')}</td>
                <td>${escapeHtml(meds[0] || '')}${meds.length > 1 ? `<div class="meds">+${meds.length - 1} more</div>` : ''}</td>
                <td class="meds">${escapeHtml(p.station || '')}</td>
            </tr>`;
        }).join('');
        $('histTbl').querySelectorAll('tr').forEach((tr) => { tr.onclick = () => openHistory(histRows[Number(tr.dataset.i)]); });
    }
    function openHistory(p) {
        histCurrent = p;
        $('histMeta').innerHTML = `<b>${escapeHtml(p.patient || 'No patient name')}</b> · ${escapeHtml(fmtWhen(p.createdAt))} · ${escapeHtml(drName(p.doctor && p.doctor.name) || '—')} · ${escapeHtml(p.station || '')}`;
        $('histSlip').innerHTML = slipPagesHtml(historySlip(p));
        $('histList').style.display = 'none'; $('histView').style.display = '';
        $('histBack').style.display = ''; $('histReprint').style.display = '';
        $('histReprint').focus();
    }

    let histT = null;
    $('histQ').addEventListener('input', () => { clearTimeout(histT); histT = setTimeout(loadHistory, 250); });
    ['hFrom', 'hTo'].forEach((id) => { $(id).addEventListener('change', () => loadHistory()); });
    $('histBtn').onclick = () => {
        $('histQ').value = '';
        histDr.apply('7');                              // each visit starts on the last week
        showHistList();
        histDlg.showModal();
        $('histQ').focus();
        loadHistory();
    };
    $('histBack').onclick = () => { showHistList(); $('histQ').focus(); };
    $('histClose').onclick = () => histDlg.close();
    $('histReprint').onclick = async () => {
        const p = histCurrent;
        if (!p) return;
        const r = readReceipts().find((x) => x.id === p.id);
        const btn = $('histReprint'); btn.disabled = true;
        const res = await api('/api/rx/reprint', { body: { id: p.id, receipt: r && r.receipt } });
        btn.disabled = false;
        // same rule as a first print: nothing prints unless the server recorded it
        if (!res.ok) {
            await showDialog({ kind: 'danger', title: 'Could not reprint', message: res.data.message || 'The reprint could not be recorded, so nothing was printed. Try again in a moment.' });
            return;
        }
        $('print-area').innerHTML = slipPagesHtml(historySlip(p));
        histDlg.close();
        printRestored = false;
        window.print();
        restoreFocusAfterPrint();
    };
    histDlg.addEventListener('close', () => { histCurrent = null; });

    $('clearBtn').onclick = () => {
        items.length = 0; savedRxId = null;
        ['patient', 'address', 'age', 'sex'].forEach((id) => { $(id).value = ''; });
        render();
    };
    ['patient', 'address', 'age', 'sex', 'docLicense', 'docPtr', 'docS2'].forEach((id) => {
        const el = $(id); if (el) el.addEventListener('input', renderPreview);
    });

    let startKind = 'med';
    try { startKind = localStorage.getItem('rx_add_kind') === 'sup' ? 'sup' : 'med'; } catch { /* default */ }
    if (startKind === 'sup') setKind('sup'); else builder.updateStatus();
    render();
})();
