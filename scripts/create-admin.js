// Create a pharmacy login without touching the database directly.
//
// Usage (the "--" is required so npm forwards the args to this script
// instead of swallowing them):
//   npm run create-admin -- <username> <password> [role]
//
// role defaults to "subadmin"; pass "superadmin" explicitly for a superadmin
// login, or "staff" for a plain staff account. Refuses to overwrite an
// existing username.

const bcrypt = require('bcryptjs');
const { pool, newId } = require('../src/_db/store');

const VALID_ROLES = ['superadmin', 'subadmin', 'staff'];

function usage() {
    console.log('Usage: npm run create-admin -- <username> <password> [role]');
    console.log(`  role: one of ${VALID_ROLES.join(', ')} (default: subadmin)`);
}

async function main() {
    const [username, password, role = 'subadmin'] = process.argv.slice(2);

    if (!username || !password || username === '--help' || username === '-h') {
        usage();
        process.exit(username ? 1 : 0);
    }
    if (!VALID_ROLES.includes(role)) {
        console.error(`Invalid role "${role}". Must be one of: ${VALID_ROLES.join(', ')}`);
        process.exit(1);
    }

    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length) {
        console.error(`A user named "${username}" already exists — refusing to overwrite it.`);
        process.exit(1);
    }

    const id = newId('u');
    const passwordHash = bcrypt.hashSync(password, 10);
    await pool.query(
        'INSERT INTO users (id, name, username, password_hash, role) VALUES ($1, $2, $3, $4, $5)',
        [id, username, username, passwordHash, role]);

    console.log(`Created ${role} user "${username}" (id: ${id}).`);
    await pool.end();
}

main().catch((err) => {
    console.error('create-admin failed:', err);
    process.exit(1);
});
