// One-time migration for a database created before medicine search moved to
// the server. Fresh installs get these from db/schema.sql — only run this
// against a DB that is already live. Safe to re-run (IF NOT EXISTS).
//
//   node scripts/migrate-add-search-indexes.js
//
// The picker used to download the whole catalog and search it in the browser.
// It now calls /api/rx/suggest, which matches on lower(trim(...)) at every
// level of generic -> brand -> form -> strength. The pre-existing
// idx_generics_name is on lower(generic_name) with no trim(), so Postgres
// cannot use it for those lookups — these expression indexes match what the
// queries actually ask for.

const { pool } = require('../src/_db/store');

const INDEXES = [
    ['idx_generics_name_trim', 'generics (lower(trim(generic_name)))'],
    ['idx_brands_name_trim', 'brands (lower(trim(brand_name)))'],
    ['idx_forms_name_trim', 'forms (lower(trim(form_name)))'],
    ['idx_strengths_label_trim', 'strengths (lower(trim(label)))'],
];

async function main() {
    const client = await pool.connect();
    try {
        for (const [name, target] of INDEXES) {
            await client.query(`CREATE INDEX IF NOT EXISTS ${name} ON ${target}`);
            console.log(`  ok  ${name}`);
        }
        // the planner needs current stats to pick the new indexes
        await client.query('ANALYZE generics, brands, forms, strengths');
        console.log('Migration done.');
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((err) => {
    console.error('migrate-add-search-indexes failed:', err);
    process.exit(1);
});
