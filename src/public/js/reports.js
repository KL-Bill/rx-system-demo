(async function () {
    const $ = (id) => document.getElementById(id);
    const me = await api('/api/auth/me');
    if (!me.ok) { window.location.href = '/login'; return; }
    if (me.data.user.role === 'it') { window.location.href = '/it'; return; }

    mountRail({ mode: 'pharmacy', active: 'reports' });
    $('railUser').textContent = `${me.data.user.name} · ${me.data.user.role}`;

    let all = [];       // every row the server returned for the period
    let rows = [];      // after the filter bar
    let generatedAt = 0;

    const fmtD = (t) => (t ? new Date(t).toLocaleDateString() : '');
    const fmtDT = (t) => (t ? new Date(t).toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit', hour: 'numeric', minute: '2-digit' }) : '');
    const reasonText = (r) => (r === 'not_in_formulary' ? 'Not in Bizbox'
        : r === 'out_of_stock' ? 'Out of stock'
        : r === 'normal' ? 'Prescribed but In Bizbox' : r);
    const statusText = (r) => {
        if (r.status === 'added_to_formulary') return `Added to Bizbox (${fmtD(r.statusDate)})`;
        if (r.status === 'restocked') return `Restocked (${fmtD(r.statusDate)})`;
        if (r.status === 'under_therapeutics') return 'Under Therapeutics';
        return 'Pending';
    };
    let PRESETS = {
        available_in_bizbox: 'Available in Bizbox', ordered: 'Ordered', for_order: 'For Order',
        other_brand_only: 'Only other brand available', under_therapeutics: 'Under Therapeutics review', other: 'Other',
    };
    api('/api/pharmacy/remarks?key=_&reason=_').then((r) => { if (r.ok && r.data.presets) PRESETS = r.data.presets; }).catch(() => {});
    const remarkText = (k) => PRESETS[k] || k;
    const remarkLine = (r) => `${remarkText(r.remark)}${r.note ? ` — ${r.note}` : ''} (${r.actor || ''}, ${fmtDT(r.at)})`;

    // ---------- filters ----------
    const uniq = (get) => [...new Set(all.flatMap(get))].filter(Boolean).sort((a, b) => a.localeCompare(b)).map((v) => ({ value: v, label: v }));
    const fbar = FilterBar.create({
        mount: $('filterbar'), storageKey: 'rx_report_filters', onChange: render,
        // the questions the pharmacy asks most, one click each
        quick: [
            { label: 'Not in Bizbox', filter: { key: 'reason', op: 'is', value: 'not_in_formulary' } },
            { label: 'Out of stock', filter: { key: 'reason', op: 'is', value: 'out_of_stock' } },
            { label: 'Prescribed but In Bizbox', filter: { key: 'reason', op: 'is', value: 'normal' } },
            { label: 'Branded only', filter: { key: 'brand', op: 'not_empty' } },
            { label: 'No remarks', filter: { key: 'remark', op: 'empty' } },
            { label: 'Still open', filter: { key: 'resolved', op: 'is', value: 'no' } },
        ],
        fields: [
            { key: 'brand', label: 'Brand', type: 'text', get: (r) => r.brand },
            { key: 'reason', label: 'Bizbox status', type: 'enum', get: (r) => r.reason, options: [
                { value: 'not_in_formulary', label: 'Not in Bizbox' }, { value: 'out_of_stock', label: 'Out of stock' }, { value: 'normal', label: 'Prescribed but In Bizbox' }] },
            { key: 'status', label: 'Review status', type: 'enum', get: (r) => r.status, options: [
                { value: 'pending', label: 'Pending' }, { value: 'under_therapeutics', label: 'Under Therapeutics' },
                { value: 'added_to_formulary', label: 'Added to Bizbox' }, { value: 'restocked', label: 'Restocked' }] },
            { key: 'resolved', label: 'Resolved', type: 'enum', get: (r) => (r.resolved ? 'yes' : 'no'), options: [{ value: 'no', label: 'Still open' }, { value: 'yes', label: 'Resolved' }] },
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
    // the period is the only server-side parameter — it changes what is
    // counted; everything else is a filter over the rows that came back
    async function generate() {
        const p = new URLSearchParams({ reason: 'all', department: 'all' });
        if ($('from').value) p.set('from', $('from').value);
        if ($('to').value) p.set('to', $('to').value);
        const res = await api('/api/report?' + p.toString());
        if (!res.ok) { window.location.href = '/login'; return; }
        all = res.data.data.rows;
        generatedAt = res.data.data.generatedAt;
        render();
    }

    const miniTable = (kind, list) => `
        <table class="detail-table">
            <thead><tr><th>${kind}</th><th># RX</th><th># Prescribed</th></tr></thead>
            <tbody>${list.map((x) => `<tr><td>${escapeHtml(x.name)}</td><td>${x.prescriptions}</td><td>${x.volume}</td></tr>`).join('')}</tbody>
        </table>`;
    const remarkHistory = (r) => `
        <div class="detail-remarks">
            <div class="dr-h">Remarks</div>
            ${(r.remarks || []).length ? r.remarks.map((x) => `<div class="dr-row"><b>${escapeHtml(remarkText(x.remark))}</b>${x.note ? ` — ${escapeHtml(x.note)}` : ''} <span class="muted">${escapeHtml(x.actor || '')}, ${fmtDT(x.at)}</span></div>`).join('') : '<div class="muted">No remarks.</div>'}
        </div>`;
    const remarkCell = (r) => (r.lastRemark
        ? `<div class="rmk-cell"><b>${escapeHtml(remarkText(r.lastRemark.remark))}</b>${r.lastRemark.note ? `<span class="note" title="${escapeHtml(r.lastRemark.note)}">${escapeHtml(r.lastRemark.note)}</span>` : ''}${r.remarks.length > 1 ? `<span class="n">+${r.remarks.length - 1} earlier</span>` : ''}</div>`
        : '<span class="muted">—</span>');

    function render() {
        rows = fbar.apply(all);
        fbar.setCount(rows.length, all.length);
        const period = ($('from').value || $('to').value) ? `${$('from').value || '…'} to ${$('to').value || '…'}` : 'All time';
        const filt = fbar.summary();
        $('reportMeta').innerHTML = `Period: <b>${escapeHtml(period)}</b> &nbsp;|&nbsp; Filters: <b>${escapeHtml(filt || 'none')}</b> &nbsp;|&nbsp; ${generatedAt ? new Date(generatedAt).toLocaleString() : ''}`;

        $('reportKpis').innerHTML = [
            ['Drugs', rows.length],
            ['Not in Bizbox', rows.filter((r) => r.reason === 'not_in_formulary').length],
            ['Out of stock', rows.filter((r) => r.reason === 'out_of_stock').length],
            ['Prescribed but in Bizbox', rows.filter((r) => r.reason === 'normal').length],
            ['# RX', rows.reduce((s, r) => s + r.prescriptions, 0)],
            ['# Prescribed', rows.reduce((s, r) => s + r.volume, 0)],
        ].map(([l, n]) => `<div class="kpi-i"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');

        const table = $('reportTable');
        table.querySelectorAll('tbody.drug-group').forEach((t) => t.remove());
        $('reportEmpty').style.display = rows.length ? 'none' : 'block';

        rows.forEach((r) => {
            const tb = document.createElement('tbody');
            tb.className = 'drug-group';
            tb.innerHTML = `
                <tr class="clickable drug-row">
                    <td><span class="caret">▸</span> ${escapeHtml(r.generic)}</td>
                    <td>${escapeHtml(r.description || '—')}</td>
                    <td data-col="reason">${reasonText(r.reason)}</td>
                    <td data-col="rx">${r.prescriptions}</td>
                    <td data-col="qty">${r.volume}</td>
                    <td data-col="departments" class="muted">${escapeHtml(r.departments.join(', '))}</td>
                    <td data-col="status">${statusText(r)}</td>
                    <td data-col="remarks">${remarkCell(r)}</td>
                </tr>
                <tr class="detail-row" style="display:none">
                    <td colspan="8">
                        <div class="detail-grid breakdown">${miniTable('Department', r.byDepartment)}${miniTable('Doctor', r.byDoctor.map((x) => ({ ...x, name: drName(x.name) })))}</div>
                        ${remarkHistory(r)}
                    </td>
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

    // ---------- CSV ----------
    function csvCell(v) { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
    function exportCsv() {
        if (!rows.length) {
            showDialog({ kind: 'warn', title: 'Nothing to export', message: 'Generate a report first, then export it.' });
            return;
        }
        const head = ['Generic', 'Brand/Form/Strength', 'Reason', '# RX', '# Prescribed', 'Departments (# prescribed)', 'Doctors (# prescribed)', 'Status',
            'Latest remark', 'Remark note', 'Remark by', 'Remark at', 'Remark history'];
        const lines = [head.join(',')];
        rows.forEach((r) => {
            const lr = r.lastRemark;
            lines.push([
                csvCell(r.generic), csvCell(r.description || ''), reasonText(r.reason), r.prescriptions, r.volume,
                csvCell(r.byDepartment.map((x) => `${x.name}:${x.volume}`).join('; ')),
                csvCell(r.byDoctor.map((x) => `${drName(x.name)}:${x.volume}`).join('; ')),
                csvCell(statusText(r)),
                csvCell(lr ? remarkText(lr.remark) : ''), csvCell(lr ? lr.note || '' : ''), csvCell(lr ? lr.actor || '' : ''), csvCell(lr ? fmtDT(lr.at) : ''),
                csvCell((r.remarks || []).map(remarkLine).join(' | ')),
            ].join(','));
        });
        const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `tmc-rx-report-${fmtD(Date.now()).replace(/\//g, '-')}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    // ---------- print preview ----------
    // The report used to run off the right edge of the paper. The preview
    // shows the sheet at its real proportions with the settings applied —
    // paper, orientation, text size, margins, which columns — so the cut-off
    // is visible before anything is printed. Settings are per computer.
    const PAPER = { letter: [8.5, 11], a4: [8.27, 11.69], legal: [8.5, 14], long: [8.5, 13] };
    const PAGE_SIZE = { letter: 'letter', a4: 'A4', legal: 'legal', long: '8.5in 13in' };
    const DEFAULTS = { paper: 'letter', orient: 'portrait', scale: 90, margin: '0.6', cols: { reason: true, rx: true, qty: true, departments: true, status: true, remarks: true }, breakdown: true, history: true };
    let ps = loadPrintSettings();
    function loadPrintSettings() {
        try { const s = JSON.parse(localStorage.getItem('rx_report_print') || 'null'); if (s && PAPER[s.paper]) return { ...DEFAULTS, ...s, cols: { ...DEFAULTS.cols, ...(s.cols || {}) } }; } catch { /* fall through */ }
        return JSON.parse(JSON.stringify(DEFAULTS));
    }
    const savePrintSettings = () => { try { localStorage.setItem('rx_report_print', JSON.stringify(ps)); } catch { /* private mode */ } };

    const dlg = $('printDlg');
    let printStyle = null;   // the <style> that carries @page + the settings while printing

    function settingsToControls() {
        $('ppPaper').value = ps.paper;
        $('ppOrient').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === ps.orient));
        $('ppScale').value = ps.scale; $('ppScaleVal').textContent = `${ps.scale}%`;
        $('ppMargin').value = ps.margin;
        $('ppCols').querySelectorAll('input').forEach((c) => { c.checked = ps.cols[c.dataset.col] !== false; });
        $('ppBreakdown').checked = ps.breakdown;
        $('ppHistory').checked = ps.history;
    }
    // the class list + inline size that shape #report (or its preview clone)
    function applySettings(el) {
        el.classList.toggle('no-breakdown', !ps.breakdown);
        el.classList.toggle('no-history', !ps.history);
        Object.keys(DEFAULTS.cols).forEach((c) => el.classList.toggle('hide-' + c, ps.cols[c] === false));
        el.style.fontSize = `${(ps.scale / 100) * 12}px`;
    }
    const sheetInches = () => { const [w, h] = PAPER[ps.paper]; return ps.orient === 'landscape' ? [h, w] : [w, h]; };

    function renderPreview() {
        const [w, h] = sheetInches();
        const m = Number(ps.margin);
        const sheet = $('ppSheet');
        const stage = $('ppStage');
        // 96 css px per inch; scaled to fit the stage width
        const pxW = w * 96, pxH = h * 96;
        const k = Math.min(1, (stage.clientWidth - 40) / pxW);
        sheet.style.width = `${pxW}px`;
        sheet.style.minHeight = `${pxH}px`;
        sheet.style.padding = `${m * 96}px`;
        sheet.style.transform = `scale(${k})`;
        sheet.style.marginBottom = `${-(pxH * (1 - k)) + 16}px`;

        const clone = $('report').cloneNode(true);
        clone.id = 'ppReport';
        clone.classList.add('print-like');
        clone.querySelectorAll('.detail-row').forEach((d) => { d.style.display = 'table-row'; });
        clone.querySelectorAll('.caret').forEach((c) => { c.textContent = '▾'; });
        applySettings(clone);
        sheet.innerHTML = '';
        sheet.appendChild(clone);
        // an estimate is enough to tell "2 pages" from "9 pages"
        const pages = Math.max(1, Math.ceil(clone.scrollHeight / (pxH - m * 2 * 96)));
        $('ppPages').textContent = `${w}×${h} in · about ${pages} page${pages === 1 ? '' : 's'}`;
        // sheet height follows content, so the page guide lines show breaks
        sheet.style.setProperty('--page-h', `${pxH}px`);
    }

    function openPreview() {
        if (!rows.length) { showDialog({ kind: 'warn', title: 'Nothing to print', message: 'Generate a report first.' }); return; }
        settingsToControls();
        dlg.showModal();
        renderPreview();
    }
    const change = () => { savePrintSettings(); renderPreview(); };
    $('ppPaper').onchange = () => { ps.paper = $('ppPaper').value; change(); };
    $('ppOrient').querySelectorAll('button').forEach((b) => { b.onclick = () => { ps.orient = b.dataset.v; settingsToControls(); change(); }; });
    $('ppScale').oninput = () => { ps.scale = Number($('ppScale').value); $('ppScaleVal').textContent = `${ps.scale}%`; change(); };
    $('ppMargin').onchange = () => { ps.margin = $('ppMargin').value; change(); };
    $('ppCols').querySelectorAll('input').forEach((c) => { c.onchange = () => { ps.cols[c.dataset.col] = c.checked; change(); }; });
    $('ppBreakdown').onchange = () => { ps.breakdown = $('ppBreakdown').checked; change(); };
    $('ppHistory').onchange = () => { ps.history = $('ppHistory').checked; change(); };
    $('ppReset').onclick = () => { ps = JSON.parse(JSON.stringify(DEFAULTS)); settingsToControls(); change(); };
    $('ppCancel').onclick = () => dlg.close();
    window.addEventListener('resize', () => { if (dlg.open) renderPreview(); });

    $('ppPrint').onclick = () => {
        // the real #report gets the same shape as the preview, plus @page
        const report = $('report');
        applySettings(report);
        report.querySelectorAll('.detail-row').forEach((d) => { d.style.display = 'table-row'; });
        report.querySelectorAll('.caret').forEach((c) => { c.textContent = '▾'; });
        if (!printStyle) { printStyle = document.createElement('style'); document.head.appendChild(printStyle); }
        printStyle.textContent = `@page { size: ${PAGE_SIZE[ps.paper]} ${ps.orient}; margin: ${ps.margin}in; }`;
        dlg.close();
        // the dialog is in the top layer; give it a frame to leave before printing
        setTimeout(() => window.print(), 80);
    };

    $('genBtn').onclick = generate;
    $('csvBtn').onclick = exportCsv;
    $('printBtn').onclick = openPreview;
    await generate();
})();
