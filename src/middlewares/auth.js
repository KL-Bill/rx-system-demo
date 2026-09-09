const jwt = require('jsonwebtoken');
require('dotenv').config();

const SECRET = process.env.SECRET_KEY || 'demo-secret-key';

// 24h session — pharmacy logs in once per day
const signAccess = (user) => {
    const payload = { id: user.id, name: user.name, role: user.role, master: !!user.master };
    return jwt.sign(payload, SECRET, { expiresIn: '24h' });
};

const verifyToken = (token) => {
    try {
        return jwt.verify(token, SECRET);
    } catch {
        return null;
    }
};

const getToken = (req) => {
    const h = req.headers.authorization;
    return h && h.startsWith('Bearer ') ? h.slice(7) : req.cookies?.token;
};

// require a valid session
const authenticateApi = (req, res, next) => {
    const user = verifyToken(getToken(req));
    if (!user) return res.status(401).json({ success: false, message: 'Unauthenticated' });
    req.user = user;
    next();
};

// require one of the given roles (use after authenticateApi) — keeps IT out
// of pharmacy data and pharmacy out of the IT console
const requireRole = (...roles) => (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
        return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    next();
};

// master IT only: accounts are managed by IT made at the server console,
// never by an IT account made on the web page (use after authenticateApi)
const requireMaster = (req, res, next) => {
    if (!req.user || req.user.role !== 'it' || !req.user.master) {
        return res.status(403).json({ success: false, message: 'Only a master IT account (created at the server console) can manage accounts' });
    }
    next();
};

module.exports = {
    signAccess,
    verifyToken,
    getToken,
    authenticateApi,
    requireRole,
    requireMaster,
};
