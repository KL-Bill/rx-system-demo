(async function () {
    const $ = (id) => document.getElementById(id);
    const me = await api('/api/auth/me');
    if (!me.ok) { window.location.href = '/login'; return; }
    $('whoami').textContent = `${me.data.user.name} · ${me.data.user.role}`;
    $('logout').onclick = async () => { await api('/api/auth/logout', { body: {} }); window.location.href = '/'; };

    let rows = [];
    const fmtD = (t) => (t ? new Date(t).toLocaleDateString() : '');
    const reasonText = (r) => (r === 'not_in_formulary' ? 'Not in Formulary' : 'Out of stock');
    const statusText = (r) => {
        if (r.status === 'added_to_formulary') return `Added to Formulary (${fmtD(r.statusDate)})`;
        if (r.status === 'restocked') return `Restocked (${fmtD(r.statusDate)})`;
        if (r.status === 'under_therapeutics') return 'Under Therapeutics';
        return 'Pending';
    };

    const st = await api('/api/rx/stations');
    [...new Set((st.data.stations || []).map((s) => s.department))].forEach((dep) => {
        const o = document.createElement('option'); o.value = dep; o.textContent = dep; $('department').appendChild(o);
    });

    async function generate() {
        const p = new URLSearchParams();
        p.set('reason', $('reason').value);
        p.set('department', $('department').value);
        if ($('from').value) p.set('from', $('from').value);
        if ($('to').value) p.set('to', $('to').value);
        const res = await api('/api/report?' + p.toString());
        if (!res.ok) { window.location.href = '/login'; return; }
        render(res.data.data);
    }

    const miniTable = (kind, list) => `
        <table class="detail-table">
            <thead><tr><th>${kind}</th><th>Rx</th><th>Vol</th></tr></thead>
            <tbody>${list.map((x) => `<tr><td>${escapeHtml(x.name)}</td><td>${x.prescriptions}</td><td>${x.volume}</td></tr>`).join('')}</tbody>
        </table>`;

    function render(d) {
        rows = d.rows;
        const reasonLabel = d.reason === 'both' ? 'Not in Formulary + Out of stock' : reasonText(d.reason);
        const deptLabel = d.department === 'all' ? 'All departments' : d.department;
        const period = ($('from').value || $('to').value) ? `${$('from').value || '…'} to ${$('to').value || '…'}` : 'All time';
        $('reportMeta').innerHTML = `Showing: <b>${escapeHtml(reasonLabel)}</b> &nbsp;|&nbsp; Dept: <b>${escapeHtml(deptLabel)}</b> &nbsp;|&nbsp; Period: <b>${escapeHtml(period)}</b> &nbsp;|&nbsp; ${new Date(d.generatedAt).toLocaleString()}`;

        $('reportKpis').innerHTML = [
            ['Distinct drugs', rows.length],
            ['Not in Formulary', rows.filter((r) => r.reason === 'not_in_formulary').length],
            ['Out of stock', rows.filter((r) => r.reason === 'out_of_stock').length],
            ['Total prescriptions', rows.reduce((s, r) => s + r.prescriptions, 0)],
            ['Total volume', rows.reduce((s, r) => s + r.volume, 0)],
        ].map(([l, n]) => `<div class="kpi"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');

        const table = $('reportTable');
        table.querySelectorAll('tbody.drug-group').forEach((t) => t.remove());
        $('reportEmpty').style.display = rows.length ? 'none' : 'block';

        rows.forEach((r) => {
            const tb = document.createElement('tbody');
            tb.className = 'drug-group';
            tb.innerHTML = `
                <tr class="clickable drug-row">
                    <td><span class="caret">▸</span> ${escapeHtml(r.label)}</td>
                    <td>${reasonText(r.reason)}</td>
                    <td>${r.prescriptions}</td>
                    <td>${r.volume}</td>
                    <td class="muted">${escapeHtml(r.departments.join(', '))}</td>
                    <td>${statusText(r)}</td>
                </tr>
                <tr class="detail-row" style="display:none">
                    <td colspan="6"><div class="detail-grid">${miniTable('Department', r.byDepartment)}${miniTable('Doctor', r.byDoctor.map((x) => ({ ...x, name: drName(x.name) })))}</div></td>
                </tr>`;
            const drugRow = tb.querySelector('.drug-row');
            const detailRow = tb.querySelector('.detail-row');
            drugRow.onclick = () => {
                const open = detailRow.style.display !== 'none';
                detailRow.style.display = open ? 'none' : 'table-row';
                drugRow.querySelector('.caret').textContent = open ? '▸' : '▾';
            };
            table.appendChild(tb);
        });
    }

    function csvCell(v) { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
    function exportCsv() {
        if (!rows.length) { alert('Generate a report first.'); return; }
        const head = ['Medicine', 'Reason', 'Prescriptions', 'Volume', 'Departments (volume)', 'Doctors (volume)', 'Status'];
        const lines = [head.join(',')];
        rows.forEach((r) => lines.push([
            csvCell(r.label), reasonText(r.reason), r.prescriptions, r.volume,
            csvCell(r.byDepartment.map((x) => `${x.name}:${x.volume}`).join('; ')),
            csvCell(r.byDoctor.map((x) => `${drName(x.name)}:${x.volume}`).join('; ')),
            csvCell(statusText(r)),
        ].join(',')));
        const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `tmc-rx-report-${fmtD(Date.now()).replace(/\//g, '-')}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    $('genBtn').onclick = generate;
    $('csvBtn').onclick = exportCsv;
    $('printBtn').onclick = () => {
        document.querySelectorAll('#reportTable .detail-row').forEach((d) => (d.style.display = 'table-row'));
        document.querySelectorAll('#reportTable .caret').forEach((c) => (c.textContent = '▾'));
        window.print();
    };
    await generate();
})();
