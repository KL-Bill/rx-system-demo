/* Splits a Bizbox-style description — "ALLERKID 5MG/5ML 60ML SYRUP" — into
 * brand / form / strength / volume. Used in three places, so it lives once:
 *   - the nurse page, to prefill the three fields when a typed medicine
 *     matches nothing in the catalog (browser: window.splitDescription)
 *   - the Bizbox import, to parse every row of the export (node: require)
 *   - Add Medicine on the pharmacy side, same prefill as the nurse page
 *
 * It is a prefill, never the final word: every caller shows the result in
 * separate fields for a human to confirm. Measured on the real 1,164-row
 * export it gets form and strength on ~9 rows in 10; the rest are flagged
 * through `warnings` so the reviewer looks at them.
 *
 * Bizbox order is BRAND STRENGTH [VOLUME] FORM, so: the form is the rightmost
 * dictionary word, every "number+unit" token is strength (the volume stays
 * inside the strength — it is what tells a 30ML syrup from the 60ML one), and
 * whatever is left is the brand.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.splitDescription = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Built-in dictionary; callers pass the catalog's live form names on top
    // (splitDescription(text, { forms })) so a form Bizbox invents is still
    // recognised once it has been seen. Multi-word entries must come before
    // their last word ("POWDER FOR INJECTION" before "POWDER") — sorted by
    // length below so order here does not matter.
    const BASE_FORMS = [
        'POWDER FOR INJECTION', 'POWDER FOR SUSPENSION', 'SOLUTION FOR INJECTION', 'SOLUTION FOR INHALATION',
        'SOLUTION FOR IV INFUSION', 'PREFILLED SYRINGE', 'PRE-FILLED SYRINGE', 'PRE-FILLED PEN', 'PREFILLED PEN',
        'IV INFUSION', 'ORAL SUSPENSION', 'ORAL SOLUTION', 'ORAL DROPS', 'ORAL GEL', 'ORAL POWDER', 'EAR DROPS', 'EYE DROPS',
        'EYE OINTMENT', 'NASAL SPRAY', 'NASAL DROPS', 'WOUND SOLUTION', 'IRRIGATING SOLUTION', 'SOFT BAG', 'SOFTBAG',
        'SOFTGEL CAPSULE', 'SOFT GEL CAPSULE', 'EFFERVESCENT TABLET', 'CHEWABLE TABLET', 'FILM COATED TABLET',
        'FILM-COATED TABLET', 'SUSTAINED-RELEASE TABLET', 'EXTENDED-RELEASE TABLET', 'VAGINAL TABLET', 'VAGINAL SUPPOSITORY',
        'RECTAL SUPPOSITORY', 'TRANSDERMAL PATCH', 'METERED DOSE INHALER', 'DRY POWDER INHALER', 'TURBUHALER',
        'NEBULE', 'NEBULES', 'RESPULE', 'RESPULES', 'SACHET', 'SACHETS', 'TABLET', 'TABLETS', 'TAB', 'TABS', 'CAPSULE', 'CAPSULES',
        'CAP', 'CAPS', 'SYRUP', 'SUSPENSION', 'SUSPENSIO', 'SUSP', 'SOLUTION', 'SOLN', 'DROPS', 'VIAL', 'VIALS', 'AMPOULE',
        'AMPOULES', 'AMPULE', 'AMPULES', 'AMP', 'POLYAMP', 'BOTTLE', 'POWDER', 'CREAM', 'OINTMENT', 'OINMENT', 'SUPPOSITORY',
        'GEL', 'SPRAY', 'SYRINGE', 'PFS', 'PFP', 'PATCH', 'PEN', 'INHALER', 'INJECTION', 'INJ', 'INFUSION', 'LOTION',
        'LOZENGE', 'LOZENGES', 'GRANULES', 'ENEMA', 'SHAMPOO', 'MOUTHWASH', 'BAG', 'KIT', 'IV',
    ];

    // abbreviations and typos folded onto the spelling the catalog already
    // uses, so a nurse typing "tab" does not create a second TABLET form
    const FORM_ALIAS = {
        TAB: 'TABLET', TABS: 'TABLET', TABLETS: 'TABLET', CAP: 'CAPSULE', CAPS: 'CAPSULE', CAPSULES: 'CAPSULE',
        AMP: 'AMPOULE', AMPULE: 'AMPOULE', AMPULES: 'AMPOULE', AMPOULES: 'AMPOULE', VIALS: 'VIAL',
        SUSP: 'SUSPENSION', SUSPENSIO: 'SUSPENSION', SOLN: 'SOLUTION', INJ: 'INJECTION', OINMENT: 'OINTMENT',
        NEBULES: 'NEBULE', RESPULES: 'RESPULE', SACHETS: 'SACHET', LOZENGES: 'LOZENGE', PFS: 'PREFILLED SYRINGE',
        'PRE-FILLED SYRINGE': 'PREFILLED SYRINGE', 'PRE-FILLED PEN': 'PREFILLED PEN', PFP: 'PREFILLED PEN',
        SOFTBAG: 'SOFT BAG', 'SOFT GEL CAPSULE': 'SOFTGEL CAPSULE', 'FILM COATED TABLET': 'FILM-COATED TABLET',
    };
    const canonForm = (f) => FORM_ALIAS[f] || f;

    // salt words that make "Cetirizine Dihydrochloride" the same molecule as "Cetirizine"
    const SALTS = /\b(?:hydrochloride|dihydrochloride|hcl|hbr|hydrobromide|sodium|potassium|calcium|magnesium|trometamol|tromethamine|tromethamol|maleate|sulfate|sulphate|acetate|besylate|besilate|mesylate|mesilate|citrate|tartrate|bitartrate|succinate|phosphate|diphosphate|bromide|nitrate|fumarate|oxalate|lactate|gluconate|stearate|palmitate|propionate|valerate|dipropionate|monohydrate|dihydrate|trihydrate|anhydrous|micronized|micronised|base|as|salt)\b/gi;

    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');

    // a dose: number + unit, optionally chained with "/" — 500MG, 5MG/5ML,
    // 400MG/57MG/5ML, 4.5G, 1,500,000IU, 0.9%, 100IU/ML, 5,000IU/0.3ML, 25MCG/HR
    const UNIT = '(?:MCG|MG|GM|GMS|G|IU|I\\.U\\.|U|MU|ML|L|%|MEQ|MMOL|MOL|UNITS?|KCAL|HR|ACT|DOSES?|DS|LSU|CFU)';
    const NUM = '\\d[\\d,]*(?:\\.\\d+)?|\\.\\d+';
    const DOSE_RE = new RegExp(`^(?:${NUM})\\s?${UNIT}(?:/(?:(?:${NUM})\\s?)?${UNIT})*$`, 'i');
    const VOL_RE = new RegExp(`^(?:${NUM})\\s?(?:ML|L)$`, 'i');
    const NON_PNDF_RE = /\(?\s*non-?\s*pndf\s*\)?/ig;

    // unit spellings Bizbox uses interchangeably — normalised so "1GM" and "1G"
    // are the same strength and the catalog does not grow a duplicate
    const normaliseUnits = (s) => s
        .replace(/(\d)\s*GMS?\b/gi, '$1G')
        .replace(/(\d)\s*I\.U\.?/gi, '$1IU')
        .replace(/(\d)\s*M\s+UNITS?\b/gi, '$1MU')
        .replace(/(\d)\s*UNITS?\b/gi, '$1U')
        .replace(/\/\s+/g, '/');                     // "600MG/ 4ML" -> "600MG/4ML"

    const volumeOf = (tok) => {
        const m = String(tok).match(new RegExp(`^(${NUM})\\s?(ML|L)$`, 'i'));
        if (!m) return null;
        const v = Number(m[1].replace(/,/g, ''));
        if (!Number.isFinite(v)) return null;
        return m[2].toUpperCase() === 'L' ? v * 1000 : v;
    };

    /* splitDescription(text, { forms, generic }) ->
     *   { brand, form, strength, volumeMl, altStrength, nonPndf, warnings, raw }
     *   forms:   extra form names to recognise (the catalog's live list)
     *   generic: when the description starts with the generic itself
     *            ("MIDAZOLAM 1MG/ML 5ML VIAL"), the brand is blank
     */
    function splitDescription(text, opts) {
        opts = opts || {};
        const raw = String(text || '');
        const warnings = [];
        let s = raw.replace(/\s+/g, ' ').trim();

        const nonPndf = NON_PNDF_RE.test(s);
        NON_PNDF_RE.lastIndex = 0;
        s = s.replace(NON_PNDF_RE, ' ');
        s = s.replace(/\*+\s*MG/ig, ' ');                          // "***MG" junk
        s = normaliseUnits(s);

        // a parenthesised dose — "(6MG/2ML)", "(1G/100ML)" — is the same
        // strength said another way; keep it beside the main one. Any other
        // parenthesis ("(ADULT)", "(IPI)") stays with the brand.
        let altStrength = null;
        s = s.replace(/\(([^)]*)\)/g, (m, inner) => {
            const t = inner.trim().replace(/\s+/g, '');
            if (DOSE_RE.test(t)) { altStrength = t.toUpperCase(); return ' '; }
            return ` (${inner.trim()}) `;
        });
        // a dose glued to a word: "BREECORT250MCG/ML" -> "BREECORT 250MCG/ML"
        s = s.replace(new RegExp(`([A-Z])(${NUM})\\s?(${UNIT})(?=\\s|$|/)`, 'gi'), '$1 $2$3');
        // a split number and unit: "4.5 G" -> "4.5G"
        s = s.replace(new RegExp(`(${NUM})\\s+(${UNIT})(?=\\s|$|/)`, 'gi'), '$1$2');
        s = s.replace(/\s+/g, ' ').trim();

        // form: every dictionary match, longest names first so "POWDER FOR
        // INJECTION" wins over "POWDER". Several in one description — "POWDER
        // FOR INJECTION VIAL", "ORAL POWDER SACHET" — are kept together in
        // text order; the one word "VIAL" would lose what is in the vial.
        const forms = BASE_FORMS.concat((opts.forms || []).map((f) => String(f || '').toUpperCase()).filter(Boolean));
        const uniq = Array.from(new Set(forms)).sort((a, b) => b.length - a.length);
        const formRe = new RegExp(`(?:^|\\s)(${uniq.map(escapeRe).join('|')})(?=\\s|$|\\()`, 'gi');
        const found = [];
        let fm;
        while ((fm = formRe.exec(s))) found.push({ at: fm.index, len: fm[0].length, word: canonForm(fm[1].toUpperCase()) });
        let form = '';
        if (found.length) {
            form = Array.from(new Set(found.map((f) => f.word))).join(' ');
            for (let i = found.length - 1; i >= 0; i--) {
                s = s.slice(0, found[i].at) + ' ' + s.slice(found[i].at + found[i].len);
            }
            s = s.replace(/\s+/g, ' ').trim();
        }

        // strength: every dose token, in order; the volume rides along
        const doses = [], rest = [];
        let volumeMl = null;
        s.split(' ').forEach((t) => {
            if (t && DOSE_RE.test(t)) {
                doses.push(t.toUpperCase());
                const v = volumeOf(t);
                if (v != null) volumeMl = v;
            } else if (t) rest.push(t);
        });
        let strength = doses.join(' ');
        if (altStrength) strength = strength ? `${strength} (${altStrength})` : altStrength;

        let brand = rest.join(' ').replace(/\s+/g, ' ').trim();
        // unbranded: the description starts with the generic itself — spelled
        // the same, or with the salt named ("CETIRIZINE DIHYDROCHLORIDE" for
        // the generic "CETIRIZINE"). Either way there is no brand here.
        const gen = String(opts.generic || '').replace(/\s+/g, ' ').trim().toUpperCase();
        const flat = (x) => x.toUpperCase().replace(/[^A-Z0-9%]/g, '');
        const molecule = (x) => flat(String(x).replace(/\([^)]*\)/g, ' ').replace(SALTS, ' '));
        if (gen && brand && (brand.toUpperCase() === gen || flat(brand) === flat(gen) || (molecule(brand) && molecule(brand) === molecule(gen)))) brand = '';

        // IV fluids and contrast media carry no form word — "0.9% SODIUM
        // CHLORIDE 500ML" — but a strength that ends in a volume is a solution
        if (!form && volumeMl != null && doses.length && VOL_RE.test(doses[doses.length - 1])) form = 'SOLUTION';

        if (!form) warnings.push('no form');
        if (!strength) warnings.push('no strength');
        if (/\d/.test(brand)) warnings.push('digit in brand');
        if (brand.split(' ').length > 4) warnings.push('long brand');
        if (!brand && !form && !strength) warnings.push('nothing recognised');

        return { brand, form, strength, volumeMl, altStrength, nonPndf, warnings, raw };
    }

    // the reverse: brand + strength + form in Bizbox order — what the catalog
    // stores as `description` for a product no export has named yet
    splitDescription.stitch = (parts) => [parts.brand, parts.strength, parts.form]
        .map((x) => String(x || '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ');

    splitDescription.BASE_FORMS = BASE_FORMS;
    return splitDescription;
}));
