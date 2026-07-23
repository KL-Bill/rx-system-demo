const db = require('../_db/db_functions');

// event types written so far:
//   login, login_failed, logout               (controllers/auth.js)
//   rx_created                                (controllers/rx.js — no patient data)
//   user_created, password_reset,
//   user_deactivated, user_reactivated        (models/it.js)
//   backup_ok, backup_failed                  (backups table, not here — see scripts/backup-db.ps1)

// fire-and-forget: a broken system log must never break the request it rides on
const logEvent = (type, req, fields = {}) => {
    const entry = {
        type,
        ip: req ? (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null) : null,
        actor: req?.user?.name,
        role: req?.user?.role,
        ...fields,
    };
    db.addSystemLog(entry).catch((err) => console.error('system log write failed:', err.message));
};

module.exports = { logEvent };
