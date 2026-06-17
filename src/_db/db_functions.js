const { db, save, newId } = require('./store');

// ---------- users ----------
const getUserByUsername = (username) =>
    db().users.find((u) => u.username === username) || null;

const getUserById = (id) => db().users.find((u) => u.id === id) || null;

const getAdmins = () =>
    db().users.filter((u) => u.role === 'superadmin' || u.role === 'subadmin');

// ---------- stations ----------
const getStations = () => db().stations;
const getStation = (id) => db().stations.find((s) => s.id === id) || null;

// ---------- meds ----------
const getAllMeds = () => db().meds;
const getMed = (id) => db().meds.find((m) => m.id === id) || null;

const findMedByName = (name) =>
    db().meds.find((m) => m.name.trim().toLowerCase() === name.trim().toLowerCase()) || null;

const searchMeds = (q) => {
    const meds = db().meds;
    if (!q) return meds;
    const needle = q.trim().toLowerCase();
    return meds.filter((m) => m.name.toLowerCase().includes(needle));
};

// create a new med that a nurse prescribed but isn't in the database yet
const addPendingMed = ({ name, strength, form }) => {
    const med = {
        id: newId('med'),
        name: name.trim(),
        strength: strength || '',
        form: form || '',
        unit: form || '',
        stock: null,
        inDatabase: false,
        status: 'pending',
        createdAt: Date.now(),
    };
    db().meds.push(med);
    save();
    return med;
};

const updateMed = (id, edits) => {
    const med = getMed(id);
    if (!med) return null;
    Object.assign(med, edits);
    save();
    return med;
};

// ---------- rx ----------
const addRxRecord = (record) => {
    const rx = { id: newId('rx'), createdAt: Date.now(), ...record };
    db().rxRecords.push(rx);
    save();
    return rx;
};

const addRxItem = (item) => {
    const it = { id: newId('item'), createdAt: Date.now(), ...item };
    db().rxItems.push(it);
    save();
    return it;
};

const getRxItems = ({ stationId } = {}) => {
    const items = db().rxItems;
    return stationId ? items.filter((i) => i.stationId === stationId) : items;
};

const getRxRecords = ({ stationId } = {}) => {
    const records = db().rxRecords;
    return stationId ? records.filter((r) => r.stationId === stationId) : records;
};

// ---------- audit ----------
const addAudit = (entry) => {
    db().audit.unshift({ id: newId('aud'), at: Date.now(), ...entry });
    save();
};

const getAudit = () => db().audit;

module.exports = {
    getUserByUsername,
    getUserById,
    getAdmins,
    getStations,
    getStation,
    getAllMeds,
    getMed,
    findMedByName,
    searchMeds,
    addPendingMed,
    updateMed,
    addRxRecord,
    addRxItem,
    getRxItems,
    getRxRecords,
    addAudit,
    getAudit,
};
