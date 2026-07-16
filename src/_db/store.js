const crypto = require('crypto');
const { Pool } = require('pg');
require('dotenv').config();

// Sized modestly on purpose — this shares the server with Postgres itself and
// possibly other apps; raise only if concurrent load actually needs it.
const pool = new Pool(
    process.env.DATABASE_URL
        ? { connectionString: process.env.DATABASE_URL }
        : {
            host: process.env.PGHOST || 'localhost',
            port: Number(process.env.PGPORT) || 5432,
            user: process.env.PGUSER || 'postgres',
            password: process.env.PGPASSWORD || '',
            database: process.env.PGDATABASE || 'rxsystem',
            max: 10,
        }
);

const newId = (prefix) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

module.exports = { pool, newId };
