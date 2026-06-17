const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const DATA_FILE = path.join(__dirname, '..', '..', 'data.json');

let data = null;

const newId = (prefix) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

// ---------- persistence ----------
const load = () => {
    if (data) return data;
    if (fs.existsSync(DATA_FILE)) {
        data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } else {
        data = seed();
        save();
        console.log('Seeded data.json (demo data). Pharmacy logins:');
        console.log('  superadmin / super123   (superadmin)');
        console.log('  subadmin   / sub123     (subadmin)');
        console.log('  staff      / staff123   (staff)');
    }
    return data;
};

const save = () => {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
};

const db = () => load();

// ---------- seed ----------
function seed() {
    const now = Date.now();
    const day = 86400000;

    const stations = [
        { id: 'st-er',   name: 'Emergency Room',  department: 'Emergency' },
        { id: 'st-peds', name: 'Pediatrics Ward', department: 'Pediatrics' },
        { id: 'st-ob',   name: 'OB-GYN Ward',     department: 'OB-GYN' },
        { id: 'st-surg', name: 'Surgery Ward',    department: 'Surgery' },
    ];

    const users = [
        { id: 'u-super', name: 'Dr. Reyes',  username: 'superadmin', password: bcrypt.hashSync('super123', 10), role: 'superadmin' },
        { id: 'u-sub',   name: 'Ms. Santos', username: 'subadmin',   password: bcrypt.hashSync('sub123', 10),   role: 'subadmin' },
        { id: 'u-staff', name: 'Mr. Cruz',   username: 'staff',      password: bcrypt.hashSync('staff123', 10), role: 'staff' },
    ];

    const meds = [
        // ----- in the database (known meds with stock) -----
        med('Paracetamol', '500mg', 'Tablet', 40, true),
        med('Amoxicillin', '500mg', 'Capsule', 8, true),
        med('Ibuprofen',   '400mg', 'Tablet', 25, true),
        med('Cefalexin',   '500mg', 'Capsule', 3, true),
        med('Omeprazole',  '20mg',  'Capsule', 60, true),
        med('Salbutamol',  '2.5mg', 'Nebule', 12, true),
        med('Metformin',   '500mg', 'Tablet', 30, true),
        med('Losartan',    '50mg',  'Tablet', 18, true),
        // ----- NOT in the database (added by nurses, pending review) -----
        med('Co-amoxiclav', '625mg', 'Tablet', null, false),
        med('Azithromycin', '500mg', 'Tablet', null, false),
        med('Tranexamic Acid', '500mg', 'Capsule', null, false),
    ];

    function med(name, strength, form, stock, inDatabase) {
        return {
            id: newId('med'),
            name,
            strength,
            form,
            unit: form,
            stock,
            inDatabase,
            status: inDatabase ? 'active' : 'pending',
            createdAt: now,
        };
    }

    const byName = (n) => meds.find((m) => m.name === n);

    const rxRecords = [];
    const rxItems = [];

    // demand history: [medName, stationId, quantity, daysAgo]
    // inStock is derived from whether the med is in the database
    const events = [
        ['Co-amoxiclav', 'st-er', 10, 1], ['Co-amoxiclav', 'st-surg', 14, 2],
        ['Co-amoxiclav', 'st-er', 8, 3], ['Co-amoxiclav', 'st-peds', 6, 4],
        ['Co-amoxiclav', 'st-surg', 12, 5],
        ['Azithromycin', 'st-peds', 9, 1], ['Azithromycin', 'st-er', 7, 2],
        ['Azithromycin', 'st-peds', 5, 3],
        ['Tranexamic Acid', 'st-ob', 20, 1], ['Tranexamic Acid', 'st-ob', 15, 2],
        ['Tranexamic Acid', 'st-surg', 6, 4],
        ['Cefalexin', 'st-er', 12, 1], ['Cefalexin', 'st-surg', 10, 2],
        ['Cefalexin', 'st-peds', 8, 3],
        ['Amoxicillin', 'st-peds', 10, 1], ['Amoxicillin', 'st-er', 6, 2],
        ['Paracetamol', 'st-er', 8, 1], ['Paracetamol', 'st-peds', 12, 2],
        ['Salbutamol', 'st-peds', 6, 1], ['Salbutamol', 'st-er', 4, 3],
        ['Ibuprofen', 'st-surg', 5, 2], ['Losartan', 'st-er', 4, 3],
    ];

    let r = 0;
    for (const [name, stationId, qty, daysAgo] of events) {
        const m = byName(name);
        const station = stations.find((s) => s.id === stationId);
        const inStock = m.inDatabase && m.stock != null && m.stock >= qty;
        const rxId = newId('rx');
        rxRecords.push({
            id: rxId,
            stationId,
            department: station.department,
            patient: `Patient ${++r}`,
            prescriber: 'Dr. (seed)',
            createdAt: now - daysAgo * day,
        });
        rxItems.push({
            id: newId('item'),
            rxId,
            medId: m.id,
            medName: m.name,
            quantity: qty,
            stationId,
            department: station.department,
            inStock,
            inDatabase: m.inDatabase,
            createdAt: now - daysAgo * day,
        });
    }

    return { stations, users, meds, rxRecords, rxItems, audit: [] };
}

module.exports = { db, save, newId };
