(async function () {
    const $ = (id) => document.getElementById(id);
    const me = await api('/api/auth/me');
    if (!me.ok) { window.location.href = '/login'; return; }
    const user = me.data.user;
    const isStaff = user.role === 'staff';
    $('whoami').textContent = `${user.name} · ${user.role}`;
    $('logout').onclick = async () => { await api('/api/auth/logout', { body: {} }); window.location.href = '/'; };

    let reason = 'both', department = 'all', allReview = [], current = null;
    const FILTERS = [['both', 'All'], ['not_in_formulary', 'Not in Formulary'], ['out_of_stock', 'Out of stock']];

    // department options
    const st = await api('/api/rx/stations');
    [...new Set((st.data.stations || []).map((s) => s.department))].forEach((d) => {
        const o = document.createElement('option'); o.value = d; o.textContent = d; $('department').appendChild(o);
    });
    $('department').onchange = () => { department = $('department').value; load(); };
    const fmtD = (t) => (t ? new Date(t).toLocaleDateString() : '');

    const reasonBadge = (r) => r === 'not_in_formulary'
        ? '<span class="badge navy">Not in Formulary</span>'
        : '<span class="badge amber">Out of stock</span>';

    const statusBadge = (row) => {
        if (row.status === 'added_to_formulary') return `<span class="badge green">Added to Formulary</span> <span class="muted">${fmtD(row.statusDate)}</span>`;
        if (row.status === 'restocked') return `<span class="badge green">Restocked</span> <span class="muted">${fmtD(row.statusDate)}</span>`;
        if (row.status === 'under_therapeutics') return '<span class="badge amber">Under Therapeutics</span>';
        return '<span class="badge gray">Pending</span>';
    };

    function renderFilters() {
        $('filters').innerHTML = FILTERS.map(([v, l]) => `<div class="chip ${v === reason ? 'active' : ''}" data-v="${v}">${l}</div>`).join('');
        $('filters').querySelectorAll('.chip').forEach((c) => { c.onclick = () => { reason = c.dataset.v; render(); }; });
    }

    async function load() {
        const q = department !== 'all' ? '?department=' + encodeURIComponent(department) : '';
        const res = await api('/api/pharmacy/review' + q);
        if (!res.ok) { window.location.href = '/login'; return; }
        allReview = res.data.review;
        render();
    }

    function render() {
        renderFilters();
        const active = allReview.filter((r) => !r.resolved);
        $('kp-total').textContent = active.length;
        $('kp-nif').textContent = active.filter((r) => r.reason === 'not_in_formulary').length;
        $('kp-oos').textContent = active.filter((r) => r.reason === 'out_of_stock').length;
        $('kp-resolved').textContent = allReview.filter((r) => r.resolved).length;

        const rows = reason === 'both' ? allReview : allReview.filter((r) => r.reason === reason);
        $('empty').style.display = rows.length ? 'none' : 'block';
        $('tbl').innerHTML = rows.map((r, i) => `
            <tr class="clickable" data-i="${i}">
                <td><b>${escapeHtml(r.label)}</b></td>
                <td>${reasonBadge(r.reason)}</td>
                <td>${r.prescriptions}</td>
                <td>${r.volume}</td>
                <td class="muted">${escapeHtml(r.departments.join(', '))}</td>
                <td>${statusBadge(r)}</td>
            </tr>`).join('');
        $('tbl').querySelectorAll('tr').forEach((tr) => { tr.onclick = () => openDetail(rows[Number(tr.dataset.i)]); });
    }

    function actionButtons(reasonV, status) {
        if (reasonV === 'not_in_formulary') {
            if (status === 'added_to_formulary') return '';
            let html = '';
            if (status === 'pending') html += '<button class="ghost" data-action="under_therapeutics">Send to Therapeutics</button> ';
            html += '<button class="green" data-action="added_to_formulary">Mark Added to Formulary</button>';
            return html;
        }
        return status === 'restocked' ? '' : '<button class="green" data-action="restocked">Mark Restocked</button>';
    }

    async function openDetail(row) {
        const res = await api(`/api/pharmacy/detail?reason=${encodeURIComponent(row.reason)}&key=${encodeURIComponent(row.key)}`);
        if (!res.ok) return;
        const d = res.data.detail;
        current = { row, d };
        $('dTitle').textContent = d.label;
        $('dSub').innerHTML = reasonBadge(row.reason) + ' ' + statusBadge(d);
        $('d-rx').textContent = d.prescriptions;
        $('d-vol').textContent = d.volume;
        $('d-dept').textContent = d.departments.length;
        $('dRows').innerHTML = d.rows.map((r) => `<tr><td>${fmtD(r.date)}</td><td>${escapeHtml(r.department)}</td><td>${escapeHtml(drName(r.doctor) || '—')}</td><td>${r.quantity}</td></tr>`).join('');
        $('dAuthWrap').style.display = isStaff ? 'block' : 'none';
        $('dAuth').value = '';
        $('dErr').classList.remove('show');
        $('dActions').innerHTML = actionButtons(row.reason, d.status);
        $('dActions').querySelectorAll('button').forEach((b) => { b.onclick = () => doStatus(b.dataset.action); });
        $('detailModal').classList.add('show');
    }

    async function doStatus(action) {
        const { row, d } = current;
        const body = {
            key: row.key, reason: row.reason, action,
            drug: { label: d.label, generic: d.generic, brand: d.brand, form: d.form, strength: d.strength },
        };
        if (isStaff) body.authorizerPassword = $('dAuth').value;
        const res = await api('/api/pharmacy/status', { body });
        if (res.ok) { $('detailModal').classList.remove('show'); load(); }
        else { $('dErr').textContent = res.data.message || 'Could not update'; $('dErr').classList.add('show'); }
    }

    $('dClose').onclick = () => $('detailModal').classList.remove('show');
    await load();
})();
