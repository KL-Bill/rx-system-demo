const { pool, newId } = require('./store');
const catalogCache = require('./catalog-cache');

const norm = (x) => String(x || '').trim().toLowerCase();
// stable identity for a prescribed product, used to group demand and key review status
const drugKey = (m) => [m.genericName, m.brandName, m.formName, m.strength].map(norm).join('|');

const toNum = (x) => (x == null ? null : Number(x));

// ---------- users ----------
// roles: 'admin' (pharmacy head), 'staff' (pharmacy staff), 'it'
const getUserByUsername = async (username) => {
    const { rows } = await pool.query(
        'SELECT id, name, username, password_hash AS password, role, active FROM users WHERE username = $1',
        [username]);
    return rows[0] || null;
};
const getUserById = async (id) => {
    const { rows } = await pool.query(
        'SELECT id, name, username, password_hash AS password, role, active FROM users WHERE id = $1', [id]);
    return rows[0] || null;
};
const getAdmins = async () => {
    const { rows } = await pool.query(
        `SELECT id, name, username, password_hash AS password, role FROM users
         WHERE role = 'admin' AND active`);
    return rows;
};
const listUsers = async () => {
    const { rows } = await pool.query(
        'SELECT id, name, username, role, active FROM users ORDER BY role, username');
    return rows;
};
const insertUser = async ({ id, name, username, passwordHash, role }) => {
    await pool.query(
        'INSERT INTO users (id, name, username, password_hash, role) VALUES ($1, $2, $3, $4, $5)',
        [id, name, username, passwordHash, role]);
};
const updateUserPassword = async (id, passwordHash) => {
    await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [id, passwordHash]);
};
const setUserActive = async (id, active) => {
    await pool.query('UPDATE users SET active = $2 WHERE id = $1', [id, active]);
};

// ---------- stations / doctors ----------
const getStations = async () => {
    const { rows } = await pool.query('SELECT id, name, department FROM stations');
    return rows;
};
const getStation = async (id) => {
    const { rows } = await pool.query('SELECT id, name, department FROM stations WHERE id = $1', [id]);
    return rows[0] || null;
};
const getDoctors = async () => {
    const { rows } = await pool.query('SELECT id, name, license FROM doctors');
    return rows;
};

// ---------- catalog (generics -> brands -> forms -> strengths) ----------
const strengthLabel = (s) => s.label || '';

// list of generics (id, genericName, inPnf) — kept for API parity, no caller
// currently needs the full nested brand/form/strength tree that meds.json
// used to return.
const getGenerics = async () => {
    const { rows } = await pool.query(
        'SELECT id, generic_name AS "genericName", in_pnf AS "inPnf" FROM generics');
    return rows;
};

// inFormulary = the ihf column = "in Bizbox"; the UI says Bizbox everywhere,
// the API field keeps its name so nothing downstream has to move
const COMBO_COLUMNS = `
    g.generic_name AS generic, b.brand_name AS brand, f.form_name AS form, s.label AS strength,
    s.description AS description,
    s.registration_number AS "registrationNumber", s.volume_ml AS "volumeMl",
    s.ihf AS "inFormulary", g.in_pnf AS "inPnf"`;

const mapCombo = (r) => ({ ...r, volumeMl: toNum(r.volumeMl) });

const findProduct = async ({ generic, brand = '', form = '', strength = '' }) => {
    const { rows } = await pool.query(`
        SELECT ${COMBO_COLUMNS}
        FROM strengths s
        JOIN forms f ON f.id = s.form_id
        JOIN brands b ON b.id = f.brand_id
        JOIN generics g ON g.id = b.generic_id
        WHERE lower(trim(g.generic_name)) = lower(trim($1))
          AND lower(trim(b.brand_name)) = lower(trim($2))
          AND lower(trim(f.form_name)) = lower(trim($3))
          AND lower(trim(s.label)) = lower(trim($4))
        LIMIT 1
    `, [generic, brand, form, strength]);
    return rows[0] ? mapCombo(rows[0]) : null;
};

// the product whose Bizbox description reads exactly like this, under this
// generic — how an import recognises a row it has seen before, and how the
// nurse's pick is resolved when only the description travelled
const findProductByDescription = async ({ generic, description }) => {
    const { rows } = await pool.query(`
        SELECT ${COMBO_COLUMNS}
        FROM strengths s
        JOIN forms f ON f.id = s.form_id
        JOIN brands b ON b.id = f.brand_id
        JOIN generics g ON g.id = b.generic_id
        WHERE lower(trim(g.generic_name)) = lower(trim($1))
          AND lower(trim(s.description)) = lower(trim($2))
        LIMIT 1
    `, [generic, description]);
    return rows[0] ? mapCombo(rows[0]) : null;
};

// distinct form names — SQL fallback for catalogCache.forms()
const getFormNames = async () => {
    const cached = catalogCache.forms();
    if (cached) return cached;
    const { rows } = await pool.query(`
        SELECT min(f.form_name) AS f FROM forms f
        WHERE f.form_name <> '' AND EXISTS (SELECT 1 FROM strengths s WHERE s.form_id = f.id AND s.ihf)
        GROUP BY lower(trim(f.form_name)) ORDER BY lower(min(f.form_name))`);
    return rows.map((r) => r.f);
};

// ---------- catalog search (autocomplete) ----------
// The browser used to download every combination — ~34k rows, 5.2 MB — and
// filter it in JS. Once the PNF became the master list that stopped scaling:
// each keystroke in the Brand box rebuilt and re-sorted 24k distinct brand
// names on the main thread, so typing (and especially holding backspace) piled
// up input events faster than they could drain and the tab locked up. Search
// lives here now; only the rows actually shown go over the wire.

const SUGGEST_COLUMN = {
    generic: 'g.generic_name',
    brand: 'b.brand_name',
    form: 'f.form_name',
    strength: 's.label',
};
// a field is narrowed only by the fields above it in the cascade, matching how
// the picker reads top-down: Generic -> Brand -> Form -> Strength
const SUGGEST_PARENTS = {
    generic: [],
    brand: ['generic'],
    form: ['generic', 'brand'],
    strength: ['generic', 'brand', 'form'],
};
const SUGGEST_LIMIT = 50;
// strpos(lower(col), $1) cannot use an index (it matches mid-string), so every
// search is a scan + GROUP BY of the level it sits on. With an empty q the
// WHERE is a no-op — strpos(x, '') is 1 — and the scan covers the whole
// catalog, which is far too expensive to fire on a focus event.
//
// An empty box is only worth asking about when a parent narrows it: "every form
// this brand comes in" is a handful of rows and genuinely useful. Unparented
// and unfiltered, it just means "read everything", so make the user type.
const SUGGEST_MIN_Q = 2;
const suggestWorthRunning = (field, sel) =>
    norm(sel.q).length >= SUGGEST_MIN_Q || SUGGEST_PARENTS[field].some((p) => norm(sel[p]));

// LEFT JOINs throughout so a generic with no products of its own still lists
// itself; the blank brand/form/strength it contributes is dropped by "<> ''".
const SUGGEST_CHAIN = [
    'generics g',
    'LEFT JOIN brands b ON b.generic_id = g.id',
    'LEFT JOIN forms f ON f.brand_id = b.id',
    'LEFT JOIN strengths s ON s.form_id = f.id',
];
const SUGGEST_LEVEL = { generic: 0, brand: 1, form: 2, strength: 3 };

// closest first: exact, then starts-with, then contains, with compounds
// (Foo + Bar) after plain names. Ordering is on lower(): postgres:16-alpine is
// musl-based, where en_US.utf8 still compares bytewise, so a bare ORDER BY puts
// every ALL-CAPS brand ahead of the Mixed-Case ones and shoves half the real
// matches past the 50-row cut.
const suggestOrder = (expr) => `
    CASE WHEN $1 = '' THEN 0 ELSE
        (CASE WHEN lower(${expr}) = $1 THEN 0
              WHEN left(lower(${expr}), length($1)) = $1 THEN 1
              ELSE 2 END) * 2
        + (CASE WHEN position('+' in ${expr}) > 0 THEN 1 ELSE 0 END)
    END, lower(${expr}), ${expr}`;

// -> [{ value, ihf, pnf, soleGeneric }]
//    ihf: any product under this choice is in the hospital Formulary
//    pnf: ...is in the Philippine National Formulary
//    soleGeneric: the generic, when this choice has exactly one — lets picking
//    a brand fill the generic in for the nurse
const suggestOptions = async (field, sel = {}) => {
    if (field === 'combo') return suggestCombo(sel);
    const col = SUGGEST_COLUMN[field];
    if (!col) return [];

    // Normal path: answered from memory, no pool client taken. See
    // catalog-cache.js for why the search does not belong in a query at all.
    const cached = catalogCache.suggest(field, sel);
    if (cached) return cached;

    // Fallback for a cache that has not loaded yet (boot, or a failed refresh).
    // Only this path is expensive, so only this path needs the guard: without a
    // parent to narrow it, an empty box asks Postgres to read the whole catalog.
    if (!suggestWorthRunning(field, sel)) return [];

    const params = [norm(sel.q)];
    const parentWhere = [];
    for (const parent of SUGGEST_PARENTS[field]) {
        const v = norm(sel[parent]);
        if (!v) continue;
        params.push(v);
        parentWhere.push(`lower(trim(${SUGGEST_COLUMN[parent]})) = $${params.length}`);
    }
    const scoped = (extra) => [...extra, ...parentWhere].join(' AND ');

    // Two stages on purpose. Picking the 50 values first — off the narrow part
    // of the tree, with no aggregation — then enriching only those keeps the
    // expensive bool_or/min/max off all ~27k rows. Roughly halves the worst
    // case (an empty Brand box) versus aggregating the whole join.
    const { rows } = await pool.query(`
        WITH picked AS (
            SELECT ${col} AS value
            FROM ${SUGGEST_CHAIN.slice(0, SUGGEST_LEVEL[field] + 1).join('\n            ')}
            WHERE ${scoped([`${col} <> ''`, `strpos(lower(${col}), $1) > 0`])}
            GROUP BY ${col}
            ORDER BY ${suggestOrder(col)}
            LIMIT ${SUGGEST_LIMIT}
        )
        SELECT p.value,
               COALESCE(bool_or(s.ihf), false) AS ihf,
               COALESCE(bool_or(g.in_pnf), false) AS pnf,
               -- exactly one generic behind this value? min = max is far
               -- cheaper than count(DISTINCT), which sorts every group
               CASE WHEN min(g.generic_name) = max(g.generic_name)
                    THEN min(g.generic_name) END AS "soleGeneric"
        FROM ${SUGGEST_CHAIN.join('\n        ')}
        JOIN picked p ON p.value = ${col}
        WHERE ${scoped(['true'])}
        GROUP BY p.value
        ORDER BY ${suggestOrder('p.value')}
    `, params);
    return rows;
};

// The nurse's Brand/Form/Strength box, SQL fallback for the seconds before the
// cache loads. Same contract as catalogCache.suggestCombo: every typed word
// must appear in the description, narrowed by generic when given.
const suggestCombo = async (sel = {}) => {
    const cached = catalogCache.suggest('combo', sel);
    if (cached) return cached;
    const words = norm(sel.q).split(/\s+/).filter(Boolean);
    const gen = norm(sel.generic);
    if (!gen && words.join('').length < SUGGEST_MIN_Q) return [];
    const params = [];
    const where = ["s.description <> ''"];
    if (gen) { params.push(gen); where.push(`lower(trim(g.generic_name)) = $${params.length}`); }
    for (const w of words) { params.push(w); where.push(`strpos(lower(s.description), $${params.length}) > 0`); }
    const { rows } = await pool.query(`
        SELECT s.description AS value, b.brand_name AS brand, f.form_name AS form, s.label AS strength,
               s.volume_ml AS "volumeMl", bool_or(s.ihf) AS ihf, bool_or(g.in_pnf) AS pnf,
               g.generic_name AS "soleGeneric"
        FROM strengths s
        JOIN forms f ON f.id = s.form_id
        JOIN brands b ON b.id = f.brand_id
        JOIN generics g ON g.id = b.generic_id
        WHERE ${where.join(' AND ')}
        GROUP BY g.generic_name, s.description, b.brand_name, f.form_name, s.label, s.volume_ml
        ORDER BY lower(s.description), s.description
        LIMIT ${SUGGEST_LIMIT}
    `, params);
    return rows.map((r) => ({ ...r, volumeMl: toNum(r.volumeMl) }));
};

// STRICT product-level membership: a medicine is in Bizbox only when this
// exact generic+brand+form+strength combination is a Bizbox product. Anything
// else — custom strength, different brand, unknown drug — is new.
// (inHospitalFormulary / findRegistration lived here — each ran findProduct
// again for one field of the same row. Their only caller, createRx, now calls
// findProduct once and reads both answers off it.)

// mark a product as in Bizbox, creating the node when the pharmacy approves
// (or an import lists) something not in the merged catalog at all.
// description: the Bizbox wording; when absent the parts are stitched in
// Bizbox order (brand strength form) so the column is never empty.
const addToCatalog = async ({ genericName, brandName, formName, strength, description, registrationNumber, volumeMl, seenAt, skipInvalidate }) => {
    const stitched = [brandName, strength, formName].map((x) => String(x || '').trim()).filter(Boolean).join(' ');
    const desc = String(description || '').replace(/\s+/g, ' ').trim() || stitched || null;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        let r = await client.query(
            'SELECT id FROM generics WHERE lower(trim(generic_name)) = lower(trim($1))', [genericName]);
        let genericId = r.rows[0] && r.rows[0].id;
        if (!genericId) {
            r = await client.query('INSERT INTO generics (generic_name) VALUES ($1) RETURNING id', [genericName]);
            genericId = r.rows[0].id;
        }

        r = await client.query(
            'SELECT id FROM brands WHERE generic_id = $1 AND lower(trim(brand_name)) = lower(trim($2))',
            [genericId, brandName || '']);
        let brandId = r.rows[0] && r.rows[0].id;
        if (!brandId) {
            r = await client.query(
                'INSERT INTO brands (generic_id, brand_name) VALUES ($1, $2) RETURNING id',
                [genericId, brandName || '']);
            brandId = r.rows[0].id;
        }

        r = await client.query(
            'SELECT id FROM forms WHERE brand_id = $1 AND lower(trim(form_name)) = lower(trim($2))',
            [brandId, formName || '']);
        let formId = r.rows[0] && r.rows[0].id;
        if (!formId) {
            r = await client.query(
                'INSERT INTO forms (brand_id, form_name) VALUES ($1, $2) RETURNING id',
                [brandId, formName || '']);
            formId = r.rows[0].id;
        }

        r = await client.query(
            'SELECT id FROM strengths WHERE form_id = $1 AND lower(trim(label)) = lower(trim($2))',
            [formId, strength || '']);
        const strengthId = r.rows[0] && r.rows[0].id;
        if (!strengthId) {
            r = await client.query(`
                INSERT INTO strengths (form_id, label, ihf, description, registration_number, volume_ml, bizbox_seen_at)
                VALUES ($1, $2, true, $3, $4, $5, $6) RETURNING id`,
                [formId, strength || '', desc, registrationNumber || null, volumeMl ?? null, seenAt ?? null]);
        } else {
            // an import's real wording replaces a stitched description; a
            // manual add keeps whatever the row already says
            // seenAt marks an import: its wording is Bizbox's own and replaces
            // a stitched description. A manual add only fills a blank one.
            await client.query(`
                UPDATE strengths SET ihf = true,
                    description = CASE
                        WHEN $2::text IS NOT NULL AND ($5::bigint IS NOT NULL OR description IS NULL OR description = '') THEN $2
                        ELSE description END,
                    registration_number = COALESCE(registration_number, $3),
                    volume_ml = COALESCE(volume_ml, $4),
                    bizbox_seen_at = COALESCE($5, bizbox_seen_at)
                WHERE id = $1`,
                [strengthId, desc, registrationNumber || null, volumeMl ?? null, seenAt ?? null]);
        }
        const finalId = strengthId || r.rows[0].id;

        await client.query('COMMIT');
        // the only thing that changes the catalog — refresh this worker's copy
        // and tell the others. After COMMIT on purpose: a rolled-back approval
        // must not make the siblings re-read for nothing. An import adding a
        // thousand rows passes skipInvalidate and refreshes once at the end.
        if (!skipInvalidate) catalogCache.invalidate();
        return finalId;
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
};

// ---------- prescriptions ----------
const addPrescription = async (record) => {
    const id = newId('rx');
    const createdAt = Date.now();
    const { stationId, department, ...payload } = record;
    await pool.query(
        'INSERT INTO prescriptions (id, station_id, department, created_at, payload) VALUES ($1, $2, $3, $4, $5)',
        [id, stationId || null, department || null, createdAt, JSON.stringify(payload)]);
    return { id, stationId, department, createdAt, ...payload };
};

const getPrescriptions = async () => {
    const { rows } = await pool.query('SELECT id, station_id, department, created_at, payload FROM prescriptions');
    return rows.map((r) => ({
        id: r.id, stationId: r.station_id, department: r.department,
        createdAt: toNum(r.created_at), ...r.payload,
    }));
};

// IT-facing listing: newest first, filtered by date, paged. Separate from
// getPrescriptions() above, which loads every row for demand/pharmacy
// aggregation and has no business being paged.
//
// Deliberately NOT selecting the patient fields out of payload. IT deletes
// wrong or test entries; it has no reason to read who they were for, and the
// system log already keeps patient details out for the same reason. Date,
// station, doctor and medicine count are enough to identify a row.
const listPrescriptionsPage = async ({ from = null, to = null, limit = 50, offset = 0 }) => {
    const where = [];
    const params = [];
    if (from != null) { params.push(from); where.push(`p.created_at >= $${params.length}`); }
    if (to != null) { params.push(to); where.push(`p.created_at <= $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { rows: totals } = await pool.query(
        `SELECT count(*)::int AS n FROM prescriptions p ${clause}`, params);

    params.push(limit, offset);
    const { rows } = await pool.query(`
        SELECT p.id, p.department, p.created_at, s.name AS station,
               p.payload -> 'doctor' ->> 'name' AS doctor,
               COALESCE(jsonb_array_length(p.payload -> 'items'), 0) AS meds
        FROM prescriptions p
        LEFT JOIN stations s ON s.id = p.station_id
        ${clause}
        ORDER BY p.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    return {
        total: totals[0].n,
        prescriptions: rows.map((r) => ({
            id: r.id, createdAt: toNum(r.created_at), station: r.station,
            department: r.department, doctor: r.doctor, meds: toNum(r.meds),
        })),
    };
};

// Hard delete. Prescriptions are the source for demand counts and the pharmacy
// dashboard, so removing rows changes those numbers — that is the point when
// clearing test data, but it is not reversible without a backup restore.
const deletePrescriptionsByIds = async (ids) => {
    if (!ids.length) return 0;
    const { rowCount } = await pool.query('DELETE FROM prescriptions WHERE id = ANY($1)', [ids]);
    return rowCount;
};

const deletePrescriptionsByRange = async ({ from = null, to = null }) => {
    const where = [];
    const params = [];
    if (from != null) { params.push(from); where.push(`created_at >= $${params.length}`); }
    if (to != null) { params.push(to); where.push(`created_at <= $${params.length}`); }
    // no clause at all would mean "delete everything"; the model refuses that
    // before it reaches here, but keep the guard local too
    if (!where.length) throw new Error('refusing to delete every prescription');
    const { rowCount } = await pool.query(
        `DELETE FROM prescriptions WHERE ${where.join(' AND ')}`, params);
    return rowCount;
};

// ---------- review status ----------
const getStatus = async (reason, key) => {
    const { rows } = await pool.query(
        `SELECT status, status_date AS "statusDate", actor, authorized_by AS "authorizedBy"
         FROM review_status WHERE reason = $1 AND drug_key = $2`, [reason, key]);
    return rows[0] ? { ...rows[0], statusDate: toNum(rows[0].statusDate) } : null;
};
const setStatus = async (reason, key, rec) => {
    await pool.query(`
        INSERT INTO review_status (reason, drug_key, status, status_date, actor, authorized_by)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (reason, drug_key) DO UPDATE SET
            status = EXCLUDED.status, status_date = EXCLUDED.status_date,
            actor = EXCLUDED.actor, authorized_by = EXCLUDED.authorized_by
    `, [reason, key, rec.status, rec.statusDate || Date.now(), rec.actor || null, rec.authorizedBy || null]);
    return getStatus(reason, key);
};

// ---------- review remarks ----------
// one row per remark, never updated — the history IS the audit trail
const addRemark = async ({ reason, drugKey, remark, note, actor, authorizedBy }) => {
    const id = newId('rmk');
    const at = Date.now();
    await pool.query(`
        INSERT INTO review_remarks (id, reason, drug_key, remark, note, actor, authorized_by, at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [id, reason, drugKey, remark, note || null, actor || null, authorizedBy || null, at]);
    return { id, reason, drugKey, remark, note: note || null, actor: actor || null, authorizedBy: authorizedBy || null, at };
};
const mapRemark = (r) => ({ id: r.id, reason: r.reason, drugKey: r.drug_key, remark: r.remark, note: r.note, actor: r.actor, authorizedBy: r.authorized_by, at: toNum(r.at) });
const getRemarks = async (reason, drugKey) => {
    const { rows } = await pool.query(
        'SELECT * FROM review_remarks WHERE reason = $1 AND drug_key = $2 ORDER BY at DESC', [reason, drugKey]);
    return rows.map(mapRemark);
};
// every remark, newest first — demand.aggregate() groups them per drug in one
// pass rather than one query per row
const getAllRemarks = async () => {
    const { rows } = await pool.query('SELECT * FROM review_remarks ORDER BY at DESC');
    return rows.map(mapRemark);
};

// ---------- catalog: what else exists under this generic (+ brand) ----------
// For the reviewer deciding "same product, different spelling?" before a
// drug is added to Bizbox. Bizbox rows first, then a stable A-Z.
const findSimilarProducts = async ({ generic, brand = '' }) => {
    const { rows } = await pool.query(`
        SELECT ${COMBO_COLUMNS}
        FROM strengths s
        JOIN forms f ON f.id = s.form_id
        JOIN brands b ON b.id = f.brand_id
        JOIN generics g ON g.id = b.generic_id
        WHERE lower(trim(g.generic_name)) = lower(trim($1))
          AND ($2 = '' OR strpos(lower(b.brand_name), lower(trim($2))) > 0 OR b.brand_name = '')
        ORDER BY s.ihf DESC, lower(b.brand_name), lower(f.form_name), lower(s.label)
        LIMIT 40
    `, [generic, brand]);
    return rows.map(mapCombo);
};

// ---------- Bizbox imports (the job row IS the progress bar) ----------
const mapImport = (r) => ({
    id: r.id, file: r.file, uploadedBy: r.uploaded_by, startedAt: toNum(r.started_at), finishedAt: toNum(r.finished_at),
    status: r.status, total: r.total, processed: r.processed, summary: r.summary || {}, rows: r.rows || null,
});
const createImport = async ({ file, uploadedBy, status, rows, summary }) => {
    const id = newId('imp');
    const startedAt = Date.now();
    await pool.query(`
        INSERT INTO catalog_imports (id, file, uploaded_by, started_at, status, total, processed, summary, rows)
        VALUES ($1, $2, $3, $4, $5, 0, 0, $6, $7)
    `, [id, file, uploadedBy || null, startedAt, status, JSON.stringify(summary || {}), JSON.stringify(rows || null)]);
    return id;
};
const getImport = async (id, { withRows = true } = {}) => {
    const cols = withRows ? '*' : 'id, file, uploaded_by, started_at, finished_at, status, total, processed, summary';
    const { rows } = await pool.query(`SELECT ${cols} FROM catalog_imports WHERE id = $1`, [id]);
    return rows[0] ? mapImport(rows[0]) : null;
};
// patch: { status, total, processed, summary, rows, finishedAt } — only the keys given
const updateImport = async (id, patch) => {
    const sets = [], params = [id];
    const put = (col, v) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if (patch.status !== undefined) put('status', patch.status);
    if (patch.total !== undefined) put('total', patch.total);
    if (patch.processed !== undefined) put('processed', patch.processed);
    if (patch.summary !== undefined) put('summary', JSON.stringify(patch.summary));
    if (patch.rows !== undefined) put('rows', JSON.stringify(patch.rows));
    if (patch.finishedAt !== undefined) put('finished_at', patch.finishedAt);
    if (!sets.length) return;
    await pool.query(`UPDATE catalog_imports SET ${sets.join(', ')} WHERE id = $1`, params);
};
const listImports = async (limit = 30) => {
    const { rows } = await pool.query(`
        SELECT id, file, uploaded_by, started_at, finished_at, status, total, processed, summary
        FROM catalog_imports ORDER BY started_at DESC LIMIT $1`, [limit]);
    return rows.map(mapImport);
};

const exclusionKey = (description) => String(description || '').replace(/\s+/g, ' ').trim().toLowerCase();
const getExclusions = async () => {
    const { rows } = await pool.query('SELECT description_key, description, excluded_by, at FROM catalog_import_exclusions ORDER BY lower(description)');
    return rows.map((r) => ({ key: r.description_key, description: r.description, excludedBy: r.excluded_by, at: toNum(r.at) }));
};
const addExclusion = async ({ description, excludedBy }) => {
    await pool.query(`
        INSERT INTO catalog_import_exclusions (description_key, description, excluded_by, at)
        VALUES ($1, $2, $3, $4) ON CONFLICT (description_key) DO NOTHING
    `, [exclusionKey(description), description, excludedBy || null, Date.now()]);
};
const removeExclusion = async (key) => {
    const { rowCount } = await pool.query('DELETE FROM catalog_import_exclusions WHERE description_key = $1', [key]);
    return rowCount;
};

// Bizbox products no import has listed since `since` — the "in the system but
// missing from this file" list. Reported, never acted on.
const productsNotSeenSince = async (since, limit = 2000) => {
    const { rows } = await pool.query(`
        SELECT ${COMBO_COLUMNS}, s.bizbox_seen_at AS "seenAt"
        FROM strengths s
        JOIN forms f ON f.id = s.form_id
        JOIN brands b ON b.id = f.brand_id
        JOIN generics g ON g.id = b.generic_id
        WHERE s.ihf AND (s.bizbox_seen_at IS NULL OR s.bizbox_seen_at < $1)
        ORDER BY lower(g.generic_name), lower(s.description)
        LIMIT $2
    `, [since, limit]);
    return rows.map((r) => ({ ...mapCombo(r), seenAt: toNum(r.seenAt) }));
};

// ---------- audit ----------
const addAudit = async (entry) => {
    const id = newId('aud');
    const at = Date.now();
    await pool.query(`
        INSERT INTO audit_log (id, at, action, drug, reason, status, actor, authorized_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [id, at, entry.action || null, entry.drug || null, entry.reason || null,
        entry.status || null, entry.actor || null, entry.authorizedBy || null]);
};
const getAudit = async () => {
    const { rows } = await pool.query(`
        SELECT id, at, action, drug, reason, status, actor, authorized_by AS "authorizedBy"
        FROM audit_log ORDER BY at DESC
    `);
    return rows.map((r) => ({ ...r, at: toNum(r.at) }));
};

// ---------- system log (IT page) ----------
const addSystemLog = async (entry) => {
    const id = newId('log');
    await pool.query(`
        INSERT INTO system_logs (id, at, type, actor, role, target, ip, details)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [id, Date.now(), entry.type, entry.actor || null, entry.role || null,
        entry.target || null, entry.ip || null,
        entry.details ? JSON.stringify(entry.details) : null]);
};

// filterable + paginated — this table grows forever, never read it whole
const getSystemLogs = async ({ type, q, from, to, limit = 100, offset = 0 } = {}) => {
    const where = [];
    const params = [];
    const add = (make, value) => { params.push(value); where.push(make(`$${params.length}`)); };

    if (type) add((p) => `type = ${p}`, type);
    if (from) add((p) => `at >= ${p}`, Number(from));
    if (to) add((p) => `at <= ${p}`, Number(to));
    if (q) add((p) => `(actor ILIKE ${p} OR target ILIKE ${p} OR details::text ILIKE ${p})`, `%${q}%`);

    const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await pool.query(`SELECT count(*)::int AS n FROM system_logs ${cond}`, params);
    const { rows } = await pool.query(`
        SELECT id, at, type, actor, role, target, ip, details FROM system_logs
        ${cond} ORDER BY at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, Math.min(Number(limit) || 100, 500), Number(offset) || 0]);
    return { total: total.rows[0].n, rows: rows.map((r) => ({ ...r, at: toNum(r.at) })) };
};

const countSystemLogs = async (type, sinceMs) => {
    const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM system_logs WHERE type = $1 AND at >= $2', [type, sinceMs]);
    return rows[0].n;
};

// ---------- backups (rows written by scripts/backup-db.ps1) ----------
const getBackups = async (limit = 50) => {
    const { rows } = await pool.query(`
        SELECT id, at, file, size_bytes AS "sizeBytes", duration_ms AS "durationMs", status
        FROM backups ORDER BY at DESC LIMIT $1`, [limit]);
    return rows.map((r) => ({ ...r, at: toNum(r.at), sizeBytes: toNum(r.sizeBytes), durationMs: toNum(r.durationMs) }));
};

// used by the IT page's pre-restore safety dump; scheduled backups are
// registered by scripts/backup-db.ps1 instead
const addBackup = async ({ at, file, sizeBytes, durationMs, status }) => {
    await pool.query(
        'INSERT INTO backups (at, file, size_bytes, duration_ms, status) VALUES ($1, $2, $3, $4, $5)',
        [at || Date.now(), file, sizeBytes ?? null, durationMs ?? null, status]);
};

const getBackupFiles = async () => {
    const { rows } = await pool.query('SELECT file FROM backups');
    return rows.map((r) => r.file);
};

// exact-match lookup used to validate a download request — only a filename
// this table actually knows about can ever be served
const getBackupByFile = async (file) => {
    const { rows } = await pool.query(
        `SELECT id, at, file, size_bytes AS "sizeBytes", status FROM backups WHERE file = $1`, [file]);
    return rows[0] ? { ...rows[0], at: toNum(rows[0].at), sizeBytes: toNum(rows[0].sizeBytes) } : null;
};

const countRows = async (table) => {
    // table names come from a fixed allowlist in models/it.js, never user input
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
    return rows[0].n;
};

module.exports = {
    norm, drugKey,
    getUserByUsername, getUserById, getAdmins,
    listUsers, insertUser, updateUserPassword, setUserActive,
    addSystemLog, getSystemLogs, countSystemLogs,
    getBackups, getBackupByFile, addBackup, getBackupFiles, countRows,
    getStations, getStation, getDoctors,
    strengthLabel, getGenerics, suggestOptions, findProduct, findProductByDescription, getFormNames, addToCatalog,
    addPrescription, getPrescriptions,
    listPrescriptionsPage, deletePrescriptionsByIds, deletePrescriptionsByRange,
    getStatus, setStatus,
    addRemark, getRemarks, getAllRemarks, findSimilarProducts,
    createImport, getImport, updateImport, listImports,
    exclusionKey, getExclusions, addExclusion, removeExclusion, productsNotSeenSince,
    addAudit, getAudit,
};
