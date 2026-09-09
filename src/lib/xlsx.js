// Reads the first sheet of an .xlsx (or a .csv) into rows of strings.
//
// No dependency on purpose: an .xlsx is a zip of XML, and the Bizbox export is
// two columns of text — a full spreadsheet library would be the largest thing
// in node_modules to read a Map of strings. Handles what such exports contain:
// shared strings (with rich-text runs), inline strings, numbers, and both
// deflate and stored zip entries. Formulas, dates and styles are not needed.

const zlib = require('zlib');

// ---- zip ----
const readZip = (buf) => {
    // the end-of-central-directory record sits in the last 64 KB
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a zip / xlsx file');
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    const files = new Map();
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt xlsx (central directory)');
        const method = buf.readUInt16LE(p + 10);
        const csize = buf.readUInt32LE(p + 20);
        const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
        const lho = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nlen);
        const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
        const data = buf.subarray(start, start + csize);
        if (method === 8) files.set(name, zlib.inflateRawSync(data));
        else if (method === 0) files.set(name, Buffer.from(data));
        else throw new Error(`Unsupported zip compression (${method})`);
        p += 46 + nlen + elen + clen;
    }
    return files;
};

// ---- xml bits ----
const decode = (s) => String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
const textOf = (xml) => decode([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
const colIndex = (ref) => {
    let n = 0;
    for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
};

const firstSheetPath = (files) => {
    // the workbook lists sheets in order; the first one's relationship gives its file
    const wb = files.get('xl/workbook.xml');
    const rels = files.get('xl/_rels/workbook.xml.rels');
    if (wb && rels) {
        const m = wb.toString('utf8').match(/<sheet\s[^>]*r:id="([^"]+)"/);
        if (m) {
            const r = rels.toString('utf8').match(new RegExp(`<Relationship\\s[^>]*Id="${m[1]}"[^>]*Target="([^"]+)"`))
                || rels.toString('utf8').match(new RegExp(`<Relationship\\s[^>]*Target="([^"]+)"[^>]*Id="${m[1]}"`));
            if (r) { const t = r[1].replace(/^\//, ''); return t.startsWith('xl/') ? t : 'xl/' + t; }
        }
    }
    return [...files.keys()].find((k) => /^xl\/worksheets\/sheet\d*\.xml$/.test(k)) || 'xl/worksheets/sheet1.xml';
};

// -> string[][] (ragged rows, cells trimmed, trailing empty rows dropped)
const readXlsx = (buf) => {
    const files = readZip(buf);
    const shared = [];
    const ss = files.get('xl/sharedStrings.xml');
    if (ss) for (const m of ss.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));

    const sheet = files.get(firstSheetPath(files));
    if (!sheet) throw new Error('The workbook has no sheet');
    const xml = sheet.toString('utf8');
    const rows = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells = [];
        for (const c of r[1].matchAll(/<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
            const attrs = c[1], inner = c[2] || '';
            const ref = (attrs.match(/\br="([A-Z]+)\d+"/) || [])[1];
            if (!ref) continue;
            const type = (attrs.match(/\bt="([^"]+)"/) || [])[1];
            let v = '';
            const val = inner.match(/<v>([\s\S]*?)<\/v>/);
            if (type === 's' && val) v = shared[Number(val[1])] || '';
            else if (type === 'inlineStr') v = textOf(inner);
            else if (val) v = decode(val[1]);
            cells[colIndex(ref)] = String(v).trim();
        }
        rows.push(Array.from(cells, (x) => x || ''));
    }
    while (rows.length && rows[rows.length - 1].every((x) => !x)) rows.pop();
    return rows;
};

// -> string[][] — RFC-4180-ish: quoted fields, doubled quotes, CRLF
const readCsv = (buf) => {
    const text = buf.toString('utf8').replace(/^﻿/, '');
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
            else field += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') { row.push(field.trim()); field = ''; }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            row.push(field.trim()); rows.push(row); row = []; field = '';
        } else field += ch;
    }
    if (field || row.length) { row.push(field.trim()); rows.push(row); }
    while (rows.length && rows[rows.length - 1].every((x) => !x)) rows.pop();
    return rows;
};

const readSheet = (buf, filename = '') => (/\.csv$/i.test(filename) ? readCsv(buf) : readXlsx(buf));

module.exports = { readSheet, readXlsx, readCsv };
