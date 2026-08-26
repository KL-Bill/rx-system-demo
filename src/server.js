const cluster = require('cluster');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
// Fixed worker count, not auto-scaling — see WEB_CONCURRENCY in .env.example
// for the reasoning (workers <= cores - 1, stay conservative on a shared box).
const WORKERS = Number(process.env.WEB_CONCURRENCY) || 1;

if (cluster.isPrimary && WORKERS > 1) {
    console.log(`Primary ${process.pid} starting ${WORKERS} worker(s) on port ${PORT}`);
    for (let i = 0; i < WORKERS; i++) cluster.fork();

    cluster.on('exit', (worker, code, signal) => {
        console.error(`Worker ${worker.process.pid} exited (${signal || code}) — restarting`);
        cluster.fork();
    });

    // Each worker holds its own copy of the medicine catalog for autocomplete
    // (src/_db/catalog-cache.js). Only the pharmacy approving a product changes
    // it, and only one worker handles that request — so the primary relays the
    // news to the rest. Sent to every worker including the sender, which has
    // already refreshed; a second reload is cheap and keeps this dumb.
    cluster.on('message', (_worker, msg) => {
        if (!msg || msg.type !== 'catalog:reload') return;
        for (const w of Object.values(cluster.workers)) w.send(msg);
    });
} else {
    const http = require('http');
    const app = require('./app');
    const catalogCache = require('./_db/catalog-cache');

    // Warm the catalog at boot. Deliberately not awaited: the server should
    // accept traffic immediately, and suggestOptions() falls back to querying
    // Postgres for the second or two before the first load lands.
    catalogCache.start();

    const server = http.createServer(app);
    server.listen(PORT, () => {
        console.log(`Worker ${process.pid} listening on port ${PORT}`);
    });
}
