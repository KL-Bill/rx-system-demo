const jwt = require('jsonwebtoken');
require('dotenv').config();

const SECRET = process.env.SECRET_KEY || 'demo-secret-key';

// 24h session — pharmacy logs in once per day
const signAccess = (user) => {
    const payload = { id: user.id, name: user.name, role: user.role };
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

// require a valid pharmacy session
const authenticateApi = (req, res, next) => {
    const user = verifyToken(getToken(req));
    if (!user) return res.status(401).json({ success: false, message: 'Unauthenticated' });
    req.user = user;
    next();
};

module.exports = {
    signAccess,
    verifyToken,
    getToken,
    authenticateApi,
};
