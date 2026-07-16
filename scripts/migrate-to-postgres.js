// One-time migration: read the old JSON stores (data.json + src/_db/medicines.json)
// and load them into Postgres. Safe to re-run — truncates the target tables first.
//
// Run manually after the Postgres container is up and db/schema.sql has been
// applied:  node scripts/migrate-to-postgres.js

const fs = require('fs');
const path = require('path');
const { pool } = require('../src/_db/store');

const ROOT = path.join(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data.json');
const MEDICINES_FILE = path.join(ROOT, 'src', '_db', 'medicines.json');

const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);

async function main() {
    const data = readJson(DATA_FILE);
    const medicines = readJson(MEDICINES_FILE) || [];
    if (!data) console.warn(`${DATA_FILE} not found — skipping users/stations/doctors/prescriptions/reviewStatus/audit.`);

    const client = await pool.connect();
    const counts = {};
    try {
        await client.query('BEGIN');

        await client.query(`
            TRUNCATE strengths, forms, brands, generics,
                     prescriptions, review_status, audit_log,
                     users, stations, doctors
            RESTART IDENTITY CASCADE
        `);

        // ---- medicines catalog ----
        for (const g of medicines) {
            const gr = await client.query(
                'INSERT INTO generics (id, generic_name, in_pnf) OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3) RETURNING id',
                [g.id, g.genericName, !!g.inPnf]);
            for (const b of g.brands || []) {
                const br = await client.query(
                    'INSERT INTO brands (id, generic_id, brand_name) OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3) RETURNING id',
                    [b.id, gr.rows[0].id, b.brandName || '']);
                for (const f of b.forms || []) {
                    const fr = await client.query(
                        'INSERT INTO forms (id, brand_id, form_name) OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3) RETURNING id',
                        [f.id, br.rows[0].id, f.formName || '']);
                    for (const s of f.strengths || []) {
                        await client.query(`
                            INSERT INTO strengths
                                (id, form_id, label, registration_number, classification, ihf, volume_ml, reg_approx)
                            OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                        `, [s.id, fr.rows[0].id, s.label || '', s.registrationNumber || null,
                            s.classification || null, !!s.ihf, s.volumeMl != null ? s.volumeMl : null, !!s.regApprox]);
                    }
                }
            }
        }
        // bump the sequences past the highest imported id so future SERIAL inserts
        // (addToCatalog) don't collide with migrated rows
        for (const table of ['generics', 'brands', 'forms', 'strengths']) {
            await client.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1))`);
        }

        if (data) {
            // ---- users / stations / doctors ----
            for (const u of data.users || []) {
                await client.query('INSERT INTO users (id, name, username, password_hash, role) VALUES ($1, $2, $3, $4, $5)',
                    [u.id, u.name, u.username, u.password, u.role]);
            }
            for (const s of data.stations || []) {
                await client.query('INSERT INTO stations (id, name, department) VALUES ($1, $2, $3)',
                    [s.id, s.name, s.department]);
            }
            for (const d of data.doctors || []) {
                await client.query('INSERT INTO doctors (id, name, license) VALUES ($1, $2, $3)',
                    [d.id, d.name, d.license || null]);
            }

            // ---- prescriptions ----
            for (const rx of data.prescriptions || []) {
                const { id, stationId, department, createdAt, ...payload } = rx;
                await client.query(
                    'INSERT INTO prescriptions (id, station_id, department, created_at, payload) VALUES ($1, $2, $3, $4, $5)',
                    [id, stationId || null, department || null, createdAt, JSON.stringify(payload)]);
            }

            // ---- review status ----
            for (const [k, rec] of Object.entries(data.reviewStatus || {})) {
                const idx = k.indexOf('::');
                if (idx < 0) continue;
                const reason = k.slice(0, idx);
                const drugKey = k.slice(idx + 2);
                await client.query(`
                    INSERT INTO review_status (reason, drug_key, status, status_date, actor, authorized_by)
                    VALUES ($1, $2, $3, $4, $5, $6)
                `, [reason, drugKey, rec.status, rec.statusDate || rec.at || Date.now(), rec.actor || null, rec.authorizedBy || null]);
            }

            // ---- audit ----
            for (const a of data.audit || []) {
                await client.query(`
                    INSERT INTO audit_log (id, at, action, drug, reason, status, actor, authorized_by)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                `, [a.id, a.at, a.action || null, a.drug || null, a.reason || null, a.status || null,
                    a.actor || null, a.authorizedBy || null]);
            }
        }

        await client.query('COMMIT');

        for (const table of ['generics', 'brands', 'forms', 'strengths', 'users', 'stations', 'doctors',
            'prescriptions', 'review_status', 'audit_log']) {
            const { rows } = await client.query(`SELECT COUNT(*) FROM ${table}`);
            counts[table] = rows[0].count;
        }
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }

    console.log('Migration complete. Row counts:');
    for (const [table, count] of Object.entries(counts)) console.log(`  ${table}: ${count}`);
    await pool.end();
}

main().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
});
