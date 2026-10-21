// A minimal .xlsx writer — no dependencies, same spirit as lib/xlsx.js on the
// reading side. It writes what the pharmacy's report needs, not a spreadsheet
// library: one styled sheet that prints like the report's own pages.
//
//   writeXlsx({ sheets }) -> Promise<Buffer>
//     sheets  [{ name, columns, rows, page, titleRows, footer, images, freeze }]
//     columns [{ width }]  Excel's own width unit (one '0' of Calibri 11)
//     rows    an iterable of rows; a row is either an array of cells or
//               { c: [cells], ht, m: [[firstCol, lastCol], …], brk, pad }
//             ht   the row's height in points — always set, so Excel never
//                  re-flows a row and the pages stay where they were planned
//             m    merges on this row, zero-based column indexes
//             brk  a printed page starts at this row
//             pad  a style for the row's empty cells (a fill across the width)
//     cell    null | string | number | { v, s } | { r: [runs], s }
//             runs are rich text: { t, b, i, sz, color }
//     page    { paper, orientation, margin, scale } — what the panel chose
//     titleRows  [first, last] rows repeated at the top of every printed page
//     images  [{ data, ext, col, row, w, h }]  w / h in pixels
//
// An .xlsx is a ZIP of XML parts, deflated with node's own zlib a chunk at a
// time: a year of prescriptions is tens of thousands of rows of repetitive
// XML, and holding it as one string took the worker past its heap limit.

const { Buffer } = require('buffer');
const { createDeflateRaw } = require('zlib');

// ---------- CRC32, as the ZIP format wants it ----------
const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();
function crcUpdate(c, buf) {
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return c;
}
const crcFinish = (c) => (c ^ -1) >>> 0;

// ---------- the ZIP container ----------
function deflateParts(chunks) {
    return new Promise((resolve, reject) => {
        const z = createDeflateRaw({ level: 6 });
        const out = [];
        let crc = -1, rawLen = 0;
        z.on('data', (c) => out.push(c));
        z.on('end', () => resolve({ data: Buffer.concat(out), crc: crcFinish(crc), rawLen }));
        z.on('error', reject);
        const it = chunks[Symbol.iterator]();
        (function pump() {
            for (;;) {
                let n;
                try { n = it.next(); } catch (err) { z.destroy(); reject(err); return; }
                if (n.done) { z.end(); return; }
                // the logo is binary; everything else is XML text
                const buf = Buffer.isBuffer(n.value) ? n.value : Buffer.from(n.value, 'utf8');
                rawLen += buf.length;
                crc = crcUpdate(crc, buf);
                if (!z.write(buf)) { z.once('drain', pump); return; }
            }
        })();
    });
}

async function zip(files) {
    const chunks = [], central = [];
    let offset = 0;
    for (const f of files) {
        const name = Buffer.from(f.name, 'utf8');
        const { data, crc, rawLen } = await deflateParts(f.chunks || [f.data]);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(8, 8);               // deflate
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(0x21, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(rawLen, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        chunks.push(local, name, data);

        const dir = Buffer.alloc(46);
        dir.writeUInt32LE(0x02014b50, 0);
        dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6);
        dir.writeUInt16LE(0, 8); dir.writeUInt16LE(8, 10);
        dir.writeUInt16LE(0, 12); dir.writeUInt16LE(0x21, 14);
        dir.writeUInt32LE(crc, 16);
        dir.writeUInt32LE(data.length, 20);
        dir.writeUInt32LE(rawLen, 24);
        dir.writeUInt16LE(name.length, 28);
        dir.writeUInt32LE(0, 38);
        dir.writeUInt32LE(offset, 42);
        central.push(Buffer.concat([dir, name]));
        offset += local.length + name.length + data.length;
    }
    const dirBuf = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(dirBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...chunks, dirBuf, end]);
}

// ---------- XML helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]
// Excel rejects the control characters a pasted note can carry
)).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

const colName = (n) => {
    let s = '';
    for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    return s;
};

// ---------- paper ----------
const PAPER = {
    letter: { code: 1, w: 8.5, h: 11 },
    a4: { code: 9, w: 8.27, h: 11.69 },
    legal: { code: 5, w: 8.5, h: 14 },
    long: { code: 14, w: 8.5, h: 13 },      // folio
};
const paperOf = (page) => {
    const p = PAPER[page.paper] || PAPER.letter;
    return page.orientation === 'landscape' ? { code: p.code, w: p.h, h: p.w } : p;
};
// a column's printed width: Excel's width unit is one '0' of Calibri 11 (7px)
const colPx = (width) => Math.round(width * 7);

// ---------- styles ----------
// Named styles, each a full description; the stylesheet is built from them.
// Cell format 0 stays Excel's untouched default — Excel ignores alignment and
// wrapping set on it, which is why the old export's text sat on one line at
// the bottom of its row — and nothing is ever written with it.
const FONT = 'Segoe UI';
const INK = 'FF1B2333', MUTED = 'FF5A6478', HEAD = 'FF65718A', NAVY = 'FF10275C', GREEN = 'FF2E7D32';
const LINE = 'FFE3E9F3', SHADE = 'FFF7F9FD', SHADE2 = 'FFF2F5FB';
const STYLES = {
    title:   { font: { sz: 14, b: true, color: NAVY } },
    sub:     { font: { sz: 9.5, color: GREEN } },
    meta:    { font: { sz: 8, color: MUTED } },
    rule:    { border: { bottom: ['medium', NAVY] } },
    th:      { font: { sz: 7, b: true, color: HEAD }, align: { v: 'bottom', wrap: true }, border: { bottom: ['thin', 'FFD9E0EC'] } },
    thR:     { font: { sz: 7, b: true, color: HEAD }, align: { h: 'right', v: 'bottom', wrap: true }, border: { bottom: ['thin', 'FFD9E0EC'] } },
    td:      { font: { sz: 9, color: INK }, align: { v: 'center', wrap: true }, border: { top: ['thin', LINE] } },
    tdR:     { font: { sz: 9, color: INK }, align: { h: 'right', v: 'center', wrap: true }, border: { top: ['thin', LINE] } },
    tdMuted: { font: { sz: 8.5, color: MUTED }, align: { v: 'center', wrap: true }, border: { top: ['thin', LINE] } },
    bdHead:  { font: { sz: 7, b: true, color: NAVY }, fill: SHADE, align: { v: 'center' }, border: { bottom: ['thin', LINE] } },
    bdTot:   { font: { sz: 7.5, color: MUTED }, fill: SHADE, align: { h: 'right', v: 'center' }, border: { bottom: ['thin', LINE] } },
    bdPadH:  { fill: SHADE, border: { bottom: ['thin', LINE] } },
    bdName:  { font: { sz: 7.5, color: INK }, fill: SHADE, align: { v: 'center' } },
    bdRx:    { font: { sz: 7, color: MUTED }, fill: SHADE, align: { h: 'right', v: 'center' }, numFmt: '0" RX"' },
    bdQty:   { font: { sz: 7.5, b: true, color: NAVY }, fill: SHADE, align: { h: 'right', v: 'center' } },
    bdPad:   { fill: SHADE },
    rm:      { font: { sz: 7.5, color: INK }, fill: SHADE, align: { v: 'top', wrap: true } },
    cont:    { font: { sz: 7.5, b: true, color: NAVY }, fill: SHADE2, align: { v: 'center', wrap: true }, border: { bottom: ['thin', LINE] } },
    contPad: { fill: SHADE2, border: { bottom: ['thin', LINE] } },
};

function buildStyles() {
    const fonts = ['<font><sz val="11"/><name val="Calibri"/></font>'];
    const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
    const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
    const numFmts = [];
    const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
    const ids = {};
    const idx = (list, xml) => { let i = list.indexOf(xml); if (i < 0) { list.push(xml); i = list.length - 1; } return i; };

    for (const [name, st] of Object.entries(STYLES)) {
        const f = st.font || {};
        const fontId = idx(fonts, `<font>${f.b ? '<b/>' : ''}${f.i ? '<i/>' : ''}<sz val="${f.sz || 9}"/><color rgb="${f.color || INK}"/><name val="${FONT}"/></font>`);
        const fillId = st.fill ? idx(fills, `<fill><patternFill patternType="solid"><fgColor rgb="${st.fill}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
        const b = st.border || {};
        const side = (k) => (b[k] ? `<${k} style="${b[k][0]}"><color rgb="${b[k][1]}"/></${k}>` : `<${k}/>`);
        const borderId = st.border ? idx(borders, `<border>${side('left')}${side('right')}${side('top')}${side('bottom')}<diagonal/></border>`) : 0;
        let numFmtId = 0;
        if (st.numFmt) {
            const at = numFmts.indexOf(st.numFmt);
            numFmtId = 164 + (at < 0 ? numFmts.push(st.numFmt) - 1 : at);
        }
        const a = st.align || {};
        const align = st.align
            ? `<alignment${a.h ? ` horizontal="${a.h}"` : ''}${a.v ? ` vertical="${a.v}"` : ''}${a.wrap ? ' wrapText="1"' : ''}/>`
            : '';
        xfs.push(`<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"`
            + `${numFmtId ? ' applyNumberFormat="1"' : ''} applyFont="1"${fillId ? ' applyFill="1"' : ''}${borderId ? ' applyBorder="1"' : ''}`
            + `${align ? ` applyAlignment="1">${align}</xf>` : '/>'}`);
        ids[name] = xfs.length - 1;
    }
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${numFmts.length ? `<numFmts count="${numFmts.length}">${numFmts.map((c, i) => `<numFmt numFmtId="${164 + i}" formatCode="${esc(c)}"/>`).join('')}</numFmts>` : ''}
<fonts count="${fonts.length}">${fonts.join('')}</fonts>
<fills count="${fills.length}">${fills.join('')}</fills>
<borders count="${borders.length}">${borders.join('')}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
    return { xml, ids };
}
const BUILT = buildStyles();

// rich text: the runs inherit nothing, so each carries its own font
const runXml = (r) => {
    const pr = `<rPr>${r.b ? '<b/>' : ''}${r.i ? '<i/>' : ''}<sz val="${r.sz || 9}"/><color rgb="${r.color || INK}"/><rFont val="${FONT}"/></rPr>`;
    return `<r>${pr}<t xml:space="preserve">${esc(r.t)}</t></r>`;
};

function cellXml(cell, ref) {
    const o = cell != null && typeof cell === 'object' ? cell : { v: cell };
    const s = o.s != null && BUILT.ids[o.s] != null ? ` s="${BUILT.ids[o.s]}"` : '';
    if (o.r) {
        // Excel refuses the whole file over one rich-text run with no text —
        // a remark without a note was enough — so empty runs are dropped
        const runs = o.r.filter((x) => x && x.t != null && String(x.t) !== '');
        if (!runs.length) return s ? `<c r="${ref}"${s}/>` : '';
        return `<c r="${ref}"${s} t="inlineStr"><is>${runs.map(runXml).join('')}</is></c>`;
    }
    if (o.v == null || o.v === '') return s ? `<c r="${ref}"${s}/>` : '';
    if (typeof o.v === 'number' && Number.isFinite(o.v)) return `<c r="${ref}"${s}><v>${o.v}</v></c>`;
    return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(o.v)}</t></is></c>`;
}

// ---------- the print scale ----------
// The pages are planned for the paper the panel chose. Excel is told to fit
// the sheet to one page wide — so a printer that swaps in other paper still
// gets whole pages, never a page split down the middle — and the sheet is
// padded on the right with an empty column so that, on the chosen paper,
// fitting the width lands exactly on the scale at which the tallest planned
// page also fits the height.
// Excel's tallest possible row. A taller one and Excel refuses the file.
const MAX_ROW_PT = 409;
const rowHt = (row) => Math.min(MAX_ROW_PT, Math.max(1, row.ht || 12));

function planScale(sh) {
    const page = sh.page || {};
    const paper = paperOf(page);
    const margin = page.margin == null ? 0.6 : Number(page.margin);
    const printW = (paper.w - margin * 2) * 72;
    const printH = (paper.h - margin * 2) * 72 - 4;   // a little under, for rounding
    const sheetW = (sh.columns || []).reduce((a, c) => a + colPx(c.width || 8), 0) * 0.75;
    const [titleFrom, titleTo] = sh.titleRows || [0, 0];
    let r = 0, titleH = 0, pageH = 0, maxPageH = 0, breaks = 0;
    for (const raw of (typeof sh.rows === 'function' ? sh.rows() : (sh.rows || []))) {
        const row = Array.isArray(raw) ? {} : raw;
        r += 1;
        const ht = rowHt(row);
        if (row.brk && r > 1) { breaks += 1; maxPageH = Math.max(maxPageH, pageH); pageH = titleH; }
        pageH += ht;
        if (r >= titleFrom && r <= titleTo) titleH += ht;
    }
    maxPageH = Math.max(maxPageH, pageH);
    let target = Math.min((page.scale || 100) / 100, printW / sheetW);
    const ours = breaks > 0 && breaks <= BRK_MAX;
    if (ours && maxPageH > 0) target = Math.min(target, printH / maxPageH);
    // the width the sheet must have for "one page wide" to come out at target
    const padPt = printW / target - sheetW;
    return { target, padWidth: padPt > 1 ? (padPt / 0.75) / 7 : 0, ours, rows: r };
}
// Excel allows 1,026 manual page breaks and calls the file corrupt past that
const BRK_MAX = 1000;

// ---------- the sheet, a piece at a time ----------
function* sheetXmlChunks(sh, result) {
    const plan = sh.fitWidth ? (sh.plan || planScale(sh)) : null;
    const columns = plan && plan.padWidth ? [...(sh.columns || []), { width: plan.padWidth }] : (sh.columns || []);
    const page = sh.page || {};
    const cols = columns.length
        ? `<cols>${columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${(c.width || 8).toFixed(3)}" customWidth="1"/>`).join('')}</cols>`
        : '';
    const pane = sh.freeze
        ? `<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="${sh.freeze}" topLeftCell="A${sh.freeze + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
        : '<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>';

    yield `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="${plan ? 1 : 0}"/></sheetPr>
${pane}<sheetFormatPr defaultRowHeight="12"/>${cols}<sheetData>`;

    const [titleFrom, titleTo] = sh.titleRows || [0, 0];
    const merges = [];
    const breaks = [];
    // heights of each printed page, to choose a print scale that holds them
    let titleH = 0, pageH = 0, maxPageH = 0;

    let r = 0;
    let buf = '';
    for (const raw of (typeof sh.rows === 'function' ? sh.rows() : (sh.rows || []))) {
        const row = Array.isArray(raw) ? { c: raw } : raw;
        r += 1;
        const ht = rowHt(row);
        if (row.brk && r > 1) {
            breaks.push(r - 1);
            maxPageH = Math.max(maxPageH, pageH);
            pageH = titleH;                       // the repeated heading sits on every page
        }
        pageH += ht;
        if (r >= titleFrom && r <= titleTo) titleH += ht;

        const cells = row.c || [];
        const width = Math.max(cells.length, row.pad ? (sh.columns || []).length : 0);
        let xml = '';
        for (let c = 0; c < width; c += 1) {
            const cell = cells[c];
            const ref = `${colName(c + 1)}${r}`;
            if (cell == null || cell === '') {
                if (row.pad) xml += `<c r="${ref}" s="${BUILT.ids[row.pad]}"/>`;
                continue;
            }
            xml += cellXml(cell, ref);
        }
        (row.m || []).forEach(([a, b]) => { if (b > a) merges.push(`${colName(a + 1)}${r}:${colName(b + 1)}${r}`); });
        buf += `<row r="${r}" ht="${ht.toFixed(2)}" customHeight="1">${xml}</row>`;
        if (buf.length > 262144) { yield buf; buf = ''; }
    }
    if (buf) yield buf;
    maxPageH = Math.max(maxPageH, pageH);

    // ---- page set-up: the paper, margins and scale the panel chose ----
    const paper = paperOf(page);
    const margin = page.margin == null ? 0.6 : Number(page.margin);
    const sheetW = columns.reduce((s, c) => s + colPx(c.width || 8), 0) * 0.75;          // points
    const printW = (paper.w - margin * 2) * 72;
    const printH = (paper.h - margin * 2) * 72;
    // the widest scale that still fits the sheet's width, never above what
    // the panel asked for, and — when the pages are ours — small enough that
    // the tallest page still fits the sheet of paper
    let scale = Math.min(page.scale || 100, (printW / sheetW) * 100);
    // above Excel's limit the pages are left to Excel and only the width counts
    const ours = breaks.length > 0 && breaks.length <= BRK_MAX;
    if (ours && maxPageH > 0) scale = Math.min(scale, ((printH * 0.985) / maxPageH) * 100);
    scale = Math.max(10, Math.min(400, Math.floor(scale)));

    const mc = merges.length
        ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
        : '';
    const foot = sh.footer
        ? `<headerFooter><oddFooter>&amp;L&amp;"${FONT},Regular"&amp;7${esc(sh.footer)}&amp;R&amp;"${FONT},Bold"&amp;7Page &amp;P of &amp;N</oddFooter></headerFooter>`
        : '';
    const brk = ours
        ? `<rowBreaks count="${breaks.length}" manualBreakCount="${breaks.length}">${breaks.map((b) => `<brk id="${b}" max="16383" man="1"/>`).join('')}</rowBreaks>`
        : '';
    const drawing = sh.images && sh.images.length ? '<drawing r:id="rId1"/>' : '';
    yield `</sheetData>${mc}
<printOptions/>
<pageMargins left="${margin}" right="${margin}" top="${margin}" bottom="${margin}" header="0.25" footer="0.25"/>
<pageSetup paperSize="${paper.code}" orientation="${page.orientation === 'landscape' ? 'landscape' : 'portrait'}" scale="${plan ? Math.floor(plan.target * 100) : scale}"${plan ? ' fitToWidth="1" fitToHeight="0"' : ''}/>
${foot}${brk}${drawing}
</worksheet>`;
    if (result) Object.assign(result, { rows: r, pages: ours ? breaks.length + 1 : null, scale: plan ? Math.floor(plan.target * 100) : scale, merges: merges.length });
}

// ---------- pictures ----------
function drawingXml(images) {
    const anchors = images.map((im, i) => {
        const cx = Math.round(im.w * 9525), cy = Math.round(im.h * 9525);
        return `<xdr:oneCellAnchor><xdr:from><xdr:col>${im.col || 0}</xdr:col><xdr:colOff>${Math.round((im.offX || 0) * 9525)}</xdr:colOff><xdr:row>${im.row || 0}</xdr:row><xdr:rowOff>${Math.round((im.offY || 0) * 9525)}</xdr:rowOff></xdr:from>`
            + `<xdr:ext cx="${cx}" cy="${cy}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i + 2}" name="Picture ${i + 1}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>`
            + `<xdr:blipFill><a:blip r:embed="rId${i + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>`
            + `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors}</xdr:wsDr>`;
}

// a JPEG's pixel size, read from its frame header
function jpegSize(buf) {
    let i = 2;
    while (i < buf.length) {
        if (buf[i] !== 0xFF) { i += 1; continue; }
        const m = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if ((m >= 0xC0 && m <= 0xC3) || (m >= 0xC5 && m <= 0xC7) || (m >= 0xC9 && m <= 0xCB) || (m >= 0xCD && m <= 0xCF)) {
            return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
    }
    return null;
}

const MIME = { jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png' };

async function writeXlsx(spec = {}) {
    const sheets = spec.sheets || [];
    const result = {};
    const sheetRefs = sheets.map((sh, i) => ({
        n: i + 1,
        name: esc(String(sh.name || `Sheet${i + 1}`)).slice(0, 31).replace(/[\\/?*[\]:]/g, ' '),
        rid: `rId${i + 1}`,
    }));
    const names = [];
    sheets.forEach((sh, i) => {
        const nm = `'${String(sh.name || 'Report').replace(/'/g, "''")}'`;
        // "Fit to one page wide" fits the print area. Left to itself Excel
        // takes the used range, which stops before the empty padding column —
        // it then fits a narrower sheet, zooms in further than planned, and
        // the taller pages spill onto extra sheets. Naming the print area
        // keeps the padding inside it.
        if (sh.fitWidth) {
            sh.plan = planScale(sh);
            const lastCol = colName((sh.columns || []).length + (sh.plan.padWidth ? 1 : 0));
            names.push(`<definedName name="_xlnm.Print_Area" localSheetId="${i}">${nm}!$A$1:$${lastCol}$${Math.max(1, sh.plan.rows)}</definedName>`);
        }
        if (sh.titleRows) names.push(`<definedName name="_xlnm.Print_Titles" localSheetId="${i}">${nm}!$${sh.titleRows[0]}:$${sh.titleRows[1]}</definedName>`);
    });
    const exts = new Set();
    sheets.forEach((sh) => (sh.images || []).forEach((im) => exts.add(im.ext || 'jpeg')));

    const files = [
        {
            name: '[Content_Types].xml',
            data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${[...exts].map((e) => `<Default Extension="${e}" ContentType="${MIME[e] || 'image/jpeg'}"/>`).join('')}
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheetRefs.map((r) => `<Override PartName="/xl/worksheets/sheet${r.n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
${sheets.map((sh, i) => (sh.images && sh.images.length ? `<Override PartName="/xl/drawings/drawing${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>` : '')).join('')}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
        },
        {
            name: '_rels/.rels',
            data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
        },
        {
            name: 'xl/workbook.xml',
            data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheetRefs.map((r) => `<sheet name="${r.name}" sheetId="${r.n}" r:id="${r.rid}"/>`).join('')}</sheets>
${names.length ? `<definedNames>${names.join('')}</definedNames>` : ''}
</workbook>`,
        },
        {
            name: 'xl/_rels/workbook.xml.rels',
            data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheetRefs.map((r) => `<Relationship Id="${r.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${r.n}.xml"/>`).join('')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
        },
        { name: 'xl/styles.xml', data: BUILT.xml },
    ];
    let media = 0;
    sheets.forEach((sh, i) => {
        files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, chunks: sheetXmlChunks(sh, i === 0 ? result : null) });
        if (!sh.images || !sh.images.length) return;
        files.push({
            name: `xl/worksheets/_rels/sheet${i + 1}.xml.rels`,
            data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${i + 1}.xml"/>
</Relationships>`,
        });
        files.push({ name: `xl/drawings/drawing${i + 1}.xml`, data: drawingXml(sh.images) });
        const rels = sh.images.map((im, k) => {
            media += 1;
            const file = `image${media}.${im.ext || 'jpeg'}`;
            files.push({ name: `xl/media/${file}`, chunks: [im.data] });
            return `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${file}"/>`;
        }).join('');
        files.push({
            name: `xl/drawings/_rels/drawing${i + 1}.xml.rels`,
            data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
        });
    });
    const buffer = await zip(files);
    buffer.info = result;
    return buffer;
}

module.exports = { writeXlsx, PAPER, paperOf, colPx, jpegSize };
