const crypto = require('crypto');
const { Pool } = require('pg');
require('dotenv').config();

// Sized modestly on purpose — this shares the server with Postgres itself and
// possibly other apps; raise only if concurrent load actually needs it.
//
// Nothing here may wait forever. pg-pool only arms a timer when
// connectionTimeoutMillis is set, so without it a saturated pool parks every
// later query indefinitely: the request never answers, the browser's six
// sockets fill with it, and the app looks frozen rather than broken. Failing
// fast is strictly better — every caller already handles an error, and the
// nurse gets "could not reach the server" instead of a dead page.
//
// statement_timeout is a backstop against a runaway query, not a bound on
// normal work: the heaviest read in the app (getPrescriptions, a full table
// scan for reports) is well inside 30s.
const LIMITS = {
    max: Number(process.env.PGPOOL_MAX) || 10,
    connectionTimeoutMillis: Number(process.env.PGCONNECT_TIMEOUT_MS) || 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: Number(process.env.PGSTATEMENT_TIMEOUT_MS) || 30000,
};

const pool = new Pool(
    process.env.DATABASE_URL
        ? { connectionString: process.env.DATABASE_URL, ...LIMITS }
        : {
            host: process.env.PGHOST || 'localhost',
            port: Number(process.env.PGPORT) || 5432,
            user: process.env.PGUSER || 'postgres',
            password: process.env.PGPASSWORD || '',
            database: process.env.PGDATABASE || 'rxsystem',
            ...LIMITS,
        }
);

// An idle client killed by the server (restart, network blip) emits on the pool
// itself; unhandled, that is an uncaught exception and the worker dies.
pool.on('error', (err) => console.error('idle postgres client error:', err.message));

const newId = (prefix) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

module.exports = { pool, newId };
