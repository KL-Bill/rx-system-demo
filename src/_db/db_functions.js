const { pool, newId } = require('./store');

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

const COMBO_COLUMNS = `
    g.generic_name AS generic, b.brand_name AS brand, f.form_name AS form, s.label AS strength,
    s.registration_number AS "registrationNumber", s.volume_ml AS "volumeMl",
    s.ihf AS "inFormulary", g.in_pnf AS "inPnf"`;

const mapCombo = (r) => ({ ...r, volumeMl: toNum(r.volumeMl) });

const getCombos = async () => {
    const { rows } = await pool.query(`
        SELECT ${COMBO_COLUMNS}
        FROM strengths s
        JOIN forms f ON f.id = s.form_id
        JOIN brands b ON b.id = f.brand_id
        JOIN generics g ON g.id = b.generic_id

        UNION ALL

        SELECT g.generic_name, '', '', '', NULL, NULL, false, g.in_pnf
        FROM generics g
        WHERE NOT EXISTS (
            SELECT 1 FROM brands b JOIN forms f ON f.brand_id = b.id JOIN strengths s ON s.form_id = f.id
            WHERE b.generic_id = g.id
        )
    `);
    return rows.map(mapCombo);
};

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

// STRICT product-level membership: a medicine is in the hospital Formulary only
// when this exact generic+brand+form+strength combination is a hospital product.
// Anything else — custom strength, different brand, unknown drug — is new.
const inHospitalFormulary = async (product) => {
    const c = await findProduct(product);
    return !!(c && c.inFormulary);
};

const findRegistration = async (product) => {
    const c = await findProduct(product);
    return (c && c.registrationNumber) || null;
};

// mark a product as part of the hospital Formulary, creating the node when the
// pharmacy approves something not in the merged catalog at all
const addToCatalog = async ({ genericName, brandName, formName, strength }) => {
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
            await client.query('INSERT INTO strengths (form_id, label, ihf) VALUES ($1, $2, true)', [formId, strength || '']);
        } else {
            await client.query('UPDATE strengths SET ihf = true WHERE id = $1', [strengthId]);
        }

        await client.query('COMMIT');
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
    strengthLabel, getGenerics, getCombos, inHospitalFormulary, findRegistration, addToCatalog,
    addPrescription, getPrescriptions,
    getStatus, setStatus,
    addAudit, getAudit,
};
