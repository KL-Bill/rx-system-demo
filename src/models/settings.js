const db = require('../_db/db_functions');

const httpError = (status, message) => Object.assign(new Error(message), { status });

// ----- prescription footnote -----
// A line IT prints on every slip (a promo, a reminder). Where it sits, its
// size and look are IT's to choose; the nurse page only renders it. Each
// prescription keeps a copy of the footnote it was printed with, so a reprint
// reads as the original did.
const FOOTNOTE_KEY = 'rx_footnote';
const FOOTNOTE_POSITIONS = ['top', 'above_meds', 'below_meds', 'bottom'];
const FOOTNOTE_ALIGNS = ['left', 'center', 'right'];
const FOOTNOTE_FRAMES = ['none', 'line', 'box'];
const FOOTNOTE_MAX = 200;
const FOOTNOTE_DEFAULT = Object.freeze({
    enabled: true,
    text: 'Promo: Automatic 18% discount for cash purchase at TMC Pharmacy',
    position: 'bottom',
    align: 'center',
    size: 8,
    bold: true,
    italic: false,
    frame: 'box',
});

const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);

// anything stored or posted goes through here: unknown keys dropped, enums
// and size held to what the slip can lay out
const normalizeFootnote = (f = {}) => {
    const d = FOOTNOTE_DEFAULT;
    const size = Math.round(Number(f.size));
    return {
        enabled: f.enabled == null ? d.enabled : !!f.enabled,
        text: f.text == null ? d.text : String(f.text)
            .replace(/\r\n?/g, '\n')
            .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim(),
        position: pick(f.position, FOOTNOTE_POSITIONS, d.position),
        align: pick(f.align, FOOTNOTE_ALIGNS, d.align),
        size: Number.isFinite(size) ? Math.min(14, Math.max(6, size)) : d.size,
        bold: f.bold == null ? d.bold : !!f.bold,
        italic: f.italic == null ? d.italic : !!f.italic,
        frame: pick(f.frame, FOOTNOTE_FRAMES, d.frame),
    };
};

const getFootnote = async () => {
    const row = await db.getSetting(FOOTNOTE_KEY);
    return {
        footnote: normalizeFootnote(row ? row.value : FOOTNOTE_DEFAULT),
        defaults: { ...FOOTNOTE_DEFAULT },
        updatedAt: row ? row.updatedAt : null,
        updatedBy: row ? row.updatedBy : null,
    };
};

const saveFootnote = async (body, actor) => {
    if (body && body.text != null && String(body.text).length > FOOTNOTE_MAX) throw httpError(400, `Footnote is limited to ${FOOTNOTE_MAX} characters`);
    const next = normalizeFootnote(body || {});
    if (next.enabled && !next.text) throw httpError(400, 'Write the footnote text, or turn the footnote off');
    const before = (await getFootnote()).footnote;
    await db.setSetting(FOOTNOTE_KEY, next, actor);
    return { footnote: next, before };
};

// what a slip prints right now — null when IT turned it off
const activeFootnote = async () => {
    const { footnote } = await getFootnote();
    return footnote.enabled && footnote.text ? footnote : null;
};

module.exports = { getFootnote, saveFootnote, activeFootnote, normalizeFootnote, FOOTNOTE_MAX };
