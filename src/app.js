const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const { authenticateApi, requireRole } = require('./middlewares/auth.js');
const pharmacyOnly = [authenticateApi, requireRole('admin', 'staff')];
const itOnly = [authenticateApi, requireRole('it')];

// ===== API routes =====
app.use('/api/auth',      require('./routers/auth.js'));        // public (login)
app.use('/api/rx',        require('./routers/rx.js'));          // public (nurses, no login)
app.use('/api/pharmacy',  pharmacyOnly, require('./routers/pharmacy.js'));
app.use('/api/report',    pharmacyOnly, require('./routers/report.js'));
app.use('/api/it',        itOnly,       require('./routers/it.js'));

// ===== static frontend =====
app.use(express.static(path.join(__dirname, 'public')));

// page routes (everything else falls back to the SPA-ish pages)
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/reports', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reports.html')));
app.get('/logs', (req, res) => res.sendFile(path.join(__dirname, 'public', 'logs.html')));
app.get('/it', (req, res) => res.sendFile(path.join(__dirname, 'public', 'it.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

module.exports = app;
