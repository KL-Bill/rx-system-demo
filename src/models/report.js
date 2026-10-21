const demand = require('./demand');

// date-range report of problem drugs, filtered by reason (not_in_formulary | out_of_stock | both)
const build = async ({ reason, from, to, department, summary = false } = {}) => ({
    generatedAt: Date.now(),
    reason: reason || 'both',
    department: department || 'all',
    period: { from: from ?? null, to: to ?? null },
    rows: await demand.aggregate({ reason: reason || 'both', from, to, department, summary }),
});

// ----- the same report, as a spreadsheet -----
// The workbook is the print preview, laid out in cells: the letterhead with
// the logo, the table with the columns that are ticked, and under each drug
// the same per-department / per-doctor breakdown — two to a line, each with
// its "6 RX" and its units — and the same remark history. It holds exactly
// the drugs the preview shows, in the same order, and starts a new printed
// page exactly where the preview does.
const fs = require('fs');
const path = require('path');
const { paperOf, jpegSize } = require('../lib/xlsx-write');

const REMARK_WORD = {
    available_in_bizbox: 'Available in Bizbox', ordered: 'Ordered', for_order: 'For Order',
    other_brand_only: 'Only other brand available', under_therapeutics: 'Under Therapeutics review', other: 'Other',
};
const drName = (n) => {
    const s = String(n || '').trim();
    if (!s || s === '—') return s;
    return /^dr\.?\s/i.test(s) ? s : `Dr. ${s}`;
};

// the panel's own wording, word for word
const reasonText = (r) => (r === 'not_in_formulary' ? 'Not in Bizbox'
    : r === 'out_of_stock' ? 'Out of stock'
    : r === 'normal' ? 'Prescribed but In Bizbox' : r);

// Dates as the pharmacy's computer shows them. The server runs on UTC; the
// panel sends its own time zone so "3:04 PM" here is "3:04 PM" there.
const dateFmt = (tz) => (t) => (t ? new Date(t).toLocaleDateString('en-US', { timeZone: tz }) : '');
const dateTimeFmt = (tz) => (t) => (t ? new Date(t).toLocaleString('en-US', {
    timeZone: tz, month: '2-digit', day: '2-digit', year: '2-digit', hour: 'numeric', minute: '2-digit',
}) : '');

// ---- the grid ----
// 24 columns: two halves of the breakdown, each a name area of nine narrow
// columns, an RX column, a units column and a gap. The table's own columns
// are laid over the same grid by merging, in the widths the printed table
// uses, so one sheet holds both shapes.
const HALF = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1.25, 0.95, 0.8];
const UNITS = [...HALF, ...HALF];
const NAME_L = 0, RX_L = 9, QTY_L = 10, NAME_R = 12, RX_R = 21, QTY_R = 22, LAST = UNITS.length - 1;
// the printed table's column widths (report.css, fixed layout)
const COL_W = { generic: 19, desc: 19, reason: 9, rx: 5, qty: 11, departments: 17, status: 10, remarks: 10 };

const LOGO_H = 56;            // the preview's letterhead logo, in pixels
const LOGO = (() => {
    try {
        const data = fs.readFileSync(path.join(__dirname, '..', 'public', 'img', 'logo.jpg'));
        return { data, size: jpegSize(data) || { w: 1, h: 1 } };
    } catch { return null; }
})();

function gridFor(page) {
    const paper = paperOf(page);
    const margin = page.margin == null ? 0.6 : Number(page.margin);
    const scale = (page.scale || 100) / 100;
    // the sheet is exactly as wide as the paper allows at the chosen text size
    const sheetPt = ((paper.w - margin * 2) * 72) / scale;
    const unitPt = sheetPt / UNITS.reduce((a, b) => a + b, 0);
    const px = UNITS.map((u) => (u * unitPt) / 0.75);
    return { px, columns: px.map((p) => ({ width: p / 7 })) };
}

// each visible table column -> a run of grid columns, by the printed widths
function spansFor(keys, px) {
    const total = keys.reduce((s, k) => s + COL_W[k], 0);
    const edges = [0];
    let acc = 0;
    px.forEach((p) => { acc += p; edges.push(acc); });
    const out = [];
    let start = 0, want = 0;
    keys.forEach((k, i) => {
        want += COL_W[k] / total;
        let end;
        if (i === keys.length - 1) end = px.length;
        else {
            // the grid edge nearest the printed edge, leaving room for the rest
            const target = want * acc;
            end = start + 1;
            let best = Infinity;
            for (let e = start + 1; e <= px.length - (keys.length - 1 - i); e += 1) {
                const d = Math.abs(edges[e] - target);
                if (d < best) { best = d; end = e; }
            }
        }
        out.push({ key: k, from: start, to: end - 1, px: edges[end] - edges[start] });
        start = end;
    });
    return out;
}

// How tall a wrapped cell will be. Overestimating is the safe side: the row
// height is fixed, so too little would cut text off, and too much only adds
// a little air.
const CHAR_EM = 0.6;
function linesFor(text, widthPx, sizePt, bold) {
    const charPx = sizePt * (96 / 72) * CHAR_EM * (bold ? 1.08 : 1);
    const perLine = Math.max(1, Math.floor((widthPx - 8) / charPx));
    return String(text || '').split('\n').reduce((n, part) => n + Math.max(1, Math.ceil((part.length * 1.12) / perLine)), 0);
}
const lineH = (sizePt) => sizePt * 1.36;

const sheetFor = ({ data, cols = {}, breakdown = true, history = true, page = {},
    periodLabel = '', filterLabel = '', generatedLabel = '', tz = 'Asia/Manila',
    breaks = [], startCut = null, endCut = null, heights = [], linePx = 0, headPx = 0 }) => {
    // The preview measured its rows; a row printed at Excel's zoom (the text
    // size) is as tall on paper as the preview's when its height is the
    // preview's pixels in points, divided by that zoom.
    const zoom = (page.scale || 100) / 100;
    const fromPx = (px) => (px > 0 ? (px * 0.75) / zoom : 0);
    const on = (k) => cols[k] !== false;
    const fmtD = dateFmt(tz);
    const fmtDT = dateTimeFmt(tz);
    const { px, columns } = gridFor(page);
    const keys = ['generic', 'desc', 'reason', 'rx', 'qty', 'departments', 'status', 'remarks'].filter((k) => k === 'generic' || k === 'desc' || on(k));
    const spans = spansFor(keys, px);
    const sheetPx = px.reduce((a, b) => a + b, 0);

    const statusText = (r) => {
        if (r.status === 'added_to_formulary') return `Added to Bizbox (${fmtD(r.statusDate)})`;
        if (r.status === 'restocked') return `Restocked (${fmtD(r.statusDate)})`;
        if (r.status === 'under_therapeutics') return 'Under Therapeutics';
        return 'Pending';
    };
    const deptText = (r) => {
        const byVol = new Map((r.byDepartment || []).map((x) => [x.name, x.volume]));
        const names = [...(r.departments || [])].sort((a, b) => (byVol.get(b) || 0) - (byVol.get(a) || 0) || a.localeCompare(b));
        return names.length ? names.join(' · ') : '—';
    };
    const sortList = (list) => [...(list || [])].sort((a, b) => b.volume - a.volume || b.prescriptions - a.prescriptions);

    // where the preview starts each page: drug index -> [[section, line], …]
    const breakAt = new Map();
    breaks.forEach(([d, si, ln]) => {
        if (!breakAt.has(d)) breakAt.set(d, []);
        breakAt.get(d).push([si, ln]);
    });
    const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]);

    const blank = () => new Array(UNITS.length).fill(null);

    // the letterhead's text starts at the first column clear of the logo
    const logoW = LOGO ? Math.round(LOGO_H * (LOGO.size.w / LOGO.size.h)) + 10 : 0;
    let titleCol = 0;
    for (let x = 0; titleCol < UNITS.length && x < logoW; titleCol += 1) x += px[titleCol];

    function* rows() {
        // ---- letterhead ----
        const r1 = blank(); r1[titleCol] = { v: 'TAGUM MEDICAL CITY', s: 'title' };
        yield { c: r1, ht: 22 };
        const r2 = blank(); r2[titleCol] = { v: 'High-Demand Drugs Report', s: 'sub' };
        yield { c: r2, ht: 14 };
        const r3 = blank();
        r3[titleCol] = {
            s: 'meta',
            r: [
                { t: 'Period: ', sz: 8, color: 'FF5A6478' }, { t: periodLabel || 'All time', b: true, sz: 8, color: 'FF1B2333' },
                { t: '  |  Filters: ', sz: 8, color: 'FF5A6478' }, { t: filterLabel || 'none', b: true, sz: 8, color: 'FF1B2333' },
                { t: generatedLabel ? `  |  ${generatedLabel}` : '', sz: 8, color: 'FF5A6478' },
            ],
        };
        yield { c: r3, ht: 14 };
        yield { c: blank(), ht: 5, pad: 'rule' };
        yield { c: [], ht: 9 };

        // ---- column headings: repeated on every printed page ----
        const label = { generic: 'GENERIC', desc: 'BRAND / FORM / STRENGTH', reason: 'REASON', rx: '# RX', qty: '# PRESCRIBED', departments: 'DEPARTMENTS', status: 'STATUS', remarks: 'REMARKS' };
        const th = blank();
        let thLines = 1;
        spans.forEach((sp) => {
            th[sp.from] = { v: label[sp.key], s: sp.key === 'rx' || sp.key === 'qty' ? 'thR' : 'th' };
            for (let c = sp.from + 1; c <= sp.to; c += 1) th[c] = { v: '', s: sp.key === 'rx' || sp.key === 'qty' ? 'thR' : 'th' };
            thLines = Math.max(thLines, linesFor(label[sp.key], sp.px, 7, true));
        });
        yield { c: th, ht: thLines * lineH(7) + 6, m: spans.map((sp) => [sp.from, sp.to]) };

        // ---- the drugs ----
        for (let d = 0; d < data.rows.length; d += 1) {
            const r = data.rows[d];
            // the pieces of this drug, each tagged with its place in the
            // preview's plan: [-1,-1] the drug line, [si,-1] a list heading,
            // [si,k] line k of list si
            const pieces = [];

            // the drug line. A formulation of twenty ingredients in a narrow
            // column can need a row taller than Excel allows (409pt — past
            // that Excel will not open the file), so the long text steps down
            // a size at a time until the row fits.
            const kind = r.kind === 'supply' ? `Supply${r.supplyCode ? `  ${r.supplyCode}` : ''}` : 'Medicine';
            const buildLine = (big) => {
                const line = blank();
                let lines = 0, maxPt = 0;
                const put = (key, cell, text, size, bold) => {
                    const sp = spans.find((x) => x.key === key);
                    if (!sp) return;
                    line[sp.from] = cell;
                    for (let c = sp.from + 1; c <= sp.to; c += 1) line[c] = { v: '', s: cell.s };
                    const n = linesFor(text, sp.px, size, bold);
                    maxPt = Math.max(maxPt, n * lineH(size));
                    lines = Math.max(lines, n);
                };
                put('generic', {
                    s: 'td',
                    r: [{ t: '▾ ', sz: 7, color: 'FF8A94A8' }, { t: r.generic || '', sz: big }, { t: `\n${kind}`, b: true, sz: 7, color: 'FF1F3C88' }],
                }, `▾ ${r.generic || ''}\n${kind}`, big);
                put('desc', { s: 'td', r: [{ t: r.description || '—', sz: big }] }, r.description || '—', big);
                put('reason', { v: reasonText(r.reason), s: 'td' }, reasonText(r.reason), 9);
                put('rx', { v: r.prescriptions, s: 'tdR' }, String(r.prescriptions), 9);
                put('qty', { v: r.volume, s: 'tdR' }, String(r.volume), 9);
                put('departments', { v: deptText(r), s: 'tdMuted' }, deptText(r), 8.5);
                put('status', { v: statusText(r), s: 'td' }, statusText(r), 9);
                if (r.lastRemark) {
                    const runs = [{ t: REMARK_WORD[r.lastRemark.remark] || r.lastRemark.remark, b: true, sz: 9 }];
                    let text = runs[0].t;
                    if (r.lastRemark.note) { runs.push({ t: `\n${r.lastRemark.note}`, sz: 7.5, color: 'FF5A6478' }); text += `\n${r.lastRemark.note}`; }
                    if (r.remarkCount > 1) { runs.push({ t: `\n+${r.remarkCount - 1} earlier`, sz: 7.5, color: 'FF5A6478' }); text += '\nx'; }
                    put('remarks', { s: 'td', r: runs }, text, 9, true);
                } else {
                    put('remarks', { v: '—', s: 'td' }, '—', 9);
                }
                return { line, ht: maxPt + 8 };
            };
            let built = buildLine(9);
            let shrunk = false;
            for (const size of [8, 7, 6.5, 6]) {
                if (built.ht <= 400) break;
                built = buildLine(size);
                shrunk = true;
            }
            const line = built.line;
            // the preview's own height for this row, unless the text had to
            // be made smaller to fit Excel's tallest row
            const measured = heights[d] ? fromPx(heights[d][0]) : 0;
            if (measured > 0 && !shrunk) built.ht = Math.min(409, measured + 1);
            pieces.push({ pos: [-1, -1], row: { c: line, ht: built.ht, m: spans.map((sp) => [sp.from, sp.to]) } });

            // the lists, in the order and with the numbering the preview uses
            const sections = [];
            if (breakdown) {
                const dept = sortList(r.byDepartment);
                const docs = sortList(r.byDoctor).map((x) => ({ ...x, name: drName(x.name) }));
                if (dept.length) sections.push({ kind: 'bd', title: 'DEPARTMENT', list: dept });
                if (docs.length) sections.push({ kind: 'bd', title: 'DOCTOR', list: docs });
            }
            if (history && (r.remarks || []).length) sections.push({ kind: 'rem', title: 'REMARKS', list: r.remarks });

            const headRow = (sec) => {
                const c = blank();
                c[NAME_L] = {
                    s: 'bdHead',
                    r: [{ t: sec.title, b: true, sz: 7, color: 'FF10275C' }, { t: sec.kind === 'bd' ? '   prescriptions · units' : '', sz: 7, color: 'FF8A94A8' }],
                };
                if (sec.kind === 'bd') {
                    const tot = sec.list.reduce((a, x) => ({ p: a.p + x.prescriptions, v: a.v + x.volume }), { p: 0, v: 0 });
                    c[QTY_R] = { v: `${tot.p} RX · ${tot.v}`, s: 'bdTot' };
                } else {
                    c[QTY_R] = { v: `${sec.list.length} recorded`, s: 'bdTot' };
                }
                return { c, ht: headPx > 0 ? fromPx(headPx) : 15, pad: 'bdPadH' };
            };
            sections.forEach((sec, si) => {
                pieces.push({ pos: [si, -1], row: headRow(sec), sec, si });
                if (sec.kind === 'bd') {
                    // two to a line, left then right, as the preview's grid flows
                    for (let k = 0; k * 2 < sec.list.length; k += 1) {
                        const a = sec.list[k * 2], b = sec.list[k * 2 + 1];
                        const c = blank();
                        c[NAME_L] = { v: a.name, s: 'bdName' };
                        c[RX_L] = { v: a.prescriptions, s: 'bdRx' };
                        c[QTY_L] = { v: a.volume, s: 'bdQty' };
                        if (b) {
                            c[NAME_R] = { v: b.name, s: 'bdName' };
                            c[RX_R] = { v: b.prescriptions, s: 'bdRx' };
                            c[QTY_R] = { v: b.volume, s: 'bdQty' };
                        }
                        pieces.push({ pos: [si, k], row: { c, ht: linePx > 0 ? fromPx(linePx) : lineH(7.5) + 1, pad: 'bdPad' }, sec, si });
                    }
                } else {
                    sec.list.forEach((x, k) => {
                        const c = blank();
                        const text = `${REMARK_WORD[x.remark] || x.remark}${x.note ? ` — ${x.note}` : ''} ${x.actor || ''}, ${fmtDT(x.at)}`;
                        c[NAME_L] = {
                            s: 'rm',
                            r: [
                                { t: REMARK_WORD[x.remark] || x.remark, b: true, sz: 7.5 },
                                { t: x.note ? ` — ${x.note}` : '', sz: 7.5 },
                                { t: `  ${x.actor || ''}, ${fmtDT(x.at)}`, sz: 7.5, color: 'FF5A6478' },
                            ],
                        };
                        const n = linesFor(text, sheetPx, 7.5);
                        pieces.push({ pos: [si, k], row: { c, ht: n * lineH(7.5) + 2, pad: 'bdPad', m: [[0, LAST]] }, sec, si });
                    });
                }
            });
            if (sections.length) pieces.push({ pos: [99, 0], row: { c: [], ht: 5, pad: 'bdPad' }, tail: true });

            // the line a drug carries onto the next page: just its name
            const contRow = () => {
                const c = blank();
                c[0] = { v: r.generic || '', s: 'cont' };
                const n = linesFor(r.generic || '', sheetPx, 7.5, true);
                const measuredCont = heights[d] ? fromPx(heights[d][1]) : 0;
                return { c, ht: measuredCont > 0 ? measuredCont + 1 : n * lineH(7.5) + 5, pad: 'contPad', m: [[0, LAST]] };
            };

            // a page range that starts or ends inside a drug cuts it there
            let list = pieces;
            const first = d === 0 && startCut;
            const last = d === data.rows.length - 1 && endCut;
            if (first) list = list.filter((p) => cmp(p.pos, startCut) >= 0);
            if (last) list = list.filter((p) => !p.tail ? cmp(p.pos, endCut) < 0 : true);

            const at = breakAt.get(d) || [];
            const isBreak = (pos) => at.some((b) => cmp(b, pos) === 0);
            let started = false;
            for (let k = 0; k < list.length; k += 1) {
                const p = list[k];
                const breakHere = isBreak(p.pos);
                const openingCut = first && !started && p.pos[0] >= 0;
                if (breakHere && p.pos[0] < 0) {
                    yield { ...p.row, brk: true };
                } else if ((breakHere || openingCut) && p.pos[0] >= 0 && !p.tail) {
                    // a new page inside the drug: its name, then — if the page
                    // starts inside a list — that list's heading again
                    yield { ...contRow(), brk: breakHere };
                    if (p.pos[1] >= 0) yield headRow(p.sec);
                    yield p.row;
                } else {
                    yield p.row;
                }
                started = true;
            }
        }
    }

    const images = LOGO ? [{
        data: LOGO.data, ext: 'jpeg', col: 0, row: 0, offX: 0, offY: 2,
        h: LOGO_H, w: Math.round(LOGO_H * (LOGO.size.w / LOGO.size.h)),
    }] : [];

    return {
        name: 'High-Demand Drugs',
        columns,
        rows,
        page,
        titleRows: [6, 6],
        fitWidth: true,
        footer: `TMC Rx System · High-Demand Drugs Report · ${periodLabel || 'All time'}`,
        images,
    };
};

const workbook = async ({ reason, from, to, department, cols = {}, breakdown = true, history = true,
    periodLabel = '', filterLabel = '', generatedLabel = '', tz, page = {},
    keys = null, breaks = [], startCut = null, endCut = null, heights = [], linePx = 0, headPx = 0 } = {}) => {
    const data = await build({ reason, from, to, department, summary: !(breakdown || history) });
    // exactly the drugs the preview shows, in its order
    if (Array.isArray(keys) && keys.length) {
        const byKey = new Map(data.rows.map((r) => [`${r.reason}::${r.key}`, r]));
        data.rows = keys.map((k) => byKey.get(k)).filter(Boolean);
    }
    // drugs the server could not match are dropped from the keys above, so
    // the measured heights are kept only while every key was found
    const heightsOk = Array.isArray(keys) && keys.length === data.rows.length ? heights : [];
    const sheet = sheetFor({ data, cols, breakdown, history, page, periodLabel, filterLabel, generatedLabel, tz, breaks, startCut, endCut,
        heights: heightsOk, linePx, headPx });
    return { sheets: [sheet], meta: { drugs: data.rows.length, generatedAt: data.generatedAt } };
};

module.exports = { build, workbook };
