const { pool, newId } = require('./store');

const norm = (x) => String(x || '').trim().toLowerCase();
// stable identity for a prescribed product, used to group demand and key review status
const drugKey = (m) => [m.genericName, m.brandName, m.formName, m.strength].map(norm).join('|');

const toNum = (x) => (x == null ? null : Number(x));

// ---------- users ----------
const getUserByUsername = async (username) => {
    const { rows } = await pool.query(
        'SELECT id, name, username, password_hash AS password, role FROM users WHERE username = $1',
        [username]);
    return rows[0] || null;
};
const getUserById = async (id) => {
    const { rows } = await pool.query(
        'SELECT id, name, username, password_hash AS password, role FROM users WHERE id = $1', [id]);
    return rows[0] || null;
};
const getAdmins = async () => {
    const { rows } = await pool.query(
        `SELECT id, name, username, password_hash AS password, role FROM users
         WHERE role = 'superadmin' OR role = 'subadmin'`);
    return rows;
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

module.exports = {
    norm, drugKey,
    getUserByUsername, getUserById, getAdmins,
    getStations, getStation, getDoctors,
    strengthLabel, getGenerics, getCombos, inHospitalFormulary, findRegistration, addToCatalog,
    addPrescription, getPrescriptions,
    getStatus, setStatus,
    addAudit, getAudit,
};
