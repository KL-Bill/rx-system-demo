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
    //   review    open, nobody has said anything about it yet
    //   reviewed  open, but carries a remark or sits with Therapeutics
    //   anomaly   in Bizbox and prescribed here anyway
    //   resolved  added to Bizbox / restocked
    const TABS = [
        ['review', 'To review'],
        ['reviewed', 'Reviewed'],
        ['anomaly', 'Prescribed but In Bizbox'],
        ['resolved', 'Resolved'],
    ];
    let tab = 'review', q = '';
    let problems = [], anomalies = [], current = null;
    const selected = new Map();   // key -> row
    const isReviewed = (r) => !r.resolved && ((r.remarks && r.remarks.length > 0) || r.status === 'under_therapeutics');

    // remark presets — the server's list is the truth, this is the fallback
    // for the moment before it answers
    let PRESETS = {
        available_in_bizbox: 'Available in Bizbox', ordered: 'Ordered', for_order: 'For Order',
        other_brand_only: 'Only other brand available', under_therapeutics: 'Under Therapeutics review', other: 'Other',
    };
    api('/api/pharmacy/remarks?key=_&reason=_').then((r) => { if (r.ok && r.data.presets) PRESETS = r.data.presets; }).catch(() => {});

    const fmtDT = (t) => (t ? new Date(t).toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit', hour: 'numeric', minute: '2-digit' }) : '');
    const reasonBadge = (r) => r === 'not_in_formulary' ? '<span class="badge navy">Not in Bizbox</span>'
        : r === 'out_of_stock' ? '<span class="badge amber">Out of stock</span>'
        : '<span class="badge red">Prescribed but In Bizbox</span>';
    const statusBadge = (r) => {
        if (r.status === 'added_to_formulary') return `<span class="badge green">Added to Bizbox</span> <span class="muted">${fmtDT(r.statusDate)}</span>`;
        if (r.status === 'restocked') return `<span class="badge green">Restocked</span> <span class="muted">${fmtDT(r.statusDate)}</span>`;
        if (r.status === 'under_therapeutics') return '<span class="badge amber">Under Therapeutics</span>';
        return '<span class="badge gray">Pending</span>';
    };
    const REMARK_TONE = { available_in_bizbox: 'green', ordered: 'amber', for_order: 'amber', other_brand_only: 'navy', under_therapeutics: 'amber', other: 'gray' };
    const remarkBadge = (k) => `<span class="badge ${REMARK_TONE[k] || 'gray'}">${escapeHtml(PRESETS[k] || k)}</span>`;
    // the Remarks cell: the latest remark, and the button that sets one —
    // the table is where the work happens, the side panel only explains
    const remarkCell = (r, i) => {
        const last = r.lastRemark
            ? `${remarkBadge(r.lastRemark.remark)}${r.lastRemark.note ? `<span class="note" title="${escapeHtml(r.lastRemark.note)}">${escapeHtml(r.lastRemark.note)}</span>` : ''}<span class="n">${escapeHtml(r.lastRemark.actor || '')} · ${fmtDT(r.lastRemark.at)}${r.remarks.length > 1 ? ` · +${r.remarks.length - 1} earlier` : ''}</span>`
            : '<span class="muted">No remark yet</span>';
        return `<div class="rmk-cell">${last}<button class="ghost sm rmk-set" type="button" data-rmk="${i}">${r.lastRemark ? 'Add remark' : 'Set remark'}</button></div>`;
    };

    // ---------- filters (Notion-style bar; see js/filterbar.js) ----------
    const allRows = () => problems.concat(anomalies);
    const uniq = (get) => [...new Set(allRows().flatMap(get))].filter(Boolean).sort((a, b) => a.localeCompare(b)).map((v) => ({ value: v, label: v }));
    const fbar = FilterBar.create({
        mount: $('filterbar'), storageKey: 'rx_review_filters', onChange: () => { selected.clear(); render(); },
        // the reason this system exists: which BRANDS are in demand that Bizbox
        // lacks. Unbranded requests are one click away from disappearing.
        quick: [
            { label: 'Branded only', filter: { key: 'brand', op: 'not_empty' }, group: 'brand' },
            { label: 'No brand only', filter: { key: 'brand', op: 'empty' }, group: 'brand' },
            { label: 'No remarks', filter: { key: 'remark', op: 'empty' } },
            { label: 'Not in Bizbox', filter: { key: 'reason', op: 'is', value: 'not_in_formulary' }, group: 'reason' },
            { label: 'Out of stock', filter: { key: 'reason', op: 'is', value: 'out_of_stock' }, group: 'reason' },
        ],
        fields: [
            { key: 'reason', label: 'Bizbox status', type: 'enum', get: (r) => r.reason, options: [
                { value: 'not_in_formulary', label: 'Not in Bizbox' }, { value: 'out_of_stock', label: 'Out of stock' }, { value: 'normal', label: 'Prescribed but In Bizbox' }] },
            { key: 'status', label: 'Review status', type: 'enum', get: (r) => r.status, options: [
                { value: 'pending', label: 'Pending' }, { value: 'under_therapeutics', label: 'Under Therapeutics' },
                { value: 'added_to_formulary', label: 'Added to Bizbox' }, { value: 'restocked', label: 'Restocked' }] },
            { key: 'remark', label: 'Latest remark', type: 'enum', get: (r) => (r.lastRemark ? r.lastRemark.remark : ''),
                options: () => Object.entries(PRESETS).map(([value, label]) => ({ value, label })) },
            { key: 'brand', label: 'Brand', type: 'text', get: (r) => r.brand },
            { key: 'department', label: 'Department', type: 'enum', get: (r) => r.departments, options: () => uniq((r) => r.departments) },
            { key: 'doctor', label: 'Doctor', type: 'enum', get: (r) => r.doctors, options: () => uniq((r) => r.doctors) },
            { key: 'generic', label: 'Generic', type: 'text', get: (r) => r.generic },
            { key: 'description', label: 'Brand/Form/Strength', type: 'text', get: (r) => r.description },
            { key: 'rx', label: '# RX', type: 'number', get: (r) => r.prescriptions },
            { key: 'qty', label: '# Prescribed', type: 'number', get: (r) => r.volume },
            { key: 'last', label: 'Last prescribed', type: 'date', get: (r) => r.lastDate },
        ],
    });

    // ---------- period ----------
    // Which prescriptions are counted — unlike the "Last prescribed" filter,
    // which only picks rows. Remembered per browser; All time by default.
    DateRange.enhance($('pFrom'), $('pTo'), { storageKey: 'rx_review_period', onChange: () => load() });
    ['pFrom', 'pTo'].forEach((id) => { $(id).addEventListener('change', () => load()); });
    const periodQs = () => {
        const p = new URLSearchParams();
        if ($('pFrom').value) p.set('from', $('pFrom').value);
        if ($('pTo').value) p.set('to', $('pTo').value);
        const s = p.toString();
        return s ? '&' + s : '';
    };

    // ---------- data ----------
    // everything once for the period; department and the rest are filters over these rows
    async function load() {
        const per = periodQs();
        const [a, b] = await Promise.all([
            api('/api/pharmacy/review?reason=both' + per),
            api('/api/pharmacy/review?reason=normal' + per),
        ]);
        if (!a.ok || !b.ok) { window.location.href = '/login'; return; }
        problems = a.data.review;
        anomalies = b.data.review;
        selected.clear();
        render();
    }

    const baseRows = (t) => (t === 'anomaly' ? anomalies
        : t === 'resolved' ? problems.filter((r) => r.resolved)
        : t === 'reviewed' ? problems.filter(isReviewed)
        : problems.filter((r) => !r.resolved && !isReviewed(r)));

    function rowsForTab() {
        let rows = baseRows(tab);
        const total = rows.length;
        rows = fbar.apply(rows);
        if (q) rows = rows.filter((r) => `${r.generic} ${r.description} ${r.label}`.toLowerCase().includes(q));
        fbar.setCount(rows.length, total);
        return rows;
    }

    // ---------- render ----------
    function renderTabs() {
        $('tabs').innerHTML = TABS.map(([v, l]) => {
            const n = baseRows(v).length;
            return `<button class="tab ${v === tab ? 'active' : ''}" data-v="${v}">${l}<span class="tab-n ${v === 'anomaly' && n ? 'warn' : ''}">${n}</span></button>`;
        }).join('');
        $('tabs').querySelectorAll('.tab').forEach((t) => {
            t.onclick = () => { tab = t.dataset.v; selected.clear(); render(); };
        });
    }

    // columns per tab. "# Prescribed" is a count of units, never millilitres:
    // a liquid medicine has a real volume in mL and the two must not share a word
    const COLS = {
        sel: { th: '<th class="sel"><input type="checkbox" id="selAll"></th>', td: (r) => `<td class="sel"><input type="checkbox" data-k="${escapeHtml(r.reason + '::' + r.key)}" ${selected.has(r.reason + '::' + r.key) ? 'checked' : ''}></td>` },
        nosel: { th: '<th class="sel"></th>', td: () => '<td class="sel"></td>' },
        generic: { th: '<th>Generic</th>', td: (r) => `<td><b>${escapeHtml(r.generic)}</b></td>` },
        description: { th: '<th>Brand/Form/Strength</th>', td: (r) => `<td>${escapeHtml(r.description || '—')}</td>` },
        reason: { th: '<th>Reason</th>', td: (r) => `<td>${reasonBadge(r.reason)}</td>` },
        rx: { th: '<th># RX</th>', td: (r) => `<td>${r.prescriptions}</td>` },
        qty: { th: '<th># Prescribed</th>', td: (r) => `<td>${r.volume}</td>` },
        departments: { th: '<th>Departments</th>', td: (r) => `<td class="muted">${escapeHtml(r.departments.join(', '))}</td>` },
        doctors: { th: '<th>Doctors</th>', td: (r) => `<td class="muted">${escapeHtml(r.byDoctor.map((x) => drName(x.name)).join('; '))}</td>` },
        last: { th: '<th>Last prescribed</th>', td: (r) => `<td>${fmtDT(r.lastDate)}</td>` },
        status: { th: '<th>Status</th>', td: (r) => `<td>${statusBadge(r)}</td>` },
        remarks: { th: '<th>Remarks</th>', td: (r, i) => `<td>${remarkCell(r, i)}</td>` },
    };
    const LAYOUT = {
        review: ['sel', 'generic', 'description', 'reason', 'rx', 'qty', 'departments', 'status', 'remarks'],
        reviewed: ['sel', 'generic', 'description', 'reason', 'rx', 'qty', 'remarks', 'departments', 'status'],
        anomaly: ['nosel', 'generic', 'description', 'rx', 'qty', 'departments', 'doctors', 'last', 'remarks'],
        resolved: ['sel', 'generic', 'description', 'reason', 'rx', 'qty', 'departments', 'status', 'remarks'],
    };

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

        const cols = LAYOUT[tab].map((c) => COLS[c]);
        $('thead').innerHTML = cols.map((c) => c.th).join('');
        $('tbl').innerHTML = rows.map((r, i) => `<tr class="clickable" data-i="${i}">${cols.map((c) => c.td(r, i)).join('')}</tr>`).join('');

        // row click -> detail drawer (ignore clicks on the checkbox and the remark button)
        $('tbl').querySelectorAll('tr').forEach((tr) => {
            tr.onclick = (e) => { if (e.target.type === 'checkbox' || e.target.closest('button')) return; openDetail(rows[Number(tr.dataset.i)], tr); };
        });
        $('tbl').querySelectorAll('button.rmk-set').forEach((b) => { b.onclick = () => openRemark(rows[Number(b.dataset.rmk)]); });
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
            : row.reason === 'out_of_stock' ? 'Out of stock' : 'Prescribed but In Bizbox';
        $('dGrid').innerHTML =
            kv('Generic', row.generic) + kv('Brand', row.brand) +
            kv('Form', row.form) + kv('Strength', row.strength) +
            // real millilitres, unlike the "# Prescribed" stat above. Lists every
            // volume seen, since one drug row can cover several.
            kv('Volume (mL)', (row.volumesMl || []).length ? row.volumesMl.join(', ') + ' mL' : null) +
            kv('Registration No.', row.registrationNumber) + kv('Reason', reasonLabel) +
            kv('Status', row.status.replace(/_/g, ' ')) + kv('Last prescribed', fmtDT(row.lastDate));

        $('dAuthWrap').style.display = isStaff && row.reason !== 'normal' ? 'block' : 'none';
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

    // the remark history, read-only: the panel explains, the table acts
    function renderRemarks(row) {
        const list = row.remarks || [];
        $('dRemarks').innerHTML = list.length ? list.map((r) => `
            <div class="remark">
                <div class="top">${remarkBadge(r.remark)}<span class="who">${escapeHtml(r.actor || '')}${r.authorizedBy && r.authorizedBy !== r.actor ? ` · auth. ${escapeHtml(r.authorizedBy)}` : ''} · ${fmtDT(r.at)}</span></div>
                ${r.note ? `<div class="note">${escapeHtml(r.note)}</div>` : ''}
            </div>`).join('')
            : '<div class="muted" style="font-size:12.5px">No remarks yet. Use "Set remark" on the row.</div>';
    }

    // ---------- Set remark: the stepper ----------
    // Step 1 picks the remark and a note. "Available in Bizbox" on a not-in-
    // Bizbox row adds step 2, a look at the medicine that will go into
    // Bizbox, because that remark resolves the row. Step 3 confirms, with the
    // admin password for staff.
    const rvDlg = $('resolveDlg');
    $('rvWidget').innerHTML = MedWidget.html('r-', 'rsg-', { vol: true });
    const rvWidget = MedWidget.create({ p: 'r-', sg: 'rsg-', statusId: 'rvStatus', noteId: 'rvNote', splitNoteId: 'r-splitNote', clearsBelow: false, confirmBizbox: false });
    let rv = null;      // { row, steps: [1,2,3] | [1,3], at: index }

    const STEP_NAMES = { 1: 'Remark', 2: 'Review the medicine', 3: 'Confirm' };
    const RESOLVES = (row, preset) => preset === 'available_in_bizbox' && !row.resolved && row.reason !== 'normal';
    function renderSteps() {
        $('rvSteps').innerHTML = rv.steps.map((n, i) => `<div class="step ${i === rv.at ? 'active' : i < rv.at ? 'done' : ''}"><span class="n">${i + 1}</span>${STEP_NAMES[n]}</div>`).join('');
        rvDlg.querySelectorAll('.step-pane').forEach((p) => p.classList.toggle('active', Number(p.dataset.step) === rv.steps[rv.at]));
        $('rvBack').style.visibility = rv.at > 0 ? 'visible' : 'hidden';
        $('rvNext').textContent = rv.at === rv.steps.length - 1 ? 'Confirm' : 'Next';
        $('rvErr').classList.remove('show');
    }
    const rvError = (msg) => { $('rvErr').textContent = msg; $('rvErr').classList.add('show'); };

    function openRemark(row) {
        rv = { row, steps: [1, 3], at: 0 };
        $('rvTitle').textContent = 'Set remark';
        $('rvDrug').textContent = `${row.generic} — ${row.description}`;
        const sel = $('rvPreset');
        sel.innerHTML = Object.entries(PRESETS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
        // a resolved row still takes remarks (why it was closed), but the
        // preset that resolves cannot resolve twice
        const opt = sel.querySelector('option[value="available_in_bizbox"]');
        if (opt) opt.disabled = !!row.resolved;
        sel.value = row.resolved ? 'other' : (row.reason === 'not_in_formulary' ? 'for_order' : 'other');
        $('rvNoteText').value = '';
        $('rvHint').textContent = '';
        $('rvAuthWrap').style.display = isStaff ? 'block' : 'none';
        $('rvAuth').value = '';
        onPresetChange();
        renderSteps();
        rvDlg.showModal();
        sel.focus();
    }
    function onPresetChange() {
        const { row } = rv;
        const preset = $('rvPreset').value;
        $('rvHint').textContent = preset === 'available_in_bizbox'
            ? (row.reason === 'not_in_formulary' ? 'This resolves the row: the medicine will be added to Bizbox in this system and marked Added to Bizbox. You will check it first.'
                : row.reason === 'out_of_stock' ? 'This resolves the row as Restocked.' : 'Recorded on this anomaly for the audit; nothing else changes.')
            : 'Recorded on the row. The status does not change.';
        rv.steps = RESOLVES(row, preset) && row.reason === 'not_in_formulary' ? [1, 2, 3] : [1, 3];
    }
    $('rvPreset').onchange = onPresetChange;

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
                <span class="badge ${p.inFormulary ? 'green' : 'amber'}">${p.inFormulary ? 'In Bizbox' : 'Not marked'}</span>
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
        const { row } = rv;
        const preset = $('rvPreset').value;
        const note = $('rvNoteText').value.trim();
        const rows = [['Medicine', `${row.generic} — ${row.description}`], ['Remark', PRESETS[preset] || preset]];
        if (note) rows.push(['Note', note]);
        if (RESOLVES(row, preset)) {
            if (row.reason === 'not_in_formulary') {
                const s = rvWidget.values();
                rows.push(['Goes into Bizbox as', `${s.generic} — ${s.description}`], ['Will be marked', 'Added to Bizbox']);
            } else rows.push(['Will be marked', 'Restocked']);
        } else rows.push(['Status', 'unchanged']);
        $('rvSummary').innerHTML = rows.map(([k, v]) => `<div class="k">${k}</div><div>${escapeHtml(v)}</div>`).join('');
    }

    $('rvCancel').onclick = () => rvDlg.close();
    $('rvBack').onclick = () => { if (rv.at > 0) { rv.at -= 1; renderSteps(); } };
    $('rvNext').onclick = async () => {
        const { row } = rv;
        const step = rv.steps[rv.at];
        if (step === 1 && rv.steps.includes(2) && rv.at === 0) {
            // entering the review step: load the row's medicine and what is near it
            rvWidget.load({ genericName: row.generic, brandName: row.brand, formName: row.form, strength: row.strength, description: row.description, fromCatalog: false, volumeMl: (row.volumesMl || [])[0] || null });
            loadSimilar($('rvSimilar'), rvWidget, row.generic, row.brand);
        }
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
        const preset = $('rvPreset').value;
        const body = { key: row.key, reason: row.reason, remark: preset, note: $('rvNoteText').value.trim(), drug: { label: row.label } };
        if (RESOLVES(row, preset) && row.reason === 'not_in_formulary') {
            const s = rvWidget.values();
            body.resolve = { generic: s.generic, brand: s.brand, form: s.form, strength: s.strength, description: s.description, volumeMl: s.volumeMl };
        }
        if (isStaff) body.authorizerPassword = $('rvAuth').value;
        const btn = $('rvNext'); btn.disabled = true;
        const res = await api('/api/pharmacy/remarks', { body });
        btn.disabled = false;
        if (!res.ok) { rvError(res.data.message || 'Could not save'); return; }
        rvDlg.close();
        if (res.data.resolvedStatus) {
            await showDialog({
                kind: 'ok', title: 'Recorded',
                message: res.data.resolvedStatus === 'added_to_formulary' ? `${row.generic}, ${row.description} is now in Bizbox and the row is resolved.`
                    : `${row.generic}, ${row.description} is marked Restocked.`,
            });
        }
        await load();
        // a reviewed row moves tabs; follow it so the reviewer sees the result
        const fresh = allRows().find((r) => r.reason === row.reason && r.key === row.key);
        if (fresh && tab !== 'anomaly') { tab = fresh.resolved ? 'resolved' : isReviewed(fresh) ? 'reviewed' : 'review'; render(); }
        if (fresh && detail.classList.contains('open')) openDetail(fresh, null);
    };
    rvDlg.addEventListener('close', () => rvWidget.hideBoxes());

    // Add Medicine and the Bizbox import live on the Medicines page (admin)
    if (isAdmin) $('medLink').innerHTML = '<a class="btn-link sm" href="/medicines">Medicines · RX Formulary &amp; Import</a>';

    // ---------- search ----------
    let t = null;
    $('search').addEventListener('input', () => {
        clearTimeout(t); t = setTimeout(() => { q = $('search').value.trim().toLowerCase(); render(); }, 200);
    });

    await load();
})();
