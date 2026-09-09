(async function () {
    const $ = (id) => document.getElementById(id);
    const me = await api('/api/auth/me');
    if (!me.ok) { window.location.href = '/login'; return; }
    if (me.data.user.role === 'it') { window.location.href = '/it'; return; }
    const user = me.data.user;
    const isStaff = user.role === 'staff';
    const isAdmin = user.role === 'admin';

    mountRail({ mode: 'pharmacy', active: 'review' });
    $('railUser').textContent = `${user.name} · ${user.role}`;

    // tab -> which rows we show
    const TABS = [
        ['review', 'Needs Review'],
        ['anomaly', 'In-stock Anomalies'],
        ['resolved', 'Resolved'],
    ];
    let tab = 'review', q = '';
    let problems = [], anomalies = [], current = null;
    const selected = new Map();   // key -> row

    // remark presets — the server's list is the truth, this is the fallback
    // for the moment before it answers
    let PRESETS = {
        available_in_bizbox: 'Available in Bizbox', ordered: 'Ordered', for_order: 'For Order',
        other_brand_only: 'Only other brand available', under_therapeutics: 'Under Therapeutics review', other: 'Other',
    };
    api('/api/pharmacy/remarks?key=_&reason=_').then((r) => { if (r.ok && r.data.presets) PRESETS = r.data.presets; fillPresetSelect(); }).catch(() => {});

    const fmtDT = (t) => (t ? new Date(t).toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit', hour: 'numeric', minute: '2-digit' }) : '');
    const reasonBadge = (r) => r === 'not_in_formulary' ? '<span class="badge navy">Not in Bizbox</span>'
        : r === 'out_of_stock' ? '<span class="badge amber">Out of stock</span>'
        : '<span class="badge red">In stock — anomaly</span>';
    const statusBadge = (r) => {
        if (r.status === 'added_to_formulary') return `<span class="badge green">Added to Bizbox</span> <span class="muted">${fmtDT(r.statusDate)}</span>`;
        if (r.status === 'restocked') return `<span class="badge green">Restocked</span> <span class="muted">${fmtDT(r.statusDate)}</span>`;
        if (r.status === 'under_therapeutics') return '<span class="badge amber">Under Therapeutics</span>';
        return '<span class="badge gray">Pending</span>';
    };
    const REMARK_TONE = { available_in_bizbox: 'green', ordered: 'amber', for_order: 'amber', other_brand_only: 'navy', under_therapeutics: 'amber', other: 'gray' };
    const remarkBadge = (k) => `<span class="badge ${REMARK_TONE[k] || 'gray'}">${escapeHtml(PRESETS[k] || k)}</span>`;
    const remarkCell = (r) => {
        if (!r.lastRemark) return '<span class="muted">—</span>';
        const more = r.remarks.length > 1 ? `<span class="n">+${r.remarks.length - 1} earlier</span>` : '';
        return `<div class="rmk-cell">${remarkBadge(r.lastRemark.remark)}${r.lastRemark.note ? `<span class="note" title="${escapeHtml(r.lastRemark.note)}">${escapeHtml(r.lastRemark.note)}</span>` : ''}${more}</div>`;
    };

    // ---------- filters (Notion-style bar; see js/filterbar.js) ----------
    const allRows = () => problems.concat(anomalies);
    const uniq = (get) => [...new Set(allRows().flatMap(get))].filter(Boolean).sort((a, b) => a.localeCompare(b)).map((v) => ({ value: v, label: v }));
    const fbar = FilterBar.create({
        mount: $('filterbar'), storageKey: 'rx_review_filters', onChange: () => { selected.clear(); render(); },
        fields: [
            { key: 'reason', label: 'Bizbox status', type: 'enum', get: (r) => r.reason, options: [
                { value: 'not_in_formulary', label: 'Not in Bizbox' }, { value: 'out_of_stock', label: 'Out of stock' }, { value: 'normal', label: 'In stock (anomaly)' }] },
            { key: 'status', label: 'Review status', type: 'enum', get: (r) => r.status, options: [
                { value: 'pending', label: 'Pending' }, { value: 'under_therapeutics', label: 'Under Therapeutics' },
                { value: 'added_to_formulary', label: 'Added to Bizbox' }, { value: 'restocked', label: 'Restocked' }] },
            { key: 'remark', label: 'Latest remark', type: 'enum', get: (r) => (r.lastRemark ? r.lastRemark.remark : ''),
                options: () => Object.entries(PRESETS).map(([value, label]) => ({ value, label })) },
            { key: 'department', label: 'Department', type: 'enum', get: (r) => r.departments, options: () => uniq((r) => r.departments) },
            { key: 'doctor', label: 'Doctor', type: 'enum', get: (r) => r.doctors, options: () => uniq((r) => r.doctors) },
            { key: 'generic', label: 'Generic', type: 'text', get: (r) => r.generic },
            { key: 'description', label: 'Brand/Form/Strength', type: 'text', get: (r) => r.description },
            { key: 'rx', label: '# RX', type: 'number', get: (r) => r.prescriptions },
            { key: 'qty', label: '# Prescribed', type: 'number', get: (r) => r.volume },
            { key: 'last', label: 'Last prescribed', type: 'date', get: (r) => r.lastDate },
        ],
    });

    // ---------- data ----------
    // everything once; department and the rest are filters over these rows
    async function load() {
        const [a, b] = await Promise.all([
            api('/api/pharmacy/review?reason=both'),
            api('/api/pharmacy/review?reason=normal'),
        ]);
        if (!a.ok || !b.ok) { window.location.href = '/login'; return; }
        problems = a.data.review;
        anomalies = b.data.review;
        selected.clear();
        render();
    }

    function rowsForTab() {
        let rows = tab === 'anomaly' ? anomalies
            : tab === 'resolved' ? problems.filter((r) => r.resolved)
            : problems.filter((r) => !r.resolved);
        const total = rows.length;
        rows = fbar.apply(rows);
        if (q) rows = rows.filter((r) => `${r.generic} ${r.description} ${r.label}`.toLowerCase().includes(q));
        fbar.setCount(rows.length, total);
        return rows;
    }

    // ---------- render ----------
    function renderTabs() {
        $('tabs').innerHTML = TABS.map(([v, l]) =>
            `<button class="tab ${v === tab ? 'active' : ''}" data-v="${v}">${l}</button>`).join('');
        $('tabs').querySelectorAll('.tab').forEach((t) => {
            t.onclick = () => { tab = t.dataset.v; selected.clear(); render(); };
        });
    }

    function render() {
        renderTabs();
        const active = problems.filter((r) => !r.resolved);
        $('kp-total').textContent = active.length;
        $('kp-nif').textContent = active.filter((r) => r.reason === 'not_in_formulary').length;
        $('kp-oos').textContent = active.filter((r) => r.reason === 'out_of_stock').length;
        $('kp-anom').textContent = anomalies.length;
        $('kp-resolved').textContent = problems.filter((r) => r.resolved).length;

        const rows = rowsForTab();
        $('count').textContent = `${rows.length} medicine${rows.length === 1 ? '' : 's'}`;
        $('empty').style.display = rows.length ? 'none' : 'block';

        const anom = tab === 'anomaly';
        // "# Prescribed" is a count of units, never millilitres: a liquid
        // medicine has a real volume in mL and the two must not share a word
        $('thead').innerHTML = anom
            ? `<th class="sel"></th><th>Generic</th><th>Brand/Form/Strength</th><th># RX</th><th># Prescribed</th><th>Departments</th><th>Doctors</th><th>Last prescribed</th><th>Remarks</th>`
            : `<th class="sel"><input type="checkbox" id="selAll"></th><th>Generic</th><th>Brand/Form/Strength</th><th>Reason</th><th># RX</th><th># Prescribed</th><th>Departments</th><th>Status</th><th>Remarks</th>`;

        $('tbl').innerHTML = rows.map((r, i) => anom ? `
            <tr class="clickable" data-i="${i}">
                <td class="sel"></td>
                <td><b>${escapeHtml(r.generic)}</b></td>
                <td>${escapeHtml(r.description || '—')}</td>
                <td>${r.prescriptions}</td>
                <td>${r.volume}</td>
                <td class="muted">${escapeHtml(r.departments.join(', '))}</td>
                <td class="muted">${escapeHtml(r.byDoctor.map((x) => drName(x.name)).join('; '))}</td>
                <td>${fmtDT(r.lastDate)}</td>
                <td>${remarkCell(r)}</td>
            </tr>` : `
            <tr class="clickable" data-i="${i}">
                <td class="sel"><input type="checkbox" data-k="${escapeHtml(r.reason + '::' + r.key)}" ${selected.has(r.reason + '::' + r.key) ? 'checked' : ''}></td>
                <td><b>${escapeHtml(r.generic)}</b></td>
                <td>${escapeHtml(r.description || '—')}</td>
                <td>${reasonBadge(r.reason)}</td>
                <td>${r.prescriptions}</td>
                <td>${r.volume}</td>
                <td class="muted">${escapeHtml(r.departments.join(', '))}</td>
                <td>${statusBadge(r)}</td>
                <td>${remarkCell(r)}</td>
            </tr>`).join('');

        // row click -> detail drawer (ignore clicks on the checkbox)
        $('tbl').querySelectorAll('tr').forEach((tr) => {
            tr.onclick = (e) => { if (e.target.type !== 'checkbox') openDetail(rows[Number(tr.dataset.i)], tr); };
        });
        $('tbl').querySelectorAll('input[type=checkbox]').forEach((cb) => {
            cb.onclick = (e) => e.stopPropagation();
            cb.onchange = () => {
                const r = rows[Number(cb.closest('tr').dataset.i)];
                const k = r.reason + '::' + r.key;
                cb.checked ? selected.set(k, r) : selected.delete(k);
                renderBulk();
            };
        });
        const all = $('selAll');
        if (all) all.onchange = () => {
            rows.forEach((r) => {
                const k = r.reason + '::' + r.key;
                all.checked ? selected.set(k, r) : selected.delete(k);
            });
            render();
        };
        renderBulk();
    }

    // ---------- bulk ----------
    function renderBulk() {
        const n = selected.size;
        $('bulkbar').classList.toggle('show', n > 0);
        $('selCount').textContent = n;
        if (!n) return;
        const rs = [...selected.values()];
        const allNIF = rs.every((r) => r.reason === 'not_in_formulary');
        const allOOS = rs.every((r) => r.reason === 'out_of_stock');
        let acts = '';
        if (allNIF) acts = '<button data-a="under_therapeutics">Send to Therapeutics</button><button data-a="added_to_formulary">Mark Added to Bizbox</button>';
        else if (allOOS) acts = '<button data-a="restocked">Mark Restocked</button>';
        else acts = '<span class="muted" style="color:#cbd7f0">Select one reason at a time to act</span>';
        $('bulkActions').innerHTML = acts;
        $('bulkActions').querySelectorAll('button').forEach((b) => { b.onclick = () => doBulk(b.dataset.a); });
    }
    $('bulkClear').onclick = () => { selected.clear(); render(); };

    let pendingAction = null;
    async function doBulk(action) {
        if (isStaff) { pendingAction = action; $('bErr').classList.remove('show'); $('bAuth').value = ''; $('bulkModal').classList.add('show'); return; }
        await sendBulk(action, '');
    }
    async function sendBulk(action, pw) {
        const drugs = [...selected.values()].map((r) => ({
            key: r.key, reason: r.reason, label: r.label,
            generic: r.generic, brand: r.brand, form: r.form, strength: r.strength,
        }));
        const res = await api('/api/pharmacy/status/bulk', { body: { drugs, action, authorizerPassword: pw } });
        if (res.ok) { $('bulkModal').classList.remove('show'); load(); }
        else {
            // staff read the reason inside the authorize modal they are already
            // looking at; an admin never opened it, so they get the dialog
            $('bErr').textContent = res.data.message || 'Could not update';
            $('bErr').classList.add('show');
            if (!isStaff) {
                await showDialog({
                    kind: 'danger', title: 'Could not update',
                    message: res.data.message || 'Nothing was changed. Try again in a moment.',
                });
            }
        }
    }
    $('bCancel').onclick = () => $('bulkModal').classList.remove('show');
    $('bConfirm').onclick = () => sendBulk(pendingAction, $('bAuth').value);

    // ---------- detail drawer ----------
    const detail = $('detail');

    function showDetail(on) {
        detail.classList.toggle('open', on);   // overlays the table; no reflow
        if (!on) document.querySelectorAll('#tbl tr.selected').forEach((tr) => tr.classList.remove('selected'));
    }

    function actionButtons(r) {
        if (r.reason === 'normal') return '';
        if (r.reason === 'not_in_formulary') {
            if (r.status === 'added_to_formulary') return '';
            let h = '';
            if (r.status === 'pending') h += '<button class="ghost sm" data-action="under_therapeutics">Send to Therapeutics</button>';
            return h + '<button class="green sm" data-action="added_to_formulary">Mark Added to Bizbox</button>';
        }
        return r.status === 'restocked' ? '' : '<button class="green sm" data-action="restocked">Mark Restocked</button>';
    }

    const kv = (k, v) => `<div><div class="k">${k}</div><div class="v">${escapeHtml(v || '—')}</div></div>`;

    function openDetail(row, tr) {
        current = { row };
        document.querySelectorAll('#tbl tr.selected').forEach((x) => x.classList.remove('selected'));
        if (tr) tr.classList.add('selected');

        $('dTitle').textContent = row.generic;
        $('dSubtitle').textContent = [row.description, row.registrationNumber ? 'Reg. No. ' + row.registrationNumber : '']
            .filter(Boolean).join(' · ');
        $('dBadges').innerHTML = reasonBadge(row.reason) + ' ' + statusBadge(row);

        $('d-rx').textContent = row.prescriptions;
        $('d-vol').textContent = row.volume;
        $('d-dept').textContent = row.departments.length;

        $('dRows').innerHTML = [...row.byDoctor].sort((a, b) => b.lastDate - a.lastDate)
            .map((x) => `<tr><td>${escapeHtml(drName(x.name))}</td><td>${x.prescriptions}</td><td>${x.volume}</td><td>${fmtDT(x.lastDate)}</td></tr>`).join('');
        $('dDept').innerHTML = [...row.byDepartment].sort((a, b) => b.lastDate - a.lastDate)
            .map((x) => `<tr><td>${escapeHtml(x.name)}</td><td>${x.prescriptions}</td><td>${x.volume}</td></tr>`).join('');

        const reasonLabel = row.reason === 'not_in_formulary' ? 'Not in Bizbox'
            : row.reason === 'out_of_stock' ? 'Out of stock' : 'In stock (anomaly)';
        $('dGrid').innerHTML =
            kv('Generic', row.generic) + kv('Brand', row.brand) +
            kv('Form', row.form) + kv('Strength', row.strength) +
            // real millilitres, unlike the "# Prescribed" stat above. Lists every
            // volume seen, since one drug row can cover several.
            kv('Volume (mL)', (row.volumesMl || []).length ? row.volumesMl.join(', ') + ' mL' : null) +
            kv('Registration No.', row.registrationNumber) + kv('Reason', reasonLabel) +
            kv('Status', row.status.replace(/_/g, ' ')) + kv('Last prescribed', fmtDT(row.lastDate));

        $('dAuthWrap').style.display = isStaff ? 'block' : 'none';
        $('dAuth').value = '';
        $('dErr').classList.remove('show');
        $('dActions').innerHTML = actionButtons(row);
        $('dActions').querySelectorAll('button').forEach((b) => { b.onclick = () => doStatus(b.dataset.action); });

        renderRemarks(row);
        showDetail(true);
    }

    const detailError = (msg) => { $('dErr').textContent = msg; $('dErr').classList.add('show'); };

    async function doStatus(action) {
        const { row } = current;
        const body = {
            key: row.key, reason: row.reason, action,
            drug: { label: row.label, generic: row.generic, brand: row.brand, form: row.form, strength: row.strength },
        };
        if (isStaff) body.authorizerPassword = $('dAuth').value;
        const res = await api('/api/pharmacy/status', { body });
        if (res.ok) { showDetail(false); load(); }
        else detailError(res.data.message || 'Could not update');
    }
    $('dClose').onclick = () => showDetail(false);

    // after a change, show the same drug again with fresh numbers
    async function reloadAndReopen(reason, key) {
        await load();
        const row = allRows().find((r) => r.reason === reason && r.key === key);
        if (row) openDetail(row, null); else showDetail(false);
    }

    // ---------- remarks ----------
    function fillPresetSelect() {
        const sel = $('rmkPreset');
        const keep = sel.value;
        sel.innerHTML = Object.entries(PRESETS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
        if (keep && PRESETS[keep]) sel.value = keep;
    }
    fillPresetSelect();

    function renderRemarks(row) {
        const list = row.remarks || [];
        $('dRemarks').innerHTML = list.length ? list.map((r) => `
            <div class="remark">
                <div class="top">${remarkBadge(r.remark)}<span class="who">${escapeHtml(r.actor || '')}${r.authorizedBy && r.authorizedBy !== r.actor ? ` · auth. ${escapeHtml(r.authorizedBy)}` : ''} · ${fmtDT(r.at)}</span></div>
                ${r.note ? `<div class="note">${escapeHtml(r.note)}</div>` : ''}
            </div>`).join('')
            : '<div class="muted" style="font-size:12.5px">No remarks yet.</div>';
        $('rmkNote').value = '';
        // a resolved row still takes remarks (why it was closed), but the
        // preset that resolves cannot resolve twice
        const opt = $('rmkPreset').querySelector('option[value="available_in_bizbox"]');
        if (opt) opt.disabled = !!row.resolved;
        if (row.resolved && $('rmkPreset').value === 'available_in_bizbox') $('rmkPreset').value = 'other';
    }

    $('rmkAdd').onclick = async () => {
        const { row } = current;
        const remark = $('rmkPreset').value;
        $('dErr').classList.remove('show');
        if (remark === 'available_in_bizbox') { openResolve(row); return; }
        const body = { key: row.key, reason: row.reason, remark, note: $('rmkNote').value.trim(), drug: { label: row.label } };
        if (isStaff) body.authorizerPassword = $('dAuth').value;
        const btn = $('rmkAdd'); btn.disabled = true;
        const res = await api('/api/pharmacy/remarks', { body });
        btn.disabled = false;
        if (!res.ok) { detailError(res.data.message || 'Could not add the remark'); return; }
        await reloadAndReopen(row.reason, row.key);
    };

    // ---------- "Available in Bizbox": the careful resolve ----------
    // Three steps for a not-in-Bizbox row: what will happen, review the
    // medicine that goes into Bizbox, confirm. Two for out-of-stock (the
    // product is already in Bizbox — nothing to review) and for an anomaly
    // (nothing to resolve; the remark alone is recorded).
    const rvDlg = $('resolveDlg');
    $('rvWidget').innerHTML = MedWidget.html('r-', 'rsg-', { vol: true });
    const rvWidget = MedWidget.create({ p: 'r-', sg: 'rsg-', statusId: 'rvStatus', noteId: 'rvNote', splitNoteId: 'r-splitNote', clearsBelow: false, confirmBizbox: false });
    let rv = null;      // { row, steps: [1,2,3] | [1,3], at: index }

    const STEP_NAMES = { 1: 'What will happen', 2: 'Review the medicine', 3: 'Confirm' };
    function renderSteps() {
        $('rvSteps').innerHTML = rv.steps.map((n, i) => `<div class="step ${i === rv.at ? 'active' : i < rv.at ? 'done' : ''}"><span class="n">${i + 1}</span>${STEP_NAMES[n]}</div>`).join('');
        rvDlg.querySelectorAll('.step-pane').forEach((p) => p.classList.toggle('active', Number(p.dataset.step) === rv.steps[rv.at]));
        $('rvBack').style.visibility = rv.at > 0 ? 'visible' : 'hidden';
        $('rvNext').textContent = rv.at === rv.steps.length - 1 ? 'Confirm' : 'Next';
        $('rvErr').classList.remove('show');
    }
    const rvError = (msg) => { $('rvErr').textContent = msg; $('rvErr').classList.add('show'); };

    function openResolve(row) {
        const nif = row.reason === 'not_in_formulary';
        rv = { row, steps: nif ? [1, 2, 3] : [1, 3], at: 0 };
        $('rvWhat').innerHTML = nif
            ? `<b>${escapeHtml(row.generic)}, ${escapeHtml(row.description)}</b> will be added to Bizbox in this system and this row will be marked <b>Added to Bizbox</b> and move to Resolved.<br><br>From then on the nurse's screen shows it as <b>In Bizbox</b> — prescribing it here will ask "are you sure?". Next, you will check the medicine before anything is saved.`
            : row.reason === 'out_of_stock'
                ? `<b>${escapeHtml(row.generic)}, ${escapeHtml(row.description)}</b> is already in Bizbox. Recording it as available marks this row <b>Restocked</b> and moves it to Resolved.`
                : `<b>${escapeHtml(row.generic)}, ${escapeHtml(row.description)}</b> is in Bizbox and was prescribed here anyway. The remark is recorded on this anomaly for the audit; nothing else changes.`;
        if (nif) {
            rvWidget.load({ genericName: row.generic, brandName: row.brand, formName: row.form, strength: row.strength, description: row.description, fromCatalog: false, volumeMl: (row.volumesMl || [])[0] || null });
            loadSimilar($('rvSimilar'), rvWidget, row.generic, row.brand);
        }
        $('rvNoteText').value = $('rmkNote').value.trim();
        $('rvAuthWrap').style.display = isStaff ? 'block' : 'none';
        $('rvAuth').value = isStaff ? $('dAuth').value : '';
        renderSteps();
        rvDlg.showModal();
    }

    // every product under this generic (and brand): Bizbox ones first. Click
    // one to make it the medicine being added — "same product, other spelling"
    async function loadSimilar(host, widget, generic, brand) {
        host.innerHTML = '<h5>Also under this generic</h5><div class="muted" style="font-size:12.5px">Looking…</div>';
        const res = await api(`/api/pharmacy/catalog/similar?generic=${encodeURIComponent(generic || '')}&brand=${encodeURIComponent(brand || '')}`);
        const list = res.ok ? res.data.products || [] : [];
        if (!list.length) { host.innerHTML = '<h5>Also under this generic</h5><div class="muted" style="font-size:12.5px">Nothing else listed under this generic.</div>'; return; }
        host.innerHTML = '<h5>Also under this generic — click one if it is the same product</h5>' + list.map((p, i) => `
            <div class="opt" data-i="${i}">
                <span>${escapeHtml(p.description || [p.brand, p.strength, p.form].filter(Boolean).join(' '))}</span>
                <span class="badge ${p.inFormulary ? 'green' : 'amber'}">${p.inFormulary ? 'In Bizbox' : 'Not flagged'}</span>
            </div>`).join('');
        host.querySelectorAll('.opt').forEach((el) => {
            el.onclick = () => {
                const p = list[Number(el.dataset.i)];
                host.querySelectorAll('.opt').forEach((x) => x.classList.remove('chosen'));
                el.classList.add('chosen');
                widget.load({ genericName: p.generic, brandName: p.brand, formName: p.form, strength: p.strength, description: p.description, fromCatalog: true, volumeMl: p.volumeMl });
            };
        });
    }

    function fillSummary() {
        const s = rvWidget.values();
        const { row } = rv;
        const nif = row.reason === 'not_in_formulary';
        const rows = nif ? [
            ['Generic', s.generic], ['Brand / Form / Strength', s.description],
            ['Brand', s.brand || '—'], ['Form', s.form || '—'], ['Strength', s.strength || '—'],
            ['Will be marked', 'Added to Bizbox'],
        ] : [
            ['Generic', row.generic], ['Brand / Form / Strength', row.description],
            ['Will be marked', row.reason === 'out_of_stock' ? 'Restocked' : 'Remark only (anomaly)'],
        ];
        $('rvSummary').innerHTML = rows.map(([k, v]) => `<div class="k">${k}</div><div>${escapeHtml(v)}</div>`).join('');
    }

    $('rvCancel').onclick = () => rvDlg.close();
    $('rvBack').onclick = () => { if (rv.at > 0) { rv.at -= 1; renderSteps(); } };
    $('rvNext').onclick = async () => {
        const step = rv.steps[rv.at];
        if (step === 2) {
            const s = rvWidget.values();
            const miss = MedWidget.missingField(rvWidget, s);
            if (miss) { rvError(miss === 'generic' ? 'Enter the generic name.' : 'Pick the product from the list, or fill in the form and strength.'); rvWidget.focus(miss); return; }
        }
        if (rv.at < rv.steps.length - 1) {
            rv.at += 1;
            if (rv.steps[rv.at] === 3) fillSummary();
            renderSteps();
            return;
        }
        // confirm
        const { row } = rv;
        const body = { key: row.key, reason: row.reason, remark: 'available_in_bizbox', note: $('rvNoteText').value.trim(), drug: { label: row.label } };
        if (row.reason === 'not_in_formulary') {
            const s = rvWidget.values();
            body.resolve = { generic: s.generic, brand: s.brand, form: s.form, strength: s.strength, description: s.description, volumeMl: s.volumeMl };
        }
        if (isStaff) body.authorizerPassword = $('rvAuth').value;
        const btn = $('rvNext'); btn.disabled = true;
        const res = await api('/api/pharmacy/remarks', { body });
        btn.disabled = false;
        if (!res.ok) { rvError(res.data.message || 'Could not save'); return; }
        rvDlg.close();
        await showDialog({
            kind: 'ok', title: 'Recorded',
            message: res.data.resolvedStatus === 'added_to_formulary' ? `${row.generic}, ${row.description} is now in Bizbox and the row is resolved.`
                : res.data.resolvedStatus === 'restocked' ? `${row.generic}, ${row.description} is marked Restocked.`
                : 'The remark was added.',
        });
        await reloadAndReopen(row.reason, row.key);
    };
    rvDlg.addEventListener('close', () => rvWidget.hideBoxes());

    // ---------- Add Medicine (admin) ----------
    const amDlg = $('addMedDlg');
    $('amWidget').innerHTML = MedWidget.html('a-', 'asg-', { vol: true });
    const amWidget = MedWidget.create({ p: 'a-', sg: 'asg-', statusId: 'amStatus', noteId: 'amNote', splitNoteId: 'a-splitNote', confirmBizbox: false });
    const amError = (msg) => { $('amErr').textContent = msg; $('amErr').classList.add('show'); };

    if (isAdmin) {
        $('addMedBtn').style.display = '';
        $('addMedBtn').onclick = () => {
            amWidget.reset(); $('a-reg').value = ''; $('amErr').classList.remove('show'); $('amSimilar').innerHTML = '';
            amDlg.showModal();
            amWidget.focus('generic');
        };
        // the "also under this generic" list follows the generic and brand as they are typed
        let simT = null;
        ['a-generic', 'a-brand', 'a-combo'].forEach((id) => {
            $(id).addEventListener('input', () => {
                clearTimeout(simT);
                simT = setTimeout(() => {
                    const s = amWidget.values();
                    if (s.generic.length >= 2) loadSimilar($('amSimilar'), amWidget, s.generic, s.picked ? '' : s.brand);
                }, 400);
            });
        });
    }
    $('amCancel').onclick = () => amDlg.close();
    amDlg.addEventListener('close', () => amWidget.hideBoxes());
    $('amSave').onclick = async () => {
        $('amErr').classList.remove('show');
        const s = amWidget.values();
        if (!s.generic) { amError('Enter the generic name.'); amWidget.focus('generic'); return; }
        if (!s.picked && !s.form && !s.strength) { amError('Pick the product from the list, or fill in at least the form or the strength.'); amWidget.focus(amWidget.mode() === 'search' ? 'combo' : 'form'); return; }
        const body = { generic: s.generic, brand: s.brand, form: s.form, strength: s.strength, description: s.description, volumeMl: s.volumeMl, registrationNumber: $('a-reg').value.trim() };
        const btn = $('amSave'); btn.disabled = true;
        let res = await api('/api/pharmacy/catalog', { body });
        if (res.ok && res.data.needsConfirm) {
            const m = res.data.matches;
            const lines = m.map((x) => `• ${x.label} — ${x.prescriptions} RX, ${x.reason === 'not_in_formulary' ? 'Not in Bizbox' : 'Out of stock'}, ${x.status.replace(/_/g, ' ')}`).join('\n');
            const go = await showDialog({
                kind: 'warn', title: 'This medicine is being tracked in review',
                message: `The same medicine is open in Pharmacy Review:\n${lines}\n\nAdding it to Bizbox will mark the Not-in-Bizbox row${m.length > 1 ? 's' : ''} as Added to Bizbox and resolve ${m.length > 1 ? 'them' : 'it'}. Continue?`,
                actions: [{ label: 'Yes, add and resolve', value: true, variant: 'primary' }, { label: 'Cancel', value: false, variant: 'ghost', cancel: true }],
            });
            if (!go) { btn.disabled = false; return; }
            res = await api('/api/pharmacy/catalog', { body: { ...body, confirm: true } });
        }
        btn.disabled = false;
        if (!res.ok) { amError(res.data.message || 'Could not add the medicine'); return; }
        amDlg.close();
        await showDialog({
            kind: 'ok', title: 'Added to Bizbox',
            message: `${res.data.label} is now in Bizbox${res.data.created ? ' (new product)' : ''}.` + (res.data.resolved ? `\n${res.data.resolved} review row${res.data.resolved > 1 ? 's' : ''} resolved.` : ''),
        });
        load();
    };

    // ---------- search ----------
    let t = null;
    $('search').addEventListener('input', () => {
        clearTimeout(t); t = setTimeout(() => { q = $('search').value.trim().toLowerCase(); render(); }, 200);
    });

    await load();
})();
