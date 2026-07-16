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
} else {
    const http = require('http');
    const app = require('./app');

    const server = http.createServer(app);
    server.listen(PORT, () => {
        console.log(`Worker ${process.pid} listening on port ${PORT}`);
    });
}
