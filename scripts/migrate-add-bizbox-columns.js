// One-time, ADDITIVE migration for a database that predates the Bizbox work.
// Fresh installs get all of this from db/schema.sql — only run this against a
// DB that is already live. Safe to re-run (IF NOT EXISTS everywhere; the
// backfill only touches rows whose description is still NULL).
//
//   node scripts/migrate-add-bizbox-columns.js
//
// Nothing existing is dropped, renamed or retyped. It only:
//   1. adds strengths.description — the Bizbox wording of a product ("BIOGESIC
//      500MG TABLET"), filled for existing rows by stitching brand + strength
//      + form in that order; a Bizbox import later overwrites it with the real
//      text — and strengths.bizbox_seen_at, the last import that listed it
//   2. adds review_remarks — the pharmacy's remark history per reviewed drug
//   3. adds catalog_imports + catalog_import_exclusions — the Bizbox import
//      job record (progress, review decisions) and the "skip this next time"
//      list (NITROGEN USE, MEDEXPRESS PAYABLE...)

const { pool } = require('../src/_db/store');

async function main() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query('ALTER TABLE strengths ADD COLUMN IF NOT EXISTS description TEXT');
        await client.query('ALTER TABLE strengths ADD COLUMN IF NOT EXISTS bizbox_seen_at BIGINT');
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_strengths_description_trim
                ON strengths (lower(trim(description)))
        `);

        // brand, strength, form — Bizbox order. NULLIF drops the blanks so an
        // unbranded product stitches to "500MG TABLET", not " 500MG TABLET".
        const filled = await client.query(`
            UPDATE strengths s
               SET description = regexp_replace(
                       concat_ws(' ', NULLIF(trim(b.brand_name), ''), NULLIF(trim(s.label), ''), NULLIF(trim(f.form_name), '')),
                       '\\s+', ' ', 'g')
              FROM forms f
              JOIN brands b ON b.id = f.brand_id
             WHERE f.id = s.form_id
               AND s.description IS NULL
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS review_remarks (
              id TEXT PRIMARY KEY,
              reason TEXT NOT NULL,
              drug_key TEXT NOT NULL,
              remark TEXT NOT NULL,
              note TEXT,
              actor TEXT,
              authorized_by TEXT,
              at BIGINT NOT NULL
            )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_review_remarks_drug ON review_remarks (reason, drug_key, at DESC)');

        await client.query(`
            CREATE TABLE IF NOT EXISTS catalog_imports (
              id TEXT PRIMARY KEY,
              file TEXT NOT NULL,
              uploaded_by TEXT,
              started_at BIGINT NOT NULL,
              finished_at BIGINT,
              status TEXT NOT NULL,
              total INTEGER NOT NULL DEFAULT 0,
              processed INTEGER NOT NULL DEFAULT 0,
              summary JSONB,
              rows JSONB
            )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_catalog_imports_started ON catalog_imports (started_at DESC)');

        // 4. two tiers of IT: accounts made at the server console are "master"
        //    (they manage accounts); IT accounts made on the web page are not.
        //    Every IT account that exists before this migration was made at
        //    the console, so it is master.
        await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_master BOOLEAN NOT NULL DEFAULT false');
        await client.query(`UPDATE users SET is_master = true WHERE role = 'it'`);

        // 5. soft delete: nothing a person removes on a page is gone for good.
        //    prescriptions and doctors get deleted_at (+ who), a merged
        //    duplicate in the RX Formulary keeps its row with merged_into set.
        //    Every reader filters deleted_at IS NULL; IT can restore.
        await client.query('ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS deleted_at BIGINT');
        await client.query('ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS deleted_by TEXT');
        await client.query('CREATE INDEX IF NOT EXISTS idx_prescriptions_live ON prescriptions (created_at) WHERE deleted_at IS NULL');
        await client.query('ALTER TABLE doctors ADD COLUMN IF NOT EXISTS deleted_at BIGINT');
        await client.query('ALTER TABLE strengths ADD COLUMN IF NOT EXISTS deleted_at BIGINT');
        await client.query('ALTER TABLE strengths ADD COLUMN IF NOT EXISTS merged_into INTEGER');

        await client.query(`
            CREATE TABLE IF NOT EXISTS catalog_import_exclusions (
              description_key TEXT PRIMARY KEY,
              description TEXT NOT NULL,
              excluded_by TEXT,
              at BIGINT NOT NULL
            )
        `);

        await client.query('COMMIT');
        console.log(`Migration done. Descriptions stitched for ${filled.rowCount} existing product(s).`);
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((err) => {
    console.error('migrate-add-bizbox-columns failed:', err);
    process.exit(1);
});
