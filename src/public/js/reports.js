(async function () {
    const $ = (id) => document.getElementById(id);

    // auth gate
    const me = await api('/api/auth/me');
    if (!me.ok) { window.location.href = '/login'; return; }
    $('whoami').textContent = `${me.data.user.name} · ${me.data.user.role}`;
    $('logout').onclick = async () => { await api('/api/auth/logout', { body: {} }); window.location.href = '/'; };

    let rows = [];

    // stations (the rx endpoint is fine and already returns them)
    const st = await api('/api/rx/stations');
    (st.data.stations || []).forEach((s) => {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = `${s.name} (${s.department})`;
        $('station').appendChild(o);
    });

    const fmtDate = (ms) => new Date(ms).toLocaleString();
    const fmtDay = (ms) => new Date(ms).toLocaleDateString();

    async function generate() {
        const params = new URLSearchParams();
        if ($('station').value) params.set('station', $('station').value);
        if ($('from').value) params.set('from', $('from').value);
        if ($('to').value) params.set('to', $('to').value);

        const res = await api('/api/report?' + params.toString());
        if (!res.ok) { window.location.href = '/login'; return; }
        render(res.data.data);
    }

    function render(d) {
        rows = d.rows;
        const scope = d.scope ? d.scope.name : 'Overall (all stations)';
        const period = d.period.from || d.period.to
            ? `${$('from').value || '…'} to ${$('to').value || '…'}`
            : 'All time';
        $('reportMeta').innerHTML =
            `Scope: <b>${escapeHtml(scope)}</b> &nbsp;|&nbsp; Period: <b>${escapeHtml(period)}</b> &nbsp;|&nbsp; Generated: ${fmtDate(d.generatedAt)}`;

        const s = d.summary;
        $('reportKpis').innerHTML = [
            ['Prescriptions', s.prescriptions],
            ['Items prescribed', s.items],
            ['Total quantity', s.totalQty],
            ['Distinct medicines', s.distinctMeds],
            ['Not in database', s.notInDbCount],
            ['Low stock', s.lowStockCount],
        ].map(([l, n]) => `<div class="kpi"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');

        $('reportEmpty').style.display = rows.length ? 'none' : 'block';
        $('reportBody').innerHTML = rows.map((r) => `
            <tr>
                <td>${escapeHtml(r.name)} <span class="muted">${escapeHtml(r.strength)} ${escapeHtml(r.form)}</span></td>
                <td>${r.inDatabase ? 'Yes' : '<b>No</b>'}</td>
                <td>${r.stock == null ? '—' : r.stock}</td>
                <td>${r.demand}</td>
                <td>${r.qty}</td>
                <td>${r.unmet}</td>
                <td>${r.fulfillment}%</td>
                <td><b>${r.score}</b></td>
            </tr>`).join('');
    }

    // CSV export (opens in Excel)
    function csvCell(v) {
        v = String(v ?? '');
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }
    function exportCsv() {
        if (!rows.length) { alert('Generate a report first.'); return; }
        const head = ['Medicine', 'Strength', 'Form', 'In Database', 'Stock', 'Demand', 'Total Qty', 'Unmet', 'Fulfillment %', 'Score'];
        const lines = [head.join(',')];
        rows.forEach((r) => lines.push([
            csvCell(r.name), csvCell(r.strength), csvCell(r.form), r.inDatabase ? 'Yes' : 'No',
            r.stock == null ? '' : r.stock, r.demand, r.qty, r.unmet, r.fulfillment, r.score,
        ].join(',')));

        const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `rx-demand-report-${fmtDay(Date.now()).replace(/\//g, '-')}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    $('genBtn').onclick = generate;
    $('csvBtn').onclick = exportCsv;
    $('printBtn').onclick = () => window.print();

    await generate(); // load an initial "all time / overall" report
})();
