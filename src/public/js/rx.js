(async function () {
    const meRes = await api('/api/auth/me');
    if (meRes.ok) { window.location.href = '/dashboard'; return; }

    mountRail({ mode: 'nurse', active: 'rx' });

    const $ = (id) => document.getElementById(id);
    // { genericName, brandName, formName, strength, description, volumeMl, quantity, sig, isNew, inPnf, outOfStock }
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

    const builder = createWidget({ p: 'f-', sg: 'sg-', statusId: 'mbStatus', noteId: 'mbNote', splitNoteId: 'f-splitNote' });
    const editor = createWidget({ p: 'e-', sg: 'esg-', statusId: 'edStatus', noteId: 'edNote', splitNoteId: 'e-splitNote', clearsBelow: false });

    function resetBuilder() { builder.reset(); builder.focus('generic'); }
    $('mbClear').onclick = resetBuilder;
    $('mbAdd').onclick = async () => {
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
        $('edErr').classList.remove('show');
        edDlg.showModal();
        editor.load(items[i]);
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
            const tags = (it.isNew ? ' <span class="badge amber">Not in Bizbox</span>' : ' <span class="badge green">In Bizbox</span>')
                + (it.outOfStock ? ' <span class="np-note">out of stock</span>' : '')
                + (it.inPnf ? ' <span class="badge navy" title="In the Philippine National Formulary">PNF</span>' : '');
            return `<li data-i="${i}">
                <span class="grip" draggable="true" title="Drag to reorder">⠿</span>
                <span class="nm ${cls}">${escapeHtml(medLabel(it))}${tags}
                    <input class="sig" type="text" data-sig="${i}" value="${escapeHtml(it.sig || '')}" placeholder="Sig — e.g. 1 tab TID for pain">
                </span>
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

    // The prescription is recorded on the first Print, not on Add and not on
    // New patient: a line being built is not a prescription yet, and a
    // reprint of an unchanged list must not be counted twice.
    $('printBtn').onclick = async () => {
        if (!items.length) {
            await showDialog({
                kind: 'warn', title: 'Nothing to print',
                message: 'Add at least one medicine to the prescription first.',
            });
            builder.focus('generic');
            return;
        }
        if (!savedRxId) {
            const payload = {
                stationId: stationSel.value,
                patient: $('patient').value.trim(), address: $('address').value.trim(), age: $('age').value.trim(), sex: $('sex').value.trim(),
                doctor: { name: $('doctor').value.trim(), license: $('docLicense').value.trim(), ptr: $('docPtr').value.trim(), s2: $('docS2').value.trim() },
                items: items.map((it) => ({
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
