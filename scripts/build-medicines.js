// Build src/_db/medicines.json — the single merged drug catalog.
//
// Sources:
//   src/_db/philippine_drug_formulary.json  (PNDF, flat product rows — canonical spellings)
//   src/_db/catalog.json                    (TMC hospital formulary, enriched with registrationNumber)
//
// Merge rules:
//   - Every PNDF product becomes a node; strengths carry { registrationNumber, classification, ihf }.
//     ihf (in hospital formulary) = its reg number is on a hospital product (exact matches only,
//     regApprox excluded), or the hospital carries the same drug under the same brand / unbranded.
//   - Hospital products WITHOUT an exact PNDF reg match (approx or unmatched: IV fluids, local
//     spellings like ZOVIRAX) are appended with their hospital spelling, ihf: true, so nurses can
//     still find what they used to search.
//   - Hospital products WITH an exact reg match are represented by the PNDF node (no duplicates).
//
// Re-run after updating either source file:  node scripts/build-medicines.js

const fs = require('fs');
const path = require('path');
const DB = path.join(__dirname, '..', 'src', '_db');
const PNDF = require(path.join(DB, 'philippine_drug_formulary.json'));
const CATALOG = require(path.join(DB, 'catalog.json'));
const OUT = path.join(DB, 'medicines.json');

const norm = (x) => String(x || '').trim().toLowerCase();
// drop "(see reverse for formulation)" / "[see formulation]" — instructions printed on the
// FDA registration certificate that were digitized as if they were part of the name
const SEE_REVERSE = /[([][^)\]]*see[^)\]]*(reverse|formulation)[^)\]]*[)\]]|see reverse( side)?( of certificate)?( for( complete)? formulation)?|see formulation( on (the )?(reverse side|cpr))?/gi;
const clean = (x) => String(x || '').replace(SEE_REVERSE, ' ').replace(/\s+/g, ' ').trim();

const strengthLabel = (s) => s.label || (s.value != null ? `${s.value}${s.unit}` : (s.unit || ''));

// structured volume for strengths that ARE a volume ("500ML", "0.5 mL", "1L")
const volumeMl = (label) => {
    const m = String(label || '').trim().match(/^([\d.,]+)\s*(ml|l)$/i);
    if (!m) return null;
    const v = Number(m[1].replace(/,/g, ''));
    return Number.isFinite(v) ? (m[2].toLowerCase() === 'l' ? v * 1000 : v) : null;
};

// ---- what the hospital carries ----
// STRICT product-level membership: a node is ihf only if it IS a hospital product —
// its reg number identifies one exactly, or it's appended from the hospital list.
// No inference from sibling strengths/forms/brands of carried drugs.
const exactRegs = new Set();      // reg numbers of exactly-identified hospital products
const leftovers = [];             // hospital products not representable by a PNDF node
for (const g of CATALOG) {
    for (const b of g.brands || []) {
        for (const f of b.forms || []) {
            for (const s of f.strengths || []) {
                if (s.registrationNumber && !s.regApprox) exactRegs.add(s.registrationNumber);
                else leftovers.push({ g, b, f, s });
            }
        }
    }
}

// ---- build the tree, PNDF first ----
let nextId = 1;
const generics = [];
const genericIdx = new Map();   // norm(genericName) -> node
const canon = new Map();
const canonical = (x) => {
    const s = clean(x); const k = norm(s);
    if (!k) return s;
    if (!canon.has(k)) canon.set(k, s);
    return canon.get(k);
};
const nodeFor = (map, list, key, make) => {
    if (!map.has(key)) { const n = make(); map.set(key, n); list.push(n); }
    return map.get(key);
};
const put = ({ genericName, brandName, formName, strength }) => {
    const g = nodeFor(genericIdx, generics, norm(genericName),
        () => ({ id: nextId++, genericName, brands: [], _b: new Map() }));
    const b = nodeFor(g._b, g.brands, norm(brandName),
        () => ({ id: nextId++, brandName, forms: [], _f: new Map() }));
    const f = nodeFor(b._f, b.forms, norm(formName),
        () => ({ id: nextId++, formName, strengths: [], _s: new Map() }));
    if (f._s.has(norm(strength))) return null;   // duplicate product row
    const s = { id: nextId++, label: strength };
    f._s.set(norm(strength), s);
    f.strengths.push(s);
    return s;
};

let dup = 0, ihfCount = 0;
for (const r of PNDF) {
    const genericName = canonical(r.generic_name);
    if (!genericName) continue;
    const brandName = canonical(r.brand_name), formName = canonical(r.dosage_form), strength = canonical(r.dosage_strength);
    const s = put({ genericName, brandName, formName, strength });
    if (!s) { dup++; continue; }
    s.registrationNumber = clean(r.registration_number) || null;
    s.classification = clean(r.classification) || null;
    const vol = volumeMl(strength);
    if (vol != null) s.volumeMl = vol;
    s.ihf = s.registrationNumber != null && exactRegs.has(s.registrationNumber);
    if (s.ihf) ihfCount++;
}

// ---- append hospital products the PNDF doesn't cover exactly ----
let appended = 0;
for (const { g, b, f, s } of leftovers) {
    const n = put({ genericName: clean(g.genericName), brandName: clean(b.brandName), formName: clean(f.formName), strength: strengthLabel(s) });
    if (!n) continue;   // already present under the same spelling
    n.registrationNumber = s.registrationNumber || null;
    if (s.regApprox) n.regApprox = true;
    n.classification = null;
    n.nonPndf = !!s.nonPndf;
    n.ihf = true;
    const vol = volumeMl(strengthLabel(s));
    if (vol != null) n.volumeMl = vol;
    appended++; ihfCount++;
}

// drop the builder maps
for (const g of generics) { delete g._b; for (const b of g.brands) { delete b._f; for (const f of b.forms) delete f._s; } }

let strengths = 0;
for (const g of generics) for (const b of g.brands) for (const f of g === g && b.forms) strengths += f.strengths.length;
fs.writeFileSync(OUT, JSON.stringify(generics, null, 1));
console.log(`medicines.json: ${generics.length} generics, ${strengths} products (${dup} PNDF duplicates collapsed)`);
console.log(`in hospital formulary (ihf): ${ihfCount}  |  hospital-only nodes appended: ${appended}`);
