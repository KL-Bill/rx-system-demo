const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const DATA_FILE = path.join(__dirname, '..', '..', 'data.json');

let data = null;

const newId = (prefix) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

const load = () => {
    if (data) return data;
    if (fs.existsSync(DATA_FILE)) {
        data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } else {
        data = seed();
        save();
        console.log('Seeded data.json (demo). Pharmacy logins:');
        console.log('  superadmin / super123   subadmin / sub123   staff / staff123');
    }
    return data;
};

const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
const db = () => load();

function seed() {
    const stations = [
        { id: 'st-er',   name: 'Emergency Room',  department: 'Emergency' },
        { id: 'st-peds', name: 'Pediatrics Ward', department: 'Pediatrics' },
        { id: 'st-ob',   name: 'OB-GYN Ward',     department: 'OB-GYN' },
        { id: 'st-surg', name: 'Surgery Ward',    department: 'Surgery' },
        { id: 'st-opd',  name: 'Out-Patient Dept', department: 'OPD' },
    ];

    const users = [
        { id: 'u-super', name: 'Dr. Reyes',  username: 'superadmin', password: bcrypt.hashSync('super123', 10), role: 'superadmin' },
        { id: 'u-sub',   name: 'Ms. Santos', username: 'subadmin',   password: bcrypt.hashSync('sub123', 10),   role: 'subadmin' },
        { id: 'u-staff', name: 'Mr. Cruz',   username: 'staff',      password: bcrypt.hashSync('staff123', 10), role: 'staff' },
    ];

    const generics = require('./catalog.json');   // TMC Formulary (AllMeds_2026.xlsx)
    const doctors = require('./doctors.json');     // PRC-licensed doctors (list of dr's.xlsx)

    // ---- demo prescriptions so the review/reports have content ----
    const now = Date.now();
    const day = 86400000;
    const pick = (i) => { const d = doctors[i % doctors.length]; return { name: d.name, license: d.license, ptr: '', s2: '' }; };
    const item = (g, b, f, s, qty, reason) => ({ genericName: g, brandName: b, formName: f, strength: s, quantity: qty, reason });
    const prescriptions = [];
    let n = 0;
    const P = (daysAgo, stationId, docIdx, items) => {
        const st = stations.find((x) => x.id === stationId);
        prescriptions.push({
            id: newId('rx'), stationId, department: st.department, doctor: pick(docIdx),
            patient: `Patient ${++n}`, address: '', age: '', sex: '', items, createdAt: now - daysAgo * day,
        });
    };

    // out-of-stock (in Formulary)
    P(1, 'st-er', 0, [item('ACETYLCYSTEINE', 'FLUIMUCIL', 'TABLET', '600MG', 2, 'out_of_stock')]);
    P(2, 'st-peds', 1, [item('ACETYLCYSTEINE', 'FLUIMUCIL', 'TABLET', '600MG', 3, 'out_of_stock')]);
    P(3, 'st-er', 2, [item('ACETYLCYSTEINE', 'FLUIMUCIL', 'TABLET', '600MG', 1, 'out_of_stock'), item('AMLODIPINE BESYLATE', 'AMBESYL', 'TABLET', '10MG', 2, 'out_of_stock')]);
    P(2, 'st-surg', 3, [item('AMLODIPINE BESYLATE', 'AMBESYL', 'TABLET', '10MG', 1, 'out_of_stock')]);
    // not-in-formulary (new)
    P(1, 'st-opd', 4, [item('CO-AMOXICLAV', 'AUGMENTIN', 'TABLET', '625MG', 10, 'not_in_formulary')]);
    P(2, 'st-er', 5, [item('CO-AMOXICLAV', 'AUGMENTIN', 'TABLET', '625MG', 14, 'not_in_formulary')]);
    P(4, 'st-ob', 6, [item('CO-AMOXICLAV', 'AUGMENTIN', 'TABLET', '625MG', 6, 'not_in_formulary')]);
    P(3, 'st-peds', 7, [item('ROSUVASTATIN', 'CRESTOR', 'TABLET', '20MG', 5, 'not_in_formulary')]);

    return { stations, users, generics, doctors, prescriptions, reviewStatus: {}, audit: [] };
}

module.exports = { db, save, newId };
