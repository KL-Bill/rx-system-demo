const bcrypt = require('bcryptjs');
const db = require('../_db/db_functions');

const authenticate = async (username, password) => {
    const user = db.getUserByUsername(username);
    if (!user) return null;
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return null;
    return { id: user.id, name: user.name, role: user.role };
};

// returns the authorizing admin if the password matches ANY superadmin/subadmin
const verifyAuthorizer = async (password) => {
    if (!password) return null;
    for (const admin of db.getAdmins()) {
        if (await bcrypt.compare(password, admin.password)) {
            return { id: admin.id, name: admin.name, role: admin.role };
        }
    }
    return null;
};

module.exports = { authenticate, verifyAuthorizer };
