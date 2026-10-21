const report = require('../models/report');
const { writeXlsx } = require('../lib/xlsx-write');

const get = async (req, res) => {
    try {
        const { reason, from, to, department, summary } = req.query;
        const data = await report.build({
            reason: reason || 'both',
            department: department || 'all',
            // summary=1 leaves out the per-doctor / per-department breakdowns;
            // the page asks for them only when a row is opened or printed
            summary: summary === '1',
            from: from ? new Date(from + 'T00:00:00').getTime() : undefined,
            to: to ? new Date(to + 'T23:59:59').getTime() : undefined,
        });
        return res.json({ success: true, data });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

// What the Excel panel sends. It posts the exact drugs its preview shows, in
// that order, and where the preview starts each page, so the workbook holds
// the same content on the same pages. The filter bar works in the browser,
// so without the list the server would build every drug — not the ones on
// screen.
const asArray = (v) => (Array.isArray(v) ? v : []);
const cut = (v) => (Array.isArray(v) && v.length === 2 && v.every(Number.isFinite) ? v : null);
const sheetOpts = (q) => {
    const cols = q.cols && typeof q.cols === 'object' ? q.cols : {};
    const colOf = (k) => (k in cols ? cols[k] !== false : q[`col_${k}`] !== '0');
    const truthy = (v) => v === true || v === '1' || v === 1;
    return {
        reason: q.reason || 'all',
        department: q.department || 'all',
        from: q.from ? new Date(q.from + 'T00:00:00').getTime() : undefined,
        to: q.to ? new Date(q.to + 'T23:59:59').getTime() : undefined,
        cols: {
            reason: colOf('reason'), rx: colOf('rx'), qty: colOf('qty'),
            departments: colOf('departments'), status: colOf('status'), remarks: colOf('remarks'),
        },
        breakdown: truthy(q.breakdown),
        history: truthy(q.history),
        periodLabel: String(q.period || ''),
        filterLabel: String(q.filters || ''),
        generatedLabel: String(q.generated || ''),
        tz: typeof q.tz === 'string' && q.tz ? q.tz : 'Asia/Manila',
        page: {
            paper: String(q.paper || 'letter'),
            orientation: String(q.orient || 'portrait'),
            margin: Number(q.margin) || 0.6,
            scale: Number(q.scale) || 100,
        },
        keys: asArray(q.keys).map(String),
        breaks: asArray(q.breaks).filter((b) => Array.isArray(b) && b.length === 3 && b.every(Number.isFinite)),
        startCut: cut(q.startCut),
        endCut: cut(q.endCut),
        heights: asArray(q.heights).map((h) => (Array.isArray(h) ? [Number(h[0]) || 0, Number(h[1]) || 0] : [0, 0])),
        linePx: Number(q.linePx) || 0,
        headPx: Number(q.headPx) || 0,
    };
};

// the report as an .xlsx, built to the settings and pages the panel shows
const xlsx = async (req, res) => {
    try {
        const wb = await report.workbook(sheetOpts({ ...req.query, ...(req.body || {}) }));
        const buf = await writeXlsx(wb);
        const stamp = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="tmc-rx-report-${stamp}.xlsx"`);
        res.setHeader('Content-Length', String(buf.length));
        if (buf.info && buf.info.pages) res.setHeader('X-Pages', String(buf.info.pages));
        return res.end(buf);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: 'Could not build the spreadsheet' });
    }
};

module.exports = { get, xlsx };
