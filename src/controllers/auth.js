const { authenticate } = require('../models/auth');
const { signAccess, verifyToken, getToken } = require('../middlewares/auth');

const login = async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Missing username or password' });
    }
    try {
        const user = await authenticate(username, password);
        if (!user) return res.status(401).json({ success: false, message: 'Invalid credentials' });

        const token = signAccess(user);
        res.cookie('token', token, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
        return res.json({ success: true, user });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

const logout = (req, res) => {
    res.clearCookie('token');
    res.json({ success: true });
};

const me = (req, res) => {
    const u = verifyToken(getToken(req));
    if (!u) return res.status(401).json({ success: false });
    res.json({ success: true, user: { id: u.id, name: u.name, role: u.role } });
};

module.exports = { login, logout, me };
