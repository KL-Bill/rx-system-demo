(async function () {
    const $ = (id) => document.getElementById(id);
    const me = await api('/api/auth/me');
    if (!me.ok) { window.location.href = '/login'; return; }
    const user = me.data.user;
    const isStaff = user.role === 'staff';

    mountRail({ mode: 'pharmacy', active: 'review' });
    $('railUser').textContent = `${user.name} · ${user.role}`;
    initDrawer('filtersBtn');

    // tab -> which rows we show
    const TABS = [
        ['review', 'Needs Review'],
        ['anomaly', 'In-stock Anomalies'],
        ['resolved', 'Resolved'],
    ];
    let tab = 'review', reason = 'both', department = 'all', statusF = 'all', q = '';
    let problems = [], anomalies = [], current = null;
    const selected = new Map();   // key -> row

    const fmtDT = (t) => (t ? new Date(t).toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit', hour: 'numeric', minute: '2-digit' }) : '');
    const reasonBadge = (r) => r === 'not_in_formulary' ? '<span class="badge navy">Not in Formulary</span>'
        : r === 'out_of_stock' ? '<span class="badge amber">Out of stock</span>'
        : '<span class="badge red">In stock — anomaly</span>';
    const statusBadge = (r) => {
        if (r.status === 'added_to_formulary') return `<span class="badge green">Added to Formulary</span> <span class="muted">${fmtDT(r.statusDate)}</span>`;
        if (r.status === 'restocked') return `<span class="badge green">Restocked</span> <span class="muted">${fmtDT(r.statusDate)}</span>`;
        if (r.status === 'under_therapeutics') return '<span class="badge amber">Under Therapeutics</span>';
        return '<span class="badge gray">Pending</span>';
    };

    // departments
    const st = await api('/api/rx/stations');
    [...new Set((st.data.stations || []).map((s) => s.department))].forEach((d) => {
        const o = document.createElement('option'); o.value = d; o.textContent = d; $('department').appendChild(o);
    });

    // ---------- data ----------
    async function load() {
        const dep = department !== 'all' ? '&department=' + encodeURIComponent(department) : '';
        const [a, b] = await Promise.all([
            api('/api/pharmacy/review?reason=both' + dep),
            api('/api/pharmacy/review?reason=normal' + dep),
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
        if (tab !== 'anomaly' && reason !== 'both') rows = rows.filter((r) => r.reason === reason);
        if (statusF !== 'all') rows = rows.filter((r) => r.status === statusF);
        if (q) rows = rows.filter((r) => r.label.toLowerCase().includes(q));
        return rows;
    }

    // ---------- render ----------
    function renderTabs() {
        $('tabs').innerHTML = TABS.map(([v, l]) =>
            `<button class="tab ${v === tab ? 'active' : ''}" data-v="${v}">${l}</button>`).join('');
        $('tabs').querySelectorAll('.tab').forEach((t) => {
            t.onclick = () => { tab = t.dataset.v; selected.clear(); render(); };
        });
        // reason chips only make sense on the review/resolved tabs
        $('filters').style.display = tab === 'anomaly' ? 'none' : 'flex';
        $('filters').innerHTML = [['both', 'All'], ['not_in_formulary', 'Not in Formulary'], ['out_of_stock', 'Out of stock']]
            .map(([v, l]) => `<div class="chip ${v === reason ? 'active' : ''}" data-v="${v}">${l}</div>`).join('');
        $('filters').querySelectorAll('.chip').forEach((c) => {
            c.onclick = () => { reason = c.dataset.v; selected.clear(); render(); };
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
        $('thead').innerHTML = anom
            ? `<th class="sel"></th><th>Medicine</th><th>Prescriptions</th><th>Volume</th><th>Departments</th><th>Doctors</th><th>Last prescribed</th>`
            : `<th class="sel"><input type="checkbox" id="selAll"></th><th>Medicine</th><th>Reason</th><th>Prescriptions</th><th>Volume</th><th>Departments</th><th>Status</th>`;

        $('tbl').innerHTML = rows.map((r, i) => anom ? `
            <tr class="clickable" data-i="${i}">
                <td class="sel"></td>
                <td><b>${escapeHtml(r.label)}</b></td>
                <td>${r.prescriptions}</td>
                <td>${r.volume}</td>
                <td class="muted">${escapeHtml(r.departments.join(', '))}</td>
                <td class="muted">${escapeHtml(r.byDoctor.map((x) => drName(x.name)).join('; '))}</td>
                <td>${fmtDT(r.lastDate)}</td>
            </tr>` : `
            <tr class="clickable" data-i="${i}">
                <td class="sel"><input type="checkbox" data-k="${escapeHtml(r.reason + '::' + r.key)}" ${selected.has(r.reason + '::' + r.key) ? 'checked' : ''}></td>
                <td><b>${escapeHtml(r.label)}</b></td>
                <td>${reasonBadge(r.reason)}</td>
                <td>${r.prescriptions}</td>
                <td>${r.volume}</td>
                <td class="muted">${escapeHtml(r.departments.join(', '))}</td>
                <td>${statusBadge(r)}</td>
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
        if (allNIF) acts = '<button data-a="under_therapeutics">Send to Therapeutics</button><button data-a="added_to_formulary">Mark Added to Formulary</button>';
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
        else { $('bErr').textContent = res.data.message || 'Could not update'; $('bErr').classList.add('show'); if (!isStaff) alert(res.data.message); }
    }
    $('bCancel').onclick = () => $('bulkModal').classList.remove('show');
    $('bConfirm').onclick = () => sendBulk(pendingAction, $('bAuth').value);

    // ---------- detail drawer ----------
    const detail = $('detail');
    const contentEl = document.querySelector('.content');

    function showDetail(on) {
        detail.classList.toggle('open', on);   // overlays the table; no reflow
        if (on) $('drawer').classList.remove('open');   // one right panel at a time
        else document.querySelectorAll('#tbl tr.selected').forEach((tr) => tr.classList.remove('selected'));
    }

    function actionButtons(r) {
        if (r.reason === 'normal') return '';
        if (r.reason === 'not_in_formulary') {
            if (r.status === 'added_to_formulary') return '';
            let h = '';
            if (r.status === 'pending') h += '<button class="ghost sm" data-action="under_therapeutics">Send to Therapeutics</button>';
            return h + '<button class="green sm" data-action="added_to_formulary">Mark Added to Formulary</button>';
        }
        return r.status === 'restocked' ? '' : '<button class="green sm" data-action="restocked">Mark Restocked</button>';
    }

    const kv = (k, v) => `<div><div class="k">${k}</div><div class="v">${escapeHtml(v || '—')}</div></div>`;

    function openDetail(row, tr) {
        current = { row };
        document.querySelectorAll('#tbl tr.selected').forEach((x) => x.classList.remove('selected'));
        if (tr) tr.classList.add('selected');

        $('dTitle').textContent = row.label;
        $('dSubtitle').textContent = [row.generic, row.registrationNumber ? 'Reg. No. ' + row.registrationNumber : '']
            .filter(Boolean).join(' · ');
        $('dBadges').innerHTML = reasonBadge(row.reason) + ' ' + statusBadge(row);

        $('d-rx').textContent = row.prescriptions;
        $('d-vol').textContent = row.volume;
        $('d-dept').textContent = row.departments.length;

        $('dRows').innerHTML = [...row.byDoctor].sort((a, b) => b.lastDate - a.lastDate)
            .map((x) => `<tr><td>${escapeHtml(drName(x.name))}</td><td>${x.prescriptions}</td><td>${x.volume}</td><td>${fmtDT(x.lastDate)}</td></tr>`).join('');
        $('dDept').innerHTML = [...row.byDepartment].sort((a, b) => b.lastDate - a.lastDate)
            .map((x) => `<tr><td>${escapeHtml(x.name)}</td><td>${x.prescriptions}</td><td>${x.volume}</td></tr>`).join('');

        const reasonLabel = row.reason === 'not_in_formulary' ? 'Not in Formulary'
            : row.reason === 'out_of_stock' ? 'Out of stock' : 'In stock (anomaly)';
        $('dGrid').innerHTML =
            kv('Generic', row.generic) + kv('Brand', row.brand) +
            kv('Form', row.form) + kv('Strength', row.strength) +
            kv('Registration No.', row.registrationNumber) + kv('Reason', reasonLabel) +
            kv('Status', row.status.replace(/_/g, ' ')) + kv('Last prescribed', fmtDT(row.lastDate));

        $('dAuthWrap').style.display = isStaff && row.reason !== 'normal' ? 'block' : 'none';
        $('dAuth').value = '';
        $('dErr').classList.remove('show');
        $('dActions').innerHTML = actionButtons(row);
        $('dActions').querySelectorAll('button').forEach((b) => { b.onclick = () => doStatus(b.dataset.action); });

        showDetail(true);
    }

    async function doStatus(action) {
        const { row } = current;
        const body = {
            key: row.key, reason: row.reason, action,
            drug: { label: row.label, generic: row.generic, brand: row.brand, form: row.form, strength: row.strength },
        };
        if (isStaff) body.authorizerPassword = $('dAuth').value;
        const res = await api('/api/pharmacy/status', { body });
        if (res.ok) { showDetail(false); load(); }
        else { $('dErr').textContent = res.data.message || 'Could not update'; $('dErr').classList.add('show'); }
    }
    $('dClose').onclick = () => showDetail(false);
    $('filtersBtn').addEventListener('click', () => showDetail(false));   // only one right panel at a time

    // ---------- filters ----------
    $('department').onchange = () => { department = $('department').value; load(); };
    $('statusFilter').onchange = () => { statusF = $('statusFilter').value; render(); };
    let t = null;
    $('search').addEventListener('input', () => {
        clearTimeout(t); t = setTimeout(() => { q = $('search').value.trim().toLowerCase(); render(); }, 200);
    });
    $('clearFilters').onclick = () => {
        department = 'all'; statusF = 'all'; reason = 'both'; q = '';
        $('department').value = 'all'; $('statusFilter').value = 'all'; $('search').value = '';
        load();
    };

    await load();
})();
