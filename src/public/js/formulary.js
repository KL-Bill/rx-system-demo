/* The Medicines page: two tabs.
 *   RX Formulary  browse and fix this app's medicine list — search, edit a
 *                 row, merge a duplicate into the one to keep, add one by hand
 *   Import        bring the list in step with Bizbox (js/bizbox-import.js)
 *
 *   RxFormulary.mount(rootElement)
 *
 * Mounted on the pharmacy head's Medicines page and on the IT console's
 * Medicines tab. Needs api.js, split.js, medwidget.js, bizbox-import.js.
 */
(function (global) {
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const PAGE = 100;

    function mount(root) {
        let q = '', bizbox = 'all', offset = 0, total = 0, rows = [];
        let tab = 'list';

        root.innerHTML = `
            <div class="tabs med-tabs" id="medTabs">
                <button class="tab active" data-t="list" type="button">RX Formulary</button>
                <button class="tab" data-t="import" type="button">Import from Bizbox</button>
            </div>
            <div id="medList">
                <div class="card imp-card">
                    <div class="imp-h">
                        <div><h2>RX Formulary</h2><p class="sub" style="margin:0">Every medicine this system knows. Marked ones are In Bizbox. Fix a spelling, merge a duplicate, or add one Bizbox carries that the list lacks.</p></div>
                        <div class="tb-right"><button class="sm" id="fmAdd" type="button">+ Add Medicine</button></div>
                    </div>
                    <div class="fm-bar">
                        <input id="fmQ" placeholder="Search generic, brand, form, strength…" style="max-width:360px">
                        <div class="chips" id="fmChips" style="margin:0">
                            <div class="chip active" data-v="all">All</div>
                            <div class="chip" data-v="yes">In Bizbox</div>
                            <div class="chip" data-v="no">Not in Bizbox</div>
                            <div class="chip" data-v="removed">Removed</div>
                        </div>
                        <span class="muted" id="fmCount" style="margin-left:auto;font-size:12.5px"></span>
                    </div>
                    <div class="tbl-wrap"><table class="dense fm-grid" id="fmGrid"></table></div>
                    <div class="pager">
                        <button class="ghost sm" id="fmPrev" type="button">‹ Previous</button>
                        <span id="fmPg"></span>
                        <button class="ghost sm" id="fmNext" type="button">Next ›</button>
                    </div>
                </div>
            </div>
            <div id="medImport" style="display:none"></div>

            <dialog id="fmEditDlg" class="dlg dlg-wide" aria-labelledby="fmEditTitle">
                <div class="dlg-head"><h3 class="dlg-title" id="fmEditTitle">Edit medicine</h3></div>
                <div class="mb-row">
                    <div class="search-wrap mb-f2"><label for="fe-generic">Generic</label><input id="fe-generic" autocomplete="off"></div>
                    <div class="search-wrap"><label for="fe-brand">Brand</label><input id="fe-brand" autocomplete="off" placeholder="blank = unbranded"></div>
                    <div class="search-wrap"><label for="fe-form">Form</label><input id="fe-form" autocomplete="off"></div>
                    <div class="search-wrap"><label for="fe-strength">Strength</label><input id="fe-strength" autocomplete="off"></div>
                </div>
                <div class="mb-row">
                    <div class="search-wrap mb-f3"><label for="fe-desc">Brand / Form / Strength as Bizbox writes it</label><input id="fe-desc" autocomplete="off" placeholder="leave blank to build it from the fields above"></div>
                    <div class="search-wrap"><label for="fe-reg">Registration No.</label><input id="fe-reg" autocomplete="off"></div>
                    <div class="mb-qty"><label for="fe-vol">Vol (mL)</label><input id="fe-vol" type="number" min="0" step="any"></div>
                </div>
                <label class="mb-check" style="margin-top:12px"><input type="checkbox" id="fe-ihf"> In Bizbox</label>
                <div class="errbox" id="fmEditErr"></div>
                <div class="dlg-actions">
                    <button class="ghost" id="fmEditCancel" type="button">Cancel</button>
                    <button id="fmEditSave" type="button">Save</button>
                </div>
            </dialog>

            <dialog id="fmAddDlg" class="dlg dlg-wide" aria-labelledby="fmAddTitle">
                <div class="dlg-head">
                    <h3 class="dlg-title" id="fmAddTitle">Add Medicine</h3>
                    <span id="faStatus" class="mb-status"></span>
                </div>
                <p class="sub" style="margin:0 0 12px">For a medicine Bizbox carries that the RX Formulary still calls "not in Bizbox". Search the list first — most already exist and only need to be marked.</p>
                <div id="faWidget"></div>
                <div class="mb-row" style="margin-top:10px">
                    <div class="search-wrap"><label for="fa-reg">Registration No. (optional)</label><input id="fa-reg" autocomplete="off" placeholder="DR-XY12345"></div>
                </div>
                <div class="mb-note" id="faNote" style="display:none"></div>
                <div class="similar" id="faSimilar"></div>
                <div class="errbox" id="fmAddErr"></div>
                <div class="dlg-actions">
                    <button class="ghost" id="fmAddCancel" type="button">Cancel</button>
                    <button id="fmAddSave" type="button">Add to RX Formulary</button>
                </div>
            </dialog>`;
        const $ = (id) => root.querySelector('#' + id);

        // ---------- tabs ----------
        let importMounted = false;
        root.querySelectorAll('#medTabs .tab').forEach((b) => {
            b.onclick = () => {
                tab = b.dataset.t;
                root.querySelectorAll('#medTabs .tab').forEach((x) => x.classList.toggle('active', x === b));
                $('medList').style.display = tab === 'list' ? '' : 'none';
                $('medImport').style.display = tab === 'import' ? '' : 'none';
                if (tab === 'import' && !importMounted) { importMounted = true; BizboxImport.mount($('medImport')); }
                if (tab === 'list') load();
            };
        });

        // ---------- list ----------
        async function load() {
            const p = new URLSearchParams({ q, bizbox, limit: PAGE, offset });
            const res = await api('/api/formulary?' + p);
            if (!res.ok) { $('fmGrid').innerHTML = `<tbody><tr><td class="muted">${esc(res.data.message || 'Could not load')}</td></tr></tbody>`; return; }
            rows = res.data.rows; total = res.data.total;
            render();
        }
        function render() {
            $('fmCount').textContent = `${total} medicine${total === 1 ? '' : 's'}`;
            $('fmPg').textContent = total ? `${offset + 1}–${Math.min(offset + PAGE, total)} of ${total}` : '';
            $('fmPrev').disabled = offset === 0;
            $('fmNext').disabled = offset + PAGE >= total;
            $('fmGrid').innerHTML = `<thead><tr><th>Generic</th><th>Brand / Form / Strength</th><th>Brand</th><th>Form</th><th>Strength</th><th>Bizbox</th><th>Reg. No.</th><th></th></tr></thead>
                <tbody>${rows.map((r, i) => `<tr>
                    <td><b>${esc(r.generic)}</b>${r.inPnf ? ' <span class="badge navy" title="Philippine National Formulary">PNF</span>' : ''}</td>
                    <td>${esc(r.description || '')}</td>
                    <td class="muted">${esc(r.brand || '—')}</td><td class="muted">${esc(r.form || '—')}</td><td class="muted">${esc(r.strength || '—')}</td>
                    <td>${r.inFormulary ? '<span class="badge green">In Bizbox</span>' : '<span class="badge gray">Not marked</span>'}</td>
                    <td class="muted mono">${esc(r.registrationNumber || '')}</td>
                    <td class="row-actions">${r.deletedAt ? `<span class="badge red">removed</span> <button class="green sm" data-restore="${i}" type="button">Restore</button>` : `<button class="ghost sm" data-edit="${i}" type="button">Edit</button>`}</td>
                </tr>`).join('')}${rows.length ? '' : '<tr><td colspan="8" class="muted" style="text-align:center;padding:24px">Nothing matches.</td></tr>'}</tbody>`;
            $('fmGrid').querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => openEdit(rows[Number(b.dataset.edit)]); });
            $('fmGrid').querySelectorAll('[data-restore]').forEach((b) => {
                b.onclick = async () => {
                    const r = rows[Number(b.dataset.restore)];
                    const res = await api(`/api/formulary/${r.id}/restore`, { body: {} });
                    if (!res.ok) { await showDialog({ kind: 'danger', title: 'Could not restore', message: res.data.message || 'Try again.' }); return; }
                    load();
                };
            });
        }
        let qt = null;
        $('fmQ').oninput = () => { clearTimeout(qt); qt = setTimeout(() => { q = $('fmQ').value.trim(); offset = 0; load(); }, 250); };
        $('fmChips').querySelectorAll('.chip').forEach((c) => { c.onclick = () => { bizbox = c.dataset.v; $('fmChips').querySelectorAll('.chip').forEach((x) => x.classList.toggle('active', x === c)); offset = 0; load(); }; });
        $('fmPrev').onclick = () => { offset = Math.max(0, offset - PAGE); load(); };
        $('fmNext').onclick = () => { offset += PAGE; load(); };

        // ---------- edit / merge ----------
        const editDlg = $('fmEditDlg');
        let editing = null;
        const editErr = (m) => { $('fmEditErr').textContent = m; $('fmEditErr').classList.add('show'); };
        function openEdit(r) {
            editing = r;
            $('fe-generic').value = r.generic || ''; $('fe-brand').value = r.brand || ''; $('fe-form').value = r.form || ''; $('fe-strength').value = r.strength || '';
            $('fe-desc').value = r.description || ''; $('fe-reg').value = r.registrationNumber || ''; $('fe-vol').value = r.volumeMl == null ? '' : r.volumeMl;
            $('fe-ihf').checked = !!r.inFormulary;
            $('fmEditErr').classList.remove('show');
            editDlg.showModal();
        }
        $('fmEditCancel').onclick = () => editDlg.close();
        $('fmEditSave').onclick = async () => {
            $('fmEditErr').classList.remove('show');
            const body = {
                generic: $('fe-generic').value, brand: $('fe-brand').value, form: $('fe-form').value, strength: $('fe-strength').value,
                description: $('fe-desc').value, registrationNumber: $('fe-reg').value, volumeMl: $('fe-vol').value, inFormulary: $('fe-ihf').checked,
            };
            const btn = $('fmEditSave'); btn.disabled = true;
            const res = await api(`/api/formulary/${editing.id}`, { body });
            btn.disabled = false;
            if (res.status === 409 && res.data.existing) {
                const ex = res.data.existing;
                const go = await showDialog({
                    kind: 'warn', title: 'This entry already exists',
                    message: `The RX Formulary already has:\n${ex.generic} — ${ex.description}${ex.inFormulary ? ' (In Bizbox)' : ''}\n\nMerge this one into it? The duplicate moves to Removed (restorable); the kept entry stays In Bizbox if either was.`,
                    actions: [{ label: 'Merge into it', value: true, variant: 'primary' }, { label: 'Keep both', value: false, variant: 'ghost', cancel: true }],
                });
                if (!go) return;
                const m = await api(`/api/formulary/${editing.id}/merge`, { body: { intoId: ex.id } });
                if (!m.ok) { editErr(m.data.message || 'Could not merge'); return; }
                editDlg.close(); load(); return;
            }
            if (!res.ok) { editErr(res.data.message || 'Could not save'); return; }
            editDlg.close(); load();
        };

        // ---------- add (same rules as before, now here) ----------
        const addDlg = $('fmAddDlg');
        $('faWidget').innerHTML = MedWidget.html('fa-', 'fasg-', { vol: true });
        const faWidget = MedWidget.create({ p: 'fa-', sg: 'fasg-', statusId: 'faStatus', noteId: 'faNote', splitNoteId: 'fa-splitNote', confirmBizbox: false });
        const addErr = (m) => { $('fmAddErr').textContent = m; $('fmAddErr').classList.add('show'); };
        async function loadSimilar(generic, brand) {
            const host = $('faSimilar');
            host.innerHTML = '<h5>Also under this generic</h5><div class="muted" style="font-size:12.5px">Looking…</div>';
            const res = await api(`/api/formulary/similar?generic=${encodeURIComponent(generic || '')}&brand=${encodeURIComponent(brand || '')}`);
            const list = res.ok ? res.data.products || [] : [];
            if (!list.length) { host.innerHTML = '<h5>Also under this generic</h5><div class="muted" style="font-size:12.5px">Nothing else listed under this generic.</div>'; return; }
            host.innerHTML = '<h5>Also under this generic — click one if it is the same product</h5>' + list.map((p, i) => `
                <div class="opt" data-i="${i}"><span>${esc(p.description || [p.brand, p.strength, p.form].filter(Boolean).join(' '))}</span>
                <span class="badge ${p.inFormulary ? 'green' : 'amber'}">${p.inFormulary ? 'In Bizbox' : 'Not marked'}</span></div>`).join('');
            host.querySelectorAll('.opt').forEach((el) => {
                el.onclick = () => {
                    const p = list[Number(el.dataset.i)];
                    host.querySelectorAll('.opt').forEach((x) => x.classList.remove('chosen')); el.classList.add('chosen');
                    faWidget.load({ genericName: p.generic, brandName: p.brand, formName: p.form, strength: p.strength, description: p.description, fromCatalog: true, volumeMl: p.volumeMl });
                };
            });
        }
        $('fmAdd').onclick = () => { faWidget.reset(); $('fa-reg').value = ''; $('fmAddErr').classList.remove('show'); $('faSimilar').innerHTML = ''; addDlg.showModal(); faWidget.focus('generic'); };
        let simT = null;
        ['fa-generic', 'fa-brand', 'fa-combo'].forEach((id) => {
            $(id).addEventListener('input', () => {
                clearTimeout(simT);
                simT = setTimeout(() => { const s = faWidget.values(); if (s.generic.length >= 2) loadSimilar(s.generic, s.picked ? '' : s.brand); }, 400);
            });
        });
        $('fmAddCancel').onclick = () => addDlg.close();
        addDlg.addEventListener('close', () => faWidget.hideBoxes());
        $('fmAddSave').onclick = async () => {
            $('fmAddErr').classList.remove('show');
            const s = faWidget.values();
            if (!s.generic) { addErr('Enter the generic name.'); faWidget.focus('generic'); return; }
            if (!s.picked && !s.form && !s.strength) { addErr('Pick the product from the list, or fill in at least the form or the strength.'); return; }
            const body = { generic: s.generic, brand: s.brand, form: s.form, strength: s.strength, description: s.description, volumeMl: s.volumeMl, registrationNumber: $('fa-reg').value.trim() };
            const btn = $('fmAddSave'); btn.disabled = true;
            let res = await api('/api/formulary', { body });
            if (res.ok && res.data.needsConfirm) {
                const m = res.data.matches;
                const lines = m.map((x) => `• ${x.label} — ${x.prescriptions} RX, ${x.reason === 'not_in_formulary' ? 'Not in Bizbox' : 'Out of stock'}, ${x.status.replace(/_/g, ' ')}`).join('\n');
                const go = await showDialog({
                    kind: 'warn', title: 'This medicine is being tracked in Pharmacy Review',
                    message: `${lines}\n\nMarking it In Bizbox will mark the Not-in-Bizbox row${m.length > 1 ? 's' : ''} as Added to Bizbox and resolve ${m.length > 1 ? 'them' : 'it'}. Continue?`,
                    actions: [{ label: 'Yes, add and resolve', value: true, variant: 'primary' }, { label: 'Cancel', value: false, variant: 'ghost', cancel: true }],
                });
                if (!go) { btn.disabled = false; return; }
                res = await api('/api/formulary', { body: { ...body, confirm: true } });
            }
            btn.disabled = false;
            if (!res.ok) { addErr(res.data.message || 'Could not add the medicine'); return; }
            addDlg.close();
            await showDialog({ kind: 'ok', title: 'Added', message: `${res.data.label} is in the RX Formulary and marked In Bizbox${res.data.created ? ' (new entry)' : ''}.` + (res.data.resolved ? `\n${res.data.resolved} review row${res.data.resolved > 1 ? 's' : ''} resolved.` : '') });
            load();
        };

        load();
        return { reload: load };
    }

    global.RxFormulary = { mount };
})(window);
