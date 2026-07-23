// One-time migration for a database created before the IT page existed.
// Fresh installs get all of this from db/schema.sql — only run this against
// a DB that is already live. Safe to re-run (IF NOT EXISTS everywhere).
//
//   node scripts/migrate-add-it.js
//
// Does three things:
//   1. users.active column (deactivate-instead-of-delete for the IT page)
//   2. system_logs + backups tables
//   3. collapses the old role names onto the spec's:
//        superadmin -> admin   (pharmacy head)
//        subadmin   -> staff   (spec has exactly two pharmacy levels; staff
//                               changes require an admin password)

const { pool } = require('../src/_db/store');

async function main() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(`
            ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS system_logs (
              id TEXT PRIMARY KEY,
              at BIGINT NOT NULL,
              type TEXT NOT NULL,
              actor TEXT,
              role TEXT,
              target TEXT,
              ip TEXT,
              details JSONB
            )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_system_logs_at ON system_logs (at DESC)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_system_logs_type ON system_logs (type)');

        await client.query(`
            CREATE TABLE IF NOT EXISTS backups (
              id SERIAL PRIMARY KEY,
              at BIGINT NOT NULL,
              file TEXT NOT NULL,
              size_bytes BIGINT,
              duration_ms BIGINT,
              status TEXT NOT NULL
            )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_backups_at ON backups (at DESC)');

        const up = await client.query(`UPDATE users SET role = 'admin' WHERE role = 'superadmin'`);
        const down = await client.query(`UPDATE users SET role = 'staff' WHERE role = 'subadmin'`);

        await client.query('COMMIT');
        console.log(`Migration done. Roles renamed: ${up.rowCount} superadmin->admin, ${down.rowCount} subadmin->staff.`);
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((err) => {
    console.error('migrate-add-it failed:', err);
    process.exit(1);
});
