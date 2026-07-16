/* Shared prescription renderer.
 * Produces fixed 4.25in x 5.50in pages and paginates the medicines:
 * when the Rx area is full, the next medicine starts a new page. Every page is a
 * complete, signable slip (header + patient + signature) — no page numbering.
 * Used by BOTH the nurse print and the audit "Prescription Mode", so what you
 * review is exactly what was printed.
 *
 * rx = { date, time, patient, address, age, sex,
 *        doctor: { name, license, ptr, s2 },
 *        meds:  [ { label, quantity, cls } ] }   cls: 'isnew' | 'nostock' | ''
 */
(function (global) {
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
    const withDr = (n) => (!n ? '' : (/^dr\.?\s/i.test(n) ? n : 'Dr. ' + n));

    const headHtml = (rx) => `
        <div class="rx-head">
            <img class="rx-logo-img" src="/img/logo.jpg" alt="">
            <div class="rx-htext">
                <div class="rx-hosp">TAGUM MEDICAL CITY</div>
                <div class="rx-oper">(From the Operators of Bishop Joseph Regan Memorial Hospital)</div>
                <div class="rx-addr">Purok 3-Rattan, Apokon, Tagum City, Davao del Norte</div>
            </div>
        </div>
        <div class="rx-date">Date: <u>${esc(rx.date)}</u> &nbsp; Time: <u>${esc(rx.time)}</u></div>
        <div class="rx-fld">Patient's Name: <u>${esc(rx.patient)}</u></div>
        <div class="rx-fld">Address: <u>${esc(rx.address)}</u></div>
        <div class="rx-fld">Age: <u>${esc(rx.age)}</u> &nbsp; Sex: <u>${esc(rx.sex)}</u></div>`;

    const footHtml = (rx) => {
        const d = rx.doctor || {};
        const nm = withDr((d.name || '').trim());
        return `
        <div class="rx-foot">
            <div class="rx-sign">
                <div class="sig-nm">${nm ? esc(nm) + ', ' : ''}M.D.</div>
                <div class="sig-rule"></div>
                <div class="sig-cap">Signature</div>
            </div>
            <div class="docfld">LIC. NO. <u>${esc(d.license) || '&nbsp;&nbsp;&nbsp;'}</u></div>
            <div class="docfld">S2 <u>${esc(d.s2) || '&nbsp;&nbsp;&nbsp;'}</u></div>
            <div class="docfld">PTR. NO. <u>${esc(d.ptr) || '&nbsp;&nbsp;&nbsp;'}</u></div>
        </div>`;
    };

    const medHtml = (m, n) => `
        <div class="med">
            <span class="num">${n}</span>
            <div class="mtext">
                <span class="mname ${m.cls || ''}">${esc(m.label)}</span>
                <span class="mqty">#${esc(m.quantity)}</span>
            </div>
        </div>`;

    function pageEl(rx) {
        const el = document.createElement('div');
        el.className = 'rx-page';
        el.innerHTML = `<div class="rx-sheet">
            ${headHtml(rx)}
            <div class="rx-body">
                <div class="rx-symbol">℞</div>
                <div class="rx-meds"></div>
            </div>
            ${footHtml(rx)}
        </div>`;
        return el;
    }

    // Returns an array of .rx-page elements, paginated to fit the fixed sheet.
    function buildSlipPages(rx) {
        const meds = rx.meds || [];
        // offscreen host so we can measure real laid-out heights
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden;';
        document.body.appendChild(host);

        const pages = [];
        let page = pageEl(rx);
        let medsEl = page.querySelector('.rx-meds');
        host.appendChild(page);
        pages.push(page);

        if (!meds.length) {
            medsEl.innerHTML = '<div class="med-empty">— no medicines —</div>';
        }

        meds.forEach((m, i) => {
            const tmp = document.createElement('div');
            tmp.innerHTML = medHtml(m, i + 1);
            const node = tmp.firstElementChild;
            medsEl.appendChild(node);
            // overflowed this sheet? move it to a fresh page
            if (medsEl.scrollHeight > medsEl.clientHeight) {
                medsEl.removeChild(node);
                page = pageEl(rx);
                medsEl = page.querySelector('.rx-meds');
                host.appendChild(page);
                pages.push(page);
                medsEl.appendChild(node);
            }
        });

        pages.forEach((p) => p.remove());
        host.remove();
        return pages;
    }

    const slipPagesHtml = (rx) => buildSlipPages(rx).map((p) => p.outerHTML).join('');

    // "Generic (Brand) Form Strength, 60 mL" — shared so audit matches the printed slip
    const medLabelOf = (it) => {
        const brand = it.brandName ? ` (${it.brandName})` : '';
        const strengthIsVol = String(it.strength || '').toLowerCase().replace(/[\s,]/g, '') === `${it.volumeMl}ml`;
        const vol = it.volumeMl && !strengthIsVol ? `, ${it.volumeMl} mL` : '';
        return `${it.genericName}${brand} ${it.formName} ${it.strength}${vol}`.replace(/\s+/g, ' ').trim();
    };
    const reasonCls = (r) => (r === 'not_in_formulary' ? 'isnew' : r === 'out_of_stock' ? 'nostock' : '');

    global.buildSlipPages = buildSlipPages;
    global.slipPagesHtml = slipPagesHtml;
    global.medLabelOf = medLabelOf;
    global.reasonCls = reasonCls;
})(window);
