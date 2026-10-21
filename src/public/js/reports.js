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
            { label: 'Not in Bizbox', filter: { key: 'reason', op: 'is', value: 'not_in_formulary' }, group: 'reason' },
            { label: 'Out of stock', filter: { key: 'reason', op: 'is', value: 'out_of_stock' }, group: 'reason' },
            { label: 'Prescribed but In Bizbox', filter: { key: 'reason', op: 'is', value: 'normal' }, group: 'reason' },
            { label: 'Branded only', filter: { key: 'brand', op: 'not_empty' }, group: 'brand' },
            { label: 'No brand only', filter: { key: 'brand', op: 'empty' }, group: 'brand' },
            { label: 'No remarks', filter: { key: 'remark', op: 'empty' } },
            { label: 'Medicines only', filter: { key: 'kind', op: 'is', value: 'medicine' }, group: 'kind' },
            { label: 'Supplies only', filter: { key: 'kind', op: 'is', value: 'supply' }, group: 'kind' },
            { label: 'Still open', filter: { key: 'resolved', op: 'is', value: 'no' } },
        ],
        fields: [
            { key: 'kind', label: 'Medicine or supply', type: 'enum', get: (r) => r.kind || 'medicine', options: [
                { value: 'medicine', label: 'Medicine' }, { value: 'supply', label: 'Supply' }] },
            { key: 'brand', label: 'Brand', type: 'text', get: (r) => r.brand, only: (r) => r.kind !== 'supply' },
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
    // the report's period: a quick-range menu beside From/To, remembered per browser
    const periodDr = DateRange.enhance($('from'), $('to'), { storageKey: 'rx_report_period', onChange: () => generate() });

    async function generate() {
        // the previous report goes now, not when the new one arrives — leaving
        // it under a "Building…" row reads as the new figures
        const table = $('reportTable');
        table.querySelectorAll('tbody.drug-group').forEach((t) => t.remove());
        const tb = document.createElement('tbody');
        tb.className = 'drug-group';
        tb.innerHTML = loadingRows(8, 'Building the report…');
        table.appendChild(tb);
        $('reportEmpty').style.display = 'none';
        const res = await api('/api/report?' + reportParams({ summary: true }));
        if (!res.ok) { window.location.href = '/login'; return; }
        all = res.data.data.rows;
        generatedAt = res.data.data.generatedAt;
        full = false;                       // breakdowns are fetched when needed
        render();
    }

    // The report on screen is a summary: the per-doctor and per-department
    // breakdowns are most of its weight (2.9 MB of 4.3 MB over a year) and
    // only an opened row or a printed copy needs them. Printing and exporting
    // fetch the full shape first, which is why those buttons say "Preparing…".
    let full = false;
    const reportParams = ({ summary = false } = {}) => {
        const p = new URLSearchParams({ reason: 'all', department: 'all' });
        if ($('from').value) p.set('from', $('from').value);
        if ($('to').value) p.set('to', $('to').value);
        if (summary) p.set('summary', '1');
        return p.toString();
    };
    // -> true when the rows now carry breakdowns and remark history
    async function ensureFull() {
        if (full) return true;
        const res = await api('/api/report?' + reportParams());
        if (!res.ok) return false;
        const byKey = new Map(res.data.data.rows.map((r) => [r.reason + '::' + r.key, r]));
        all = all.map((r) => Object.assign(r, byKey.get(r.reason + '::' + r.key) || {}));
        rows = fbar.apply(all);
        full = true;
        return true;
    }

    // The breakdown used to be two tall tables — one line per ward, one per
    // doctor, each with its own row padding. Eleven wards cost eleven lines
    // before a single doctor was listed. Same numbers, laid out as a dense
    // list that flows into columns: the whole ward picture is two or three
    // lines, and the heaviest prescriber is first instead of whoever happened
    // to be first alphabetically.
    //   name ·· #RX / #Prescribed
    const miniTable = (kind, list) => {
        const sorted = [...(list || [])].sort((a, b) => b.volume - a.volume || b.prescriptions - a.prescriptions);
        const total = sorted.reduce((acc, x) => ({ prescriptions: acc.prescriptions + x.prescriptions, volume: acc.volume + x.volume }), { prescriptions: 0, volume: 0 });
        return `
        <div class="bd">
            <div class="bd-h">${kind}<span class="bd-leg">prescriptions · units</span><span class="bd-tot">${total.prescriptions} RX · ${total.volume}</span></div>
            <div class="bd-list">${sorted.map((x) => `
                <div class="bd-i"><span class="bd-n">${escapeHtml(x.name)}</span><span class="bd-v"><span class="bd-rx">${x.prescriptions}<i>RX</i></span><span class="bd-qty">${x.volume}</span></span></div>`).join('')}</div>
        </div>`;
    };
    // Wards in the order that matters — the one prescribing most first — and
    // each one kept whole, so the cell reads as a list instead of a paragraph
    // that breaks "Emergency" from "Room".
    const deptCell = (r) => {
        const byVol = new Map((r.byDepartment || []).map((x) => [x.name, x.volume]));
        const names = [...(r.departments || [])].sort((a, b) => (byVol.get(b) || 0) - (byVol.get(a) || 0) || a.localeCompare(b));
        if (!names.length) return '<span class="muted">—</span>';
        return `<span class="dept-list">${names.map((n) => `<span class="dept">${escapeHtml(n)}</span>`).join('')}</span>`;
    };

    const remarkHistory = (r) => `
        <div class="detail-remarks">
            <div class="dr-h">Remarks<span class="bd-tot">${(r.remarks || []).length} recorded</span></div>
            ${(r.remarks || []).length ? r.remarks.map((x) => `<div class="dr-row"><b>${escapeHtml(remarkText(x.remark))}</b>${x.note ? ` — ${escapeHtml(x.note)}` : ''} <span class="muted">${escapeHtml(x.actor || '')}, ${fmtDT(x.at)}</span></div>`).join('') : '<div class="muted">No remarks.</div>'}
        </div>`;
    const remarkCell = (r) => (r.lastRemark
        ? `<div class="rmk-cell"><b>${escapeHtml(remarkText(r.lastRemark.remark))}</b>${r.lastRemark.note ? `<span class="note" title="${escapeHtml(r.lastRemark.note)}">${escapeHtml(r.lastRemark.note)}</span>` : ''}${r.remarkCount > 1 ? `<span class="n">+${r.remarkCount - 1} earlier</span>` : ''}</div>`
        : '<span class="muted">—</span>');

    function render() {
        rows = fbar.apply(all);
        fbar.setCount(rows.length, all.length);
        const period = periodDr.label();
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
                    <td><span class="caret">▸</span> ${escapeHtml(r.generic)}${kindTag(r)}</td>
                    <td>${escapeHtml(r.description || '—')}</td>
                    <td data-col="reason">${reasonText(r.reason)}</td>
                    <td data-col="rx">${r.prescriptions}</td>
                    <td data-col="qty">${r.volume}</td>
                    <td data-col="departments" class="muted">${deptCell(r)}</td>
                    <td data-col="status">${statusText(r)}</td>
                    <td data-col="remarks">${remarkCell(r)}</td>
                </tr>
                <tr class="detail-row" style="display:none">
                    <td colspan="8">${r.byDepartment
                        ? `<div class="detail-grid breakdown">${miniTable('Department', r.byDepartment)}${miniTable('Doctor', r.byDoctor.map((x) => ({ ...x, name: drName(x.name) })))}</div>${remarkHistory(r)}`
                        : ''}</td>
                </tr>`;
            const drugRow = tb.querySelector('.drug-row');
            const detailRow = tb.querySelector('.detail-row');
            drugRow.onclick = async () => {
                const open = detailRow.style.display !== 'none';
                detailRow.style.display = open ? 'none' : 'table-row';
                drugRow.querySelector('.caret').textContent = open ? '▸' : '▾';
                if (open || r.byDepartment) return;
                // the summary has no breakdown for this row yet — fetch the one row
                const cell = detailRow.querySelector('td');
                cell.innerHTML = '<div class="muted" style="padding:8px"><span class="spin dark"></span>Loading the breakdown…</div>';
                const res = await api(`/api/pharmacy/detail?key=${encodeURIComponent(r.key)}&reason=${encodeURIComponent(r.reason)}`);
                if (res.ok && res.data.detail) Object.assign(r, res.data.detail);
                cell.innerHTML = `
                    <div class="detail-grid breakdown">${miniTable('Department', r.byDepartment || [])}${miniTable('Doctor', (r.byDoctor || []).map((x) => ({ ...x, name: drName(x.name) })))}</div>
                    ${remarkHistory(r)}`;
            };
            table.appendChild(tb);
        });
    }

    // ---------- CSV ----------
    function csvCell(v) { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
    async function exportCsv() {
        if (!rows.length) {
            showDialog({ kind: 'warn', title: 'Nothing to export', message: 'Generate a report first, then export it.' });
            return;
        }
        // the CSV carries the breakdowns and the remark history
        if (!(await ensureFull())) {
            showDialog({ kind: 'danger', title: 'Could not export', message: 'The report could not be re-read from the server. Try Generate again.' });
            return;
        }
        const head = ['Generic', 'Brand/Form/Strength', 'Type', 'Bizbox code', 'Reason', '# RX', '# Prescribed', 'Departments (# prescribed)', 'Doctors (# prescribed)', 'Status',
            'Latest remark', 'Remark note', 'Remark by', 'Remark at', 'Remark history'];
        const lines = [head.join(',')];
        rows.forEach((r) => {
            const lr = r.lastRemark;
            lines.push([
                csvCell(r.generic), csvCell(r.description || ''), r.kind === 'supply' ? 'Supply' : 'Medicine', csvCell(r.supplyCode || ''), reasonText(r.reason), r.prescriptions, r.volume,
                csvCell(r.byDepartment.map((x) => `${x.name}:${x.volume}`).join('; ')),
                csvCell(r.byDoctor.map((x) => `${drName(x.name)}:${x.volume}`).join('; ')),
                csvCell(statusText(r)),
                csvCell(lr ? remarkText(lr.remark) : ''), csvCell(lr ? lr.note || '' : ''), csvCell(lr ? lr.actor || '' : ''), csvCell(lr ? fmtDT(lr.at) : ''),
                csvCell((r.remarks || []).map(remarkLine).join(' | ')),
            ].join(','));
        });
        // \ufeff so Excel opens the accented names correctly
        const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
        const file = `tmc-rx-report-${fmtD(Date.now()).replace(/\//g, '-')}.csv`;
        const url = URL.createObjectURL(blob);
        // The anchor has to be IN the document, and the object URL has to stay
        // alive until the save has actually started — revoking it on the next
        // line (as this did) cancels the download in the kiosk client, which
        // is why exporting looked like it did nothing at all.
        const a = document.createElement('a');
        a.href = url; a.download = file; a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 30000);
        await showDialog({
            kind: 'ok', title: 'Report exported',
            message: `${rows.length} row${rows.length === 1 ? '' : 's'} saved as:`,
            detail: file,
        });
    }

    // ---------- print preview ----------
    // The report used to run off the right edge of the paper. The preview
    // shows the sheet at its real proportions with the settings applied —
    // paper, orientation, text size, margins, which columns — so the cut-off
    // is visible before anything is printed. Settings are per computer.
    const PAPER = { letter: [8.5, 11], a4: [8.27, 11.69], legal: [8.5, 14], long: [8.5, 13] };
    const PAGE_SIZE = { letter: 'letter', a4: 'A4', legal: 'legal', long: '8.5in 13in' };
    const DEFAULTS = { paper: 'letter', orient: 'portrait', scale: 90, margin: '0.6', cols: { reason: true, rx: true, qty: true, departments: true, status: true, remarks: true }, breakdown: true, history: true, mode: 'pdf' };
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
        $('ppMode').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === ps.mode));
    }
    // the class list + inline size that shape #report (or its preview clone)
    function applySettings(el) {
        el.classList.toggle('no-breakdown', !ps.breakdown);
        el.classList.toggle('no-history', !ps.history);
        Object.keys(DEFAULTS.cols).forEach((c) => el.classList.toggle('hide-' + c, ps.cols[c] === false));
        el.style.fontSize = `${(ps.scale / 100) * 12}px`;
    }
    const sheetInches = () => { const [w, h] = PAPER[ps.paper]; return ps.orient === 'landscape' ? [h, w] : [w, h]; };

    // ---------- real pages ----------
    // Chrome cannot put "Page 3 of 12" in a footer from CSS — @page margin
    // boxes are not implemented — and a single long sheet gives nothing to
    // choose from when somebody wants page 4 only. So the report is cut into
    // page-sized pieces here: each piece carries the table head, a numbered
    // footer, and never splits a drug from its breakdown.
    //
    // Only the pages near the viewport are actually built. A year of data is
    // 900 pages, and building them all froze the preview for six seconds on
    // every tick of a checkbox; now a tick re-plans (one measuring pass) and
    // paints the three pages you can see.
    const FOOT_H = 44;          // the footer rule, its line, and air above it

    // The line a drug carries onto the next page: its name, without the
    // Medicine / Supply pill or the caret.
    function contName(mainRow) {
        const first = mainRow ? mainRow.children[0] : null;
        if (!first) return '';
        const c = first.cloneNode(true);
        c.querySelectorAll('.kind-pill, .badge, .caret').forEach((x) => x.remove());
        return c.textContent.replace(/\s+/g, ' ').trim();
    }
    function contRow(mainRow, colspan) {
        const row = document.createElement('tr');
        row.className = 'cont-row';
        const td = document.createElement('td');
        td.colSpan = colspan;
        td.textContent = contName(mainRow);
        row.appendChild(td);
        return row;
    }
    let plan = null;            // { pages: [[groupIndex…]], groups, head, thead, geom }
    let pageCount = 1;
    let pageObserver = null;

    // Planning a year of drugs is seconds of measuring. Done in one go it held
    // the page's only thread the whole time: Close could not be clicked, the
    // Excel switch did not repaint, nothing answered until it finished. It
    // now works in slices of ~25ms and hands the thread back between them, so
    // every control stays live; a newer change, or closing the panel, makes
    // the plan in flight give up at its next slice.
    const SLICE_MS = 25;
    const yieldToBrowser = () => new Promise((r) => setTimeout(r, 0));

    async function measureAndPlan(geom, isStale = () => false) {
        const { pxW, pxH, marginPx } = geom;
        const contentH = pxH - marginPx * 2;

        // Measure exactly what will be printed. The clone used to keep the
        // report's ids (#ppReport, #reportTable); id-scoped rules then won
        // over class rules inside it, so the small "RX" and figure spans
        // took different sizes here than on the built pages, every
        // breakdown line came out 0.8px shorter than on paper, and thirty
        // lines in, the page ran past its bottom edge and was cut off.
        // The pages carry no ids, so neither does the clone.
        // Only the frame is copied now; each drug is copied inside its own
        // slice. Copying the whole report up front was 150ms of solid work
        // and a hundred thousand fresh nodes for the collector to sweep in
        // one go — the half-second freeze left after slicing the measuring.
        const live = $('report');
        const liveTable = live.querySelector('table.dense') || live.querySelector('table');
        const liveGroups = [...(liveTable ? liveTable.querySelectorAll('tbody.drug-group') : [])];
        const prep = (el) => {
            el.removeAttribute('id');
            el.querySelectorAll('[id]').forEach((x) => x.removeAttribute('id'));
            el.querySelectorAll('.detail-row').forEach((d) => { d.style.display = 'table-row'; });
            el.querySelectorAll('.caret').forEach((c) => { c.textContent = '▾'; });
            return el;
        };
        const liveHead = live.querySelector('.report-header');

        // The measuring area IS a page: the same .pp-page and .pp-body, the
        // same width and padding, inside the same preview container, holding
        // only the header and the table. Measuring inside a copy of the
        // on-screen report card meant the card's own padding narrowed the
        // table, long names wrapped more, and a drug row planned at 439px
        // printed at 282px — leaving a quarter of the page empty.
        const ruler = pageShell(0, 1, geom, '');
        ruler.classList.add('pp-ruler');
        ruler.style.cssText += ';position:absolute;left:-100000px;top:0;visibility:hidden;height:auto;';
        const rulerBody = ruler.querySelector('.pp-body');
        rulerBody.style.maxHeight = 'none';
        const head = liveHead ? prep(liveHead.cloneNode(true)) : null;
        let table = null;
        if (liveTable) {
            table = prep(liveTable.cloneNode(false));
            const lt = liveTable.querySelector('thead');
            if (lt) table.appendChild(prep(lt.cloneNode(true)));
        }
        // the drugs go in a slice at a time; columns are fixed-width, so a
        // drug measures the same in a slice as it would among all the others
        const groups = new Array(liveGroups.length);
        if (head) rulerBody.appendChild(head);
        if (table) rulerBody.appendChild(table);
        // Its own sheet wrapper, carrying the orientation being planned.
        // Measured inside the live sheet, it picked up whatever orientation
        // was showing before the switch — portrait's tighter type, measured
        // for a landscape page — and every landscape page then overflowed.
        const host = document.createElement('div');
        host.className = `pp-sheet pp-multi${ps.orient !== 'landscape' ? ' pp-portrait' : ''}`;
        host.style.cssText = 'position:absolute;left:-100000px;top:0;visibility:hidden;width:auto;';
        host.appendChild(ruler);
        ($('ppStage') || document.body).appendChild(host);
        const giveUp = () => { host.remove(); return null; };

        const thead = table ? table.querySelector('thead') : null;
        // Fractional sizes throughout. offsetHeight rounds, and a doctor list
        // of thirty lines that each measure 12px but render 12.6px is 18px
        // longer on paper than on the plan — enough to push its last lines
        // past the bottom of the page.
        const R = (el) => el.getBoundingClientRect();
        const marginB = (el) => parseFloat(getComputedStyle(el).marginBottom) || 0;
        const headH = head ? R(head).height + marginB(head) : 0;
        const theadH = thead ? R(thead).height : 0;
        const tableClass = table ? table.className : 'dense';
        let DETAIL_PAD = null;              // the detail cell's real top + bottom padding

        // ---- measure each drug as a sequence of pieces that can be cut apart ----
        // A drug prescribed by sixty doctors is taller than the sheet. Keeping
        // it whole meant a page per drug with the lower half empty; so the
        // breakdown is measured row by row and may run on to the next page
        // under the drug's name.
        const measureGroup = (g) => {
            const mainRow = g.querySelector('tr:not(.detail-row)');
            const detailRow = g.querySelector('.detail-row');
            const piece = { mainRow, detailRow, mainH: mainRow ? R(mainRow).height : 0, sections: [] };
            if (!detailRow || R(detailRow).height <= 0) return piece;
            if (DETAIL_PAD == null) {
                const td = detailRow.querySelector('td');
                const cs = td ? getComputedStyle(td) : null;
                DETAIL_PAD = cs ? (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) : 9;
            }

            // A section is its heading, then lines of the grid. Each line's
            // height is the distance to the next line's top — so row gaps and
            // fractional heights are counted — and the last line runs to the
            // section's bottom edge plus its margin.
            const addList = (box, headEl, listEl, items, kind) => {
                if (!items.length) return;
                const boxR = R(box);
                const lines = [];
                let last = null;
                items.forEach((el) => {
                    const top = R(el).top;
                    if (!last || Math.abs(top - last.top) > 2) {
                        last = { top, els: [el], h: 0 };
                        lines.push(last);
                    } else {
                        last.els.push(el);
                    }
                });
                lines.forEach((ln, i) => {
                    ln.h = (i < lines.length - 1 ? lines[i + 1].top : boxR.bottom) - ln.top;
                });
                lines[lines.length - 1].h += marginB(box);
                piece.sections.push({
                    kind,
                    headEl,
                    listEl,
                    // the heading, the gap under it, and any margin above the block
                    headH: lines[0].top - boxR.top + (parseFloat(getComputedStyle(box).marginTop) || 0),
                    lines,
                });
            };

            [...detailRow.querySelectorAll('.bd')].forEach((bd) => {
                if (R(bd).height <= 0) return;
                addList(bd, bd.querySelector('.bd-h'), bd.querySelector('.bd-list'), [...bd.querySelectorAll('.bd-i')], 'bd');
            });
            const rem = detailRow.querySelector('.detail-remarks');
            if (rem && R(rem).height > 0) {
                addList(rem, rem.querySelector('.dr-h'), rem, [...rem.querySelectorAll('.dr-row')], 'rem');
            }
            return piece;
        };
        const colspanOf = (pl) => (pl.detailRow && pl.detailRow.querySelector('td') ? pl.detailRow.querySelector('td').colSpan : 9);

        const plans = [];
        let i = 0;
        while (i < groups.length) {
            if (isStale()) return giveUp();
            const t0 = performance.now();
            // as many drugs as fit in one slice
            while (i < groups.length && performance.now() - t0 < SLICE_MS) {
                const batch = liveGroups.slice(i, i + 20).map((g, k) => {
                    const c = prep(g.cloneNode(true));
                    groups[i + k] = c;
                    return c;
                });
                batch.forEach((g) => table.appendChild(g));
                const measured = batch.map(measureGroup);
                // the carried-over line wraps when the name is long, so it is
                // measured per drug rather than assumed to be one line
                const scratch = document.createElement('tbody');
                scratch.className = 'drug-group';
                table.appendChild(scratch);
                const rowsC = measured.map((pl) => {
                    const row = contRow(pl.mainRow, colspanOf(pl));
                    scratch.appendChild(row);
                    return row;
                });
                rowsC.forEach((row, k) => { measured[k].contH = R(row).height; });
                scratch.remove();
                batch.forEach((g) => g.remove());
                plans.push(...measured);
                i += batch.length;
            }
            await yieldToBrowser();
        }
        host.remove();
        if (DETAIL_PAD == null) DETAIL_PAD = 9;
        if (isStale()) return null;

        // ---- pack the pieces into pages ----
        const pages = [];
        let cur = [], used = 0, first = true;
        // a few pixels of slack for whatever rounding is left
        const SLACK = 14;
        const room = () => contentH - theadH - FOOT_H - SLACK - (first ? headH : 0);
        const flush = () => { pages.push(cur); cur = []; used = 0; first = false; };

        plans.forEach((pl, gi) => {
            const fits = (h) => used + h <= room();
            // enough for the drug line plus the first line of its breakdown,
            // so a page never ends on a drug name by itself
            const sec0 = pl.sections[0];
            const open = pl.mainH + (sec0 ? DETAIL_PAD + sec0.headH + (sec0.lines[0] ? sec0.lines[0].h : 0) : 0);
            if (cur.length && !fits(open)) flush();
            cur.push({ gi, kind: 'main' });
            used += pl.mainH;
            let openedDetail = false;

            pl.sections.forEach((sec, si) => {
                const firstLineH = sec.lines.length ? sec.lines[0].h : 0;
                const need = sec.headH + firstLineH + (openedDetail ? 0 : DETAIL_PAD);
                if (!fits(need)) { flush(); cur.push({ gi, kind: 'cont' }); used += pl.contH || 26; openedDetail = false; }
                if (!openedDetail) { used += DETAIL_PAD; openedDetail = true; }
                cur.push({ gi, kind: 'sec', si });
                used += sec.headH;

                let from = 0;
                for (let k = 0; k < sec.lines.length; k += 1) {
                    if (!fits(sec.lines[k].h)) {
                        if (k > from) cur.push({ gi, kind: 'lines', si, from, to: k });
                        flush();
                        cur.push({ gi, kind: 'cont' });
                        used += (pl.contH || 26) + DETAIL_PAD;
                        openedDetail = true;
                        cur.push({ gi, kind: 'sec', si, continued: true });
                        used += sec.headH;
                        from = k;
                    }
                    used += sec.lines[k].h;
                }
                if (from < sec.lines.length) cur.push({ gi, kind: 'lines', si, from, to: sec.lines.length });
            });
        });
        if (cur.length) pages.push(cur);
        if (!pages.length) pages.push([]);

        return { pages, groups, plans, head, thead, tableClass, geom, period: periodDr.label() };
    }

    // the empty page: its size and its numbered footer, which is all that is
    // needed before it comes into view
    function pageShell(i, total, { pxW, pxH, marginPx }, period) {
        const page = document.createElement('div');
        page.className = 'pp-page';
        page.dataset.page = String(i + 1);
        page.style.width = `${pxW}px`;
        page.style.height = `${pxH}px`;
        page.style.padding = `${marginPx}px`;
        // absolute positioning ignores padding, so the footer is given the
        // margin explicitly — otherwise the page number sits on the paper edge
        page.style.setProperty('--pp-pad', `${marginPx}px`);
        const body = document.createElement('div');
        body.className = 'pp-body print-like';
        body.style.maxHeight = `${pxH - marginPx * 2 - FOOT_H}px`;
        applySettings(body);
        page.appendChild(body);
        const foot = document.createElement('div');
        foot.className = 'pp-foot';
        foot.innerHTML = `<span>TMC Rx System · High-Demand Drugs Report · ${escapeHtml(period)}</span>`
            + `<span class="pp-no">Page ${i + 1} of ${total}</span>`;
        page.appendChild(foot);
        return page;
    }

    // Build one page from its pieces. A page can start in the middle of a
    // drug, so it carries its own copy of the drug line and of the heading of
    // whichever list is being continued.
    function fillPage(page) {
        if (!plan || page.dataset.filled === '1') return;
        const i = Number(page.dataset.page) - 1;
        const body = page.querySelector('.pp-body');
        body.innerHTML = '';
        if (i === 0 && plan.head) body.appendChild(plan.head.cloneNode(true));

        const t = document.createElement('table');
        t.className = plan.tableClass;
        if (plan.thead) t.appendChild(plan.thead.cloneNode(true));

        let tb = null, grid = null, bd = null, list = null, curGi = -1, curSi = -1;
        const colspan = (plan.plans[0] && plan.plans[0].detailRow)
            ? (plan.plans[0].detailRow.querySelector('td') || {}).colSpan || 9 : 9;

        const openDetail = () => {
            if (grid) return;
            const tr = document.createElement('tr');
            tr.className = 'detail-row';
            const td = document.createElement('td');
            td.colSpan = colspan;
            grid = document.createElement('div');
            grid.className = 'detail-grid breakdown';
            td.appendChild(grid);
            tr.appendChild(td);
            tb.appendChild(tr);
        };

        for (const a of (plan.pages[i] || [])) {
            const pl = plan.plans[a.gi];
            if (a.kind === 'main' || a.kind === 'cont') {
                tb = document.createElement('tbody');
                tb.className = 'drug-group';
                let row;
                if (a.kind === 'cont') {
                    // Carrying the whole drug row over — description and all —
                    // spent most of a landscape page repeating a formulation.
                    // The drug's name says whose list this is.
                    row = contRow(pl.mainRow, colspan);
                } else {
                    row = pl.mainRow ? pl.mainRow.cloneNode(true) : document.createElement('tr');
                }
                tb.appendChild(row);
                t.appendChild(tb);
                grid = null; bd = null; list = null; curGi = a.gi; curSi = -1;
            } else if (a.kind === 'sec') {
                openDetail();
                const sec = pl.sections[a.si];
                bd = sec.kind === 'rem' ? document.createElement('div') : sec.listEl.parentElement.cloneNode(false);
                if (sec.kind === 'rem') bd.className = 'detail-remarks';
                if (sec.headEl) bd.appendChild(sec.headEl.cloneNode(true));
                list = sec.kind === 'rem' ? bd : sec.listEl.cloneNode(false);
                if (list !== bd) bd.appendChild(list);
                grid.appendChild(bd);
                curSi = a.si;
            } else if (a.kind === 'lines') {
                const sec = pl.sections[a.si];
                if (curSi !== a.si || !list) continue;
                for (let k = a.from; k < a.to; k += 1) {
                    sec.lines[k].els.forEach((el) => list.appendChild(el.cloneNode(true)));
                }
            }
        }
        body.appendChild(t);
        page.dataset.filled = '1';
    }

    // each rebuild has a number; only the newest is allowed to finish
    let planGen = 0;

    // Print and Export read the plan — if one is still being built for the
    // settings just chosen, use that one, not the last finished one
    async function waitForPreview() {
        const stage = $('ppStage');
        for (let t = 0; t < 600 && stage.classList.contains('is-updating') && dlg.open; t += 1) {
            await new Promise((r) => setTimeout(r, 100));
        }
    }

    async function renderPreview() {
        const gen = ++planGen;
        const [w, h] = sheetInches();
        const m = Number(ps.margin);
        const stage = $('ppStage');
        const sheet = $('ppSheet');
        const geom = { pxW: w * 96, pxH: h * 96, marginPx: m * 96 };

        const next = await measureAndPlan(geom, () => gen !== planGen || !dlg.open);
        if (!next || gen !== planGen) return false;
        plan = next;
        pageCount = plan.pages.length;

        const k = Math.min(1, (stage.clientWidth - 40) / geom.pxW);
        sheet.className = `pp-sheet pp-multi${ps.orient !== 'landscape' ? ' pp-portrait' : ''}`;
        sheet.removeAttribute('style');
        sheet.style.width = `${geom.pxW * k}px`;
        sheet.innerHTML = '';

        if (pageObserver) pageObserver.disconnect();
        pageObserver = new IntersectionObserver((entries) => {
            entries.forEach((e) => { if (e.isIntersecting) fillPage(e.target); });
        }, { root: stage, rootMargin: '600px 0px' });

        plan.pages.forEach((_, i) => {
            const holder = document.createElement('div');
            holder.className = 'pp-holder';
            holder.style.width = `${geom.pxW * k}px`;
            holder.style.height = `${geom.pxH * k + 14}px`;
            const page = pageShell(i, plan.pages.length, geom, plan.period);
            page.style.transform = `scale(${k})`;
            holder.appendChild(page);
            sheet.appendChild(holder);
            pageObserver.observe(page);
        });
        // the first few, so the preview is never blank
        [...sheet.querySelectorAll('.pp-page')].slice(0, 3).forEach(fillPage);

        $('ppPages').textContent = `${w}×${h} in · ${pageCount} page${pageCount === 1 ? '' : 's'}`;
        const to = $('ppTo');
        if (to) { to.max = String(pageCount); to.placeholder = String(pageCount); }
        const from = $('ppFrom');
        if (from) from.max = String(pageCount);
        return true;
    }

    // Any settings change: say so, let the browser paint that, then do the
    // work. Several ticks in a row collapse into one rebuild.
    let previewTimer = null;
    function schedulePreview() {
        const stage = $('ppStage');
        stage.classList.add('is-updating');
        clearTimeout(previewTimer);
        // the title and the primary button follow the switch at once,
        // not after the pages are planned
        applyMode();
        previewTimer = setTimeout(() => {
            requestAnimationFrame(() => setTimeout(async () => {
                try {
                    // a rebuild that was overtaken leaves the overlay to the
                    // one that overtook it
                    if (await renderPreview()) stage.classList.remove('is-updating');
                } catch (err) {
                    console.error('preview', err);
                    stage.classList.remove('is-updating');
                }
            }, 0));
        }, 140);
    }

    // The printed copy can carry the per-department / per-doctor breakdown and
    // the remark history. The screen does not fetch those until a row is
    // opened, so printing has to pull them in first — otherwise the preview
    // (and the paper) shows the headings with nothing under them.
    async function needDetail() {
        if (!ps.breakdown && !ps.history) return true;
        if (full) return true;
        const ok = await ensureFull();
        if (!ok) {
            await showDialog({
                kind: 'danger', title: 'Could not prepare the report',
                message: 'The breakdowns could not be read from the server. Press Generate and try again.',
            });
            return false;
        }
        render();                       // redraw so the detail rows carry them
        return true;
    }

    async function openPreview(mode) {
        if (!rows.length) { showDialog({ kind: 'warn', title: 'Nothing to print', message: 'Generate a report first.' }); return; }
        if (!(await needDetail())) return;
        if (mode) { ps.mode = mode; savePrintSettings(); }
        settingsToControls();
        dlg.showModal();
        schedulePreview();
    }
    // toggling either of these on mid-preview needs the same data
    const change = async () => {
        // the overlay goes up in the same tick as the click, before anything
        // is awaited — otherwise the first frame after a tick is a frozen
        // picture with no explanation
        $('ppStage').classList.add('is-updating');
        savePrintSettings();
        if (!(await needDetail())) { $('ppStage').classList.remove('is-updating'); return; }
        schedulePreview();
    };
    $('ppPaper').onchange = () => { ps.paper = $('ppPaper').value; change(); };
    $('ppOrient').querySelectorAll('button').forEach((b) => { b.onclick = () => { ps.orient = b.dataset.v; settingsToControls(); change(); }; });
    $('ppScale').oninput = () => { ps.scale = Number($('ppScale').value); $('ppScaleVal').textContent = `${ps.scale}%`; change(); };
    $('ppMargin').onchange = () => { ps.margin = $('ppMargin').value; change(); };
    $('ppCols').querySelectorAll('input').forEach((c) => { c.onchange = () => { ps.cols[c.dataset.col] = c.checked; change(); }; });
    $('ppBreakdown').onchange = () => { ps.breakdown = $('ppBreakdown').checked; change(); };
    $('ppHistory').onchange = () => { ps.history = $('ppHistory').checked; change(); };
    // the range decides which pages Excel prints, so the preview follows it
    $('ppAllPages').onclick = () => { $('ppFrom').value = ''; $('ppTo').value = ''; schedulePreview(); };
    ['ppFrom', 'ppTo'].forEach((id) => { $(id).oninput = () => schedulePreview(); });
    $('ppMode').querySelectorAll('button').forEach((b) => {
        b.onclick = () => { ps.mode = b.dataset.v; savePrintSettings(); applyMode(); schedulePreview(); };
    });

    // Excel gets the same report the printer would: the columns that are
    // switched on, and the breakdown / remark history if they are asked for.
    // The server builds the file, so a year of rows never has to be turned
    // into a string in the browser.
    // Both the preview and the file are built from the same sheet on the
    // server, so the panel can only ever show what the download holds.
    // Where a preview page begins, in the plan's own terms:
    //   [drug, -1, -1]  at a drug's line
    //   [drug, si, -1]  at the heading of list si (the drug's name above it)
    //   [drug, si, k]   at line k of list si, carried over from the page before
    function pageStart(atoms) {
        const a0 = atoms && atoms[0];
        if (!a0) return null;
        if (a0.kind === 'main') return [a0.gi, -1, -1];
        if (a0.kind === 'cont') {
            const a1 = atoms[1], a2 = atoms[2];
            if (!a1 || a1.kind !== 'sec') return [a0.gi, -1, -1];
            if (!a1.continued) return [a0.gi, a1.si, -1];
            return [a0.gi, a1.si, a2 && a2.kind === 'lines' ? a2.from : 0];
        }
        return null;
    }

    // What the workbook is built from: the drugs the preview shows, in its
    // order — the filter bar works here in the browser, so the server cannot
    // know them otherwise — and where each of the preview's pages begins, so
    // Excel prints the same pages. "Pages to print" narrows both.
    function excelBody() {
        const r = pageRange();
        const pages = plan ? plan.pages : [];
        const from = Math.max(1, r.from), to = Math.min(pages.length || 1, r.to);
        let lo = 0, hi = rows.length - 1;
        if (pages.length && (from > 1 || to < pages.length)) {
            lo = Infinity; hi = -Infinity;
            for (let i = from - 1; i <= to - 1; i += 1) {
                for (const a of pages[i]) { lo = Math.min(lo, a.gi); hi = Math.max(hi, a.gi); }
            }
            if (!Number.isFinite(lo)) { lo = 0; hi = rows.length - 1; }
        }
        const breaks = [];
        for (let i = from; i <= to - 1 && i < pages.length; i += 1) {
            const st = pageStart(pages[i]);
            if (st) breaks.push([st[0] - lo, st[1], st[2]]);
        }
        // a range that begins or ends in the middle of a drug
        const s0 = pages.length ? pageStart(pages[from - 1]) : null;
        const startCut = s0 && s0[0] === lo && s0[1] >= 0 ? [s0[1], s0[2]] : null;
        const e0 = to < pages.length ? pageStart(pages[to]) : null;
        const endCut = e0 && e0[0] === hi && e0[1] >= 0 ? [e0[1], e0[2]] : null;

        return {
            reason: 'all', department: 'all',
            from: $('from').value || undefined, to: $('to').value || undefined,
            cols: ps.cols, breakdown: !!ps.breakdown, history: !!ps.history,
            period: periodDr.label(), filters: fbar.summary() || 'none',
            generated: generatedAt ? new Date(generatedAt).toLocaleString() : '',
            tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
            paper: ps.paper, orient: ps.orient, margin: ps.margin, scale: ps.scale,
            keys: rows.slice(lo, hi + 1).map((x) => `${x.reason}::${x.key}`),
            breaks, startCut, endCut,
            // the heights the preview measured — the drug line and the
            // carried-over line for each drug, one breakdown line and one list
            // heading — so Excel's rows are as tall as the preview's, not an
            // estimate of them
            heights: plan ? plan.plans.slice(lo, hi + 1).map((pl) => [+(pl.mainH || 0).toFixed(2), +(pl.contH || 0).toFixed(2)]) : [],
            ...(() => {
                if (!plan) return {};
                for (const pl of plan.plans) {
                    const sec = pl.sections.find((x) => x.kind === 'bd' && x.lines.length > 1);
                    if (sec) return { linePx: +sec.lines[0].h.toFixed(3), headPx: +sec.headH.toFixed(3) };
                }
                return {};
            })(),
        };
    }

    // Both outputs show the same preview: these are the same pages, printed
    // or saved as a workbook, so there is nothing to show differently.
    function applyMode() {
        const excel = ps.mode === 'excel';
        $('ppTitle').textContent = excel ? 'Export to Excel' : 'Print / PDF';
        $('ppSub').textContent = excel
            ? 'These are the pages the workbook will hold, set up to print on this paper.'
            : 'What you see on the right is the page. Settings are remembered on this computer.';
        document.querySelector('.pp').classList.toggle('mode-excel', excel);
        $('ppMode').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === ps.mode));
    }

    async function exportExcel() {
        await waitForPreview();
        const res = await fetch('/api/report/export.xlsx', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(excelBody()),
        });
        if (!res.ok) {
            await showDialog({ kind: 'danger', title: 'Could not export', message: 'The spreadsheet could not be built. Try Generate again.' });
            return;
        }
        const blob = await res.blob();
        const file = `tmc-rx-report-${fmtD(Date.now()).replace(/\//g, '-')}.xlsx`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = file; a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 30000);
        await showDialog({
            kind: 'ok', title: 'Exported to Excel',
            message: `${rows.length} drug${rows.length === 1 ? '' : 's'}${ps.breakdown ? ', with the department and doctor breakdown' : ''}${ps.history ? ' and the remark history' : ''}, saved as:`,
            detail: file,
        });
    }
    $('ppExcel').onclick = () => withButton($('ppExcel'), 'Building…', exportExcel);
    $('ppReset').onclick = () => { ps = JSON.parse(JSON.stringify(DEFAULTS)); settingsToControls(); change(); };
    $('ppCancel').onclick = () => dlg.close();
    // closed by the button or by Esc: drop the plan in flight and the overlay
    dlg.addEventListener('close', () => {
        planGen += 1;
        clearTimeout(previewTimer);
        $('ppStage').classList.remove('is-updating');
    });
    window.addEventListener('resize', () => { if (dlg.open) schedulePreview(); });

    // which pages the printer gets: blank means all of them
    function pageRange() {
        const a = parseInt($('ppFrom').value, 10);
        const b = parseInt($('ppTo').value, 10);
        const from = Number.isFinite(a) && a > 0 ? a : 1;
        const to = Number.isFinite(b) && b > 0 ? b : pageCount;
        return from <= to ? { from, to } : { from: to, to: from };
    }

    $('ppPrint').onclick = () => withButton($('ppPrint'), 'Preparing…', async () => {
        await waitForPreview();
        const [w, h] = sheetInches();
        const m = Number(ps.margin);
        const geom = { pxW: w * 96, pxH: h * 96, marginPx: m * 96 };
        if (!plan) plan = await measureAndPlan(geom);
        const { from, to } = pageRange();
        // the printer gets fully built pages, not the lazy shells
        const pages = plan.pages.map((_, i) => {
            const pg = pageShell(i, plan.pages.length, geom, plan.period);
            if (i + 1 >= from && i + 1 <= to) fillPage(pg);
            return pg;
        });

        // the printed copy is the same pages the preview showed, so what is on
        // screen is what comes out — including the page numbers
        let host = document.getElementById('printPages');
        if (!host) { host = document.createElement('div'); host.id = 'printPages'; document.body.appendChild(host); }
        host.innerHTML = '';
        pages.forEach((pg, i) => {
            if (i + 1 < from || i + 1 > to) return;
            pg.style.transform = '';
            pg.style.width = ''; pg.style.height = ''; pg.style.padding = '';
            host.appendChild(pg);
        });

        if (!printStyle) { printStyle = document.createElement('style'); document.head.appendChild(printStyle); }
        printStyle.textContent = `@page { size: ${PAGE_SIZE[ps.paper]} ${ps.orient}; margin: ${ps.margin}in; }`;
        document.body.classList.add('printing-pages');
        dlg.close();
        const done = () => { document.body.classList.remove('printing-pages'); window.removeEventListener('afterprint', done); };
        window.addEventListener('afterprint', done);
        await new Promise((r) => setTimeout(r, 80));
        window.print();
        setTimeout(done, 1000);
    });

    $('genBtn').onclick = () => withButton($('genBtn'), 'Generating…', generate);
    // The toolbar used to hand out a CSV: one flat dump with the breakdown
    // crammed into the same columns. It exports the workbook now; the CSV is
    // still there for anyone feeding another system, on Shift+click.
    $('csvBtn').onclick = (e) => (e.shiftKey
        ? withButton($('csvBtn'), 'Preparing…', exportCsv)
        : withButton($('csvBtn'), 'Preparing…', () => openPreview('excel')));
    $('printBtn').onclick = () => withButton($('printBtn'), 'Preparing…', () => openPreview('pdf'));
    await generate();
})();
