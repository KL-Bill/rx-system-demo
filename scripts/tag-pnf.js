// Tag src/_db/medicines.json with inPnf (In the Philippine National Formulary).
//
// Source: src/_db/pnf.json — active ingredients transcribed from the PNF
// Essential Medicines List, 8th Edition (as of Nov 02, 2022).
//
// Note: "PNF" (Philippine National Formulary) and "PNDF" (Philippine National
// Drug Formulary) are the same designation — PNDF was the name used by
// Executive Order No. 49 s. 1993; the list has since been renamed PNF. There
// is only one flag for this, not two.
//
// Rules:
//   - inPnf lives on the GENERIC node (PNF membership is per active ingredient);
//     ihf stays per strength.
//   - Names are matched salt-stripped ("Heparin Sodium" ~ "Heparin (unfractionated)"),
//     with a synonym map for BAN/USAN spellings (aciclovir/acyclovir, etc.).
//   - Combination products count only when the combination itself is in the PNF;
//     component order and salts are ignored ("Zidovudine + Lamivudine" ~
//     "Lamivudine + Zidovudine").
//   - PNF entries with no generic in medicines.json are appended as new generics
//     (brands: [], inPnf: true) so nurses can find them.
//
// Idempotent — safe to re-run after a PNF or catalog update:  node scripts/tag-pnf.js

const fs = require('fs');
const path = require('path');
const DB = path.join(__dirname, '..', 'src', '_db');
const MEDS_FILE = path.join(DB, 'medicines.json');
const meds = JSON.parse(fs.readFileSync(MEDS_FILE, 'utf8'));
const PNF = JSON.parse(fs.readFileSync(path.join(DB, 'pnf.json'), 'utf8')).items;

// ---- normalization ----
// trailing salt/ester/hydrate words that are not part of the drug identity
const SALT_WORDS = new Set([
    'hydrochloride', 'dihydrochloride', 'hcl', 'sulfate', 'sulphate', 'sodium', 'potassium',
    'maleate', 'hydrogen', 'mesilate', 'mesylate', 'besilate', 'besylate', 'camsylate',
    'tartrate', 'bitartrate', 'fumarate', 'succinate', 'acetate', 'citrate', 'phosphate',
    'diphosphate', 'dipropionate', 'propionate', 'valerate', 'palmitate', 'stearate',
    'trihydrate', 'dihydrate', 'monohydrate', 'pentahydrate', 'heptahydrate', 'anhydrous',
    'hydrate', 'hyclate', 'hydrobromide', 'oxalate', 'decanoate', 'enanthate', 'undecanoate',
    'xinafoate', 'tromethamol', 'trometamol', 'lactate', 'salt', 'base', 'calcium', 'disodium',
    'bromide', 'nitrate', 'gluconate',
]);
// names starting with these are the mineral itself — never salt-strip them
const ELEMENTS = new Set([
    'sodium', 'potassium', 'calcium', 'magnesium', 'zinc', 'ferrous', 'ferric', 'iron',
    'aluminum', 'aluminium', 'silver', 'ammonium', 'lithium', 'iodine', 'barium', 'selenium',
]);
// BAN/USAN/local spelling differences, applied per combo component after stripping
const SYNONYMS = {
    'acetaminophen': 'paracetamol',
    'alendronic acid': 'alendronate',
    'desferrioxamine': 'deferoxamine',
    'mycophenolate': 'mycophenolic acid',
    'tenofovir disoproxil': 'tenofovir',
    'methylthioninium chloride': 'methylene blue',
    'selenium sulphide': 'selenium sulfide',
    'adrenaline': 'epinephrine',
    'albuterol': 'salbutamol',
    'acyclovir': 'aciclovir',
    'anastrozole': 'anastrazole',
    'benzathine benzylpenicillin': 'penicillin g benzathine',
    'benzylpenicillin': 'penicillin g crystalline',
    'cephalexin': 'cefalexin',
    'chlorpheniramine': 'chlorphenamine',
    'ciclosporine': 'ciclosporin',
    'cyclosporin': 'ciclosporin',
    'cyclosporine': 'ciclosporin',
    'clavulanate': 'clavulanic acid',
    'potassium clavulanate': 'clavulanic acid',
    'co-trimoxazole': 'cotrimoxazole',
    'dextrose': 'glucose',
    'dicyclomine': 'dicycloverine',
    'frusemide': 'furosemide',
    'fusidate': 'fusidic acid',
    'fusidate sodium': 'fusidic acid',
    'glycerin': 'glycerol',
    'glibenclamide': 'glibenclamide',
    'human normal immunoglobulin': 'immunoglobulin normal, human',
    'isosorbide mononitrate': 'isosorbide-5-mononitrate',
    'leuprolide': 'leuprorelin',
    'leuproreline': 'leuprorelin',
    'lumefantrine': 'lumefantrin',
    'meperidine': 'pethidine',
    'methylergonovine': 'methylergometrine',
    'nitroglycerin': 'glyceryl trinitrate',
    'penicillin v': 'phenoxymethyl penicillin',
    'phenoxymethylpenicillin': 'phenoxymethyl penicillin',
    'phenobarbitone': 'phenobarbital',
    'phytonadione': 'phytomenadione',
    'salbutamol sulfate': 'salbutamol',
    'sevelamer': 'sevelamer carbonate',
    'succinylcholine': 'suxamethonium',
    'sulphur': 'sulfur',
    'thiamazole': 'methimazole',
    'thiopentone': 'thiopental sodium',
    'thiopental': 'thiopental sodium',
    'vitamin a': 'retinol',
    'vitamin b1': 'thiamine',
    'vitamin b6': 'pyridoxine',
    'vitamin c': 'ascorbic acid',
    'vitamin k1': 'phytomenadione',
    'petroleum jelly': 'petrolatum',
    'white petrolatum': 'petrolatum',
};
// extra searchable keys for PNF entries whose common catalog spelling differs entirely
const PNF_ALIASES = {
    'co-amoxiclav': ['amoxicillin + clavulanic acid'],
    'cotrimoxazole': ['sulfamethoxazole + trimethoprim'],
    'ferrous salt': ['ferrous sulfate', 'ferrous fumarate', 'ferrous gluconate', 'iron'],
    'zinc': ['zinc sulfate', 'zinc gluconate', 'zinc oxide'],
    'regular insulin': ['insulin human', 'human insulin', 'insulin human regular'],
    'lipids': ['lipid emulsion'],
    'vitamin b1 b6 b12': ['thiamine + pyridoxine + cyanocobalamin', 'vitamin b complex'],
    'oral rehydration salts': ['oral rehydration salt'],
    'lagundi': ['vitex negundo'],
    'sambong': ['blumea balsamifera'],
    'tsaang gubat': ['carmona retusa'],
    'bcg vaccine': ['bacillus calmette-guerin vaccine'],
    'typhoid vaccine': ['typhoid polysaccharide vaccine'],
    'rabies immunoglobulin': ['human rabies immunoglobulin'],
    'tetanus immunoglobulin': ['human tetanus immunoglobulin'],
    'hepatitis b immunoglobulin': ['human hepatitis b immunoglobulin'],
    'anti-tetanus serum': ['tetanus antitoxin'],
    'oxygen': ['medical grade oxygen', 'medicinal grade oxygen', 'medical oxygen'],
};

const lower = (x) => String(x || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // accents: Guerin variants
    .replace(/[‐-―]/g, '-')          // unicode hyphens
    .replace(/[’]/g, "'")
    .toLowerCase();
const stripParens = (x) => x.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
const squeeze = (x) => x.replace(/\s+/g, ' ').replace(/\s*-\s*/g, '-').trim();

const stripSalts = (comp) => {
    let words = comp.split(' ').filter(Boolean);
    if (!words.length || ELEMENTS.has(words[0])) return comp;
    while (words.length > 1 && SALT_WORDS.has(words[words.length - 1])) words.pop();
    // leading "as": "atorvastatin as calcium"
    return words.join(' ').replace(/\s+as$/, '');
};
const synonym = (comp) => SYNONYMS[comp] || comp;

// canonical combo key: split on +, per-component strip & map, sort, rejoin
const comboKey = (name, doStrip) => name.split('+')
    .map((c) => squeeze(c).replace(/^[,.\s]+|[,.\s]+$/g, ''))
    .filter(Boolean)
    .map((c) => synonym(doStrip ? stripSalts(c) : c))
    .sort()
    .join(' + ');

// dosage-form / strength noise that FDA product names sometimes carry
// ("BENZYL BENZOATE 25% LOTION")
const FORM_NOISE = /\b\d+(\.\d+)?\s*%|\b(lotion|solution|cream|ointment|shampoo|gel|syrup|suspension|topical)\b/g;
// word-order-proof key for vaccine names ("Varicella Vaccine (Live, Attenuated)"
// ~ "Live Attenuated Varicella Vaccine"); packaging adjectives dropped
const VACCINE_DROP = new Set(['live', 'attenuated', 'inactivated', 'virus', 'and', 'purified', 'adsorbed']);
const vaccineKey = (n) => 'vx:' + n.split(/[\s,+/-]+/)
    .filter((w) => w && !VACCINE_DROP.has(w))
    .sort()
    .join(' ');

// every key a name can be found under
const keysFor = (name) => {
    const out = new Set();
    const base = squeeze(lower(name));
    const noParen = squeeze(stripParens(lower(name)));
    const variants = new Set([base, noParen]);
    // "Albumin, Human" <-> "Human Albumin"; "Isophane Insulin Human, rDNA" -> head
    const parts = noParen.split(',').map((p) => squeeze(p)).filter(Boolean);
    if (parts.length === 2) variants.add(`${parts[1]} ${parts[0]}`);
    if (parts.length > 1) variants.add(parts[0]);
    // strength/form noise stripped
    variants.add(squeeze(noParen.replace(FORM_NOISE, ' ')));
    for (const n of variants) {
        if (!n) continue;
        out.add(n);
        out.add(comboKey(n, false));
        out.add(comboKey(n, true));
        // slash combos: sacubitril/valsartan
        if (n.includes('/') && !/\d\/|\/\d/.test(n)) {
            const slashed = n.replace(/\s*\/\s*/g, ' + ');
            out.add(comboKey(slashed, false));
            out.add(comboKey(slashed, true));
        }
    }
    if (noParen.includes('vaccine')) out.add(vaccineKey(noParen));
    out.delete('');
    return out;
};

// ---- index the PNF ----
const pnfIndex = new Map();   // key -> pnf item index
PNF.forEach((name, i) => {
    const keys = keysFor(name);
    for (const alias of PNF_ALIASES[squeeze(stripParens(lower(name)))] || []) {
        for (const k of keysFor(alias)) keys.add(k);
    }
    for (const k of keys) if (!pnfIndex.has(k)) pnfIndex.set(k, i);
});

// ---- tag the generics ----
const matchedPnf = new Set();
let tagged = 0;
for (const g of meds) {
    let hit = null;
    for (const k of keysFor(g.genericName)) {
        if (pnfIndex.has(k)) { hit = pnfIndex.get(k); break; }
    }
    g.inPnf = hit != null;
    if (hit != null) { matchedPnf.add(hit); tagged++; }
}

// ---- append PNF entries missing from the catalog ----
let maxId = 0;
const walkIds = (o) => { if (o && typeof o.id === 'number' && o.id > maxId) maxId = o.id; };
for (const g of meds) { walkIds(g); for (const b of g.brands || []) { walkIds(b); for (const f of b.forms || []) { walkIds(f); for (const s of f.strengths || []) walkIds(s); } } }

// display name for new nodes: drop "(as ...)" parens, keep meaningful ones
const displayName = (name) => name.replace(/\(as [^)]*\)/gi, ' ').replace(/\s+/g, ' ').trim();

const added = [];
PNF.forEach((name, i) => {
    if (matchedPnf.has(i)) return;
    meds.push({ id: ++maxId, genericName: displayName(name), brands: [], inPnf: true });
    added.push(displayName(name));
});

// ---- backup, write, report ----
const backup = path.join(DB, `medicines.backup-${new Date().toISOString().slice(0, 10)}.json`);
if (!fs.existsSync(backup)) fs.copyFileSync(MEDS_FILE, backup);
fs.writeFileSync(MEDS_FILE, JSON.stringify(meds, null, 1));

console.log(`PNF entries: ${PNF.length}  |  matched to existing generics: ${matchedPnf.size}`);
console.log(`generics tagged inPnf:true: ${tagged} of ${meds.length - added.length}`);
console.log(`PNF entries appended as new generics: ${added.length}`);
console.log(`backup: ${path.basename(backup)}`);
if (added.length) console.log('\nappended:\n  ' + added.join('\n  '));
