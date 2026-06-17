(async function () {
    // if a pharmacy user is already logged in, send them to the dashboard
    const meRes = await api('/api/auth/me');
    if (meRes.ok) { window.location.href = '/dashboard'; return; }

    const $ = (id) => document.getElementById(id);
    const items = []; // { medId?, name, strength, form, quantity, inDatabase, stock, isNew }
    let savedRxId = null; // set once the current list is recorded; cleared when meds change

    // ----- stations -----
    const stationsRes = await api('/api/rx/stations');
    const stationSel = $('station');
    (stationsRes.data.stations || []).forEach((s) => {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = `${s.name} (${s.department})`;
        stationSel.appendChild(o);
    });

    // ----- station: pin this device to a station -----
    // Open as /?station=st-er to lock a tablet to a station; otherwise the
    // last-used station is remembered on this device.
    const hasOption = (v) => [...stationSel.options].some((o) => o.value === v);
    const urlStation = new URLSearchParams(location.search).get('station');
    const savedStation = localStorage.getItem('rx_station');
    const note = $('stationNote');

    if (urlStation && hasOption(urlStation)) {
        stationSel.value = urlStation;
        stationSel.disabled = true;
        localStorage.setItem('rx_station', urlStation);
        note.innerHTML = 'Locked to this station for this device. <a href="#" id="unlockStation">change</a>';
        $('unlockStation').onclick = (e) => {
            e.preventDefault();
            localStorage.removeItem('rx_station');
            location.href = '/';
        };
    } else if (savedStation && hasOption(savedStation)) {
        stationSel.value = savedStation;
    }

    stationSel.addEventListener('change', () => {
        localStorage.setItem('rx_station', stationSel.value);
        renderPreview();
    });

    // ----- medicine search -----
    const searchInput = $('search');
    const sugBox = $('suggestions');
    let timer = null;

    searchInput.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(runSearch, 180);
    });
    searchInput.addEventListener('blur', () => setTimeout(() => (sugBox.style.display = 'none'), 150));
    searchInput.addEventListener('focus', runSearch);

    async function runSearch() {
        const q = searchInput.value.trim();
        if (!q) { sugBox.style.display = 'none'; return; }
        const res = await api('/api/rx/meds?search=' + encodeURIComponent(q));
        const meds = res.data.meds || [];
        const exact = meds.some((m) => m.name.toLowerCase() === q.toLowerCase());

        let html = meds.map((m) => {
            const badge = !m.inDatabase
                ? '<span class="badge amber">pending</span>'
                : m.stock > 0
                    ? `<span class="badge green">in stock: ${m.stock}</span>`
                    : '<span class="badge red">out of stock</span>';
            return `<div class="opt" data-id="${m.id}">
                        <span>${escapeHtml(m.name)} <span class="muted">${escapeHtml(m.strength || '')} ${escapeHtml(m.form || '')}</span></span>
                        ${badge}
                    </div>`;
        }).join('');

        if (!exact) {
            html += `<div class="opt new" data-new="1">+ Add "${escapeHtml(q)}" as a new medicine</div>`;
        }
        sugBox.innerHTML = html;
        sugBox.style.display = 'block';

        sugBox.querySelectorAll('.opt').forEach((opt) => {
            opt.addEventListener('mousedown', (e) => {
                e.preventDefault();
                if (opt.dataset.new) {
                    openNewMed(searchInput.value.trim());
                } else {
                    const med = meds.find((m) => m.id === opt.dataset.id);
                    // existing med (active or already-pending) -> not "new"
                    addItem({
                        medId: med.id, name: med.name, strength: med.strength,
                        form: med.form, inDatabase: med.inDatabase, stock: med.stock,
                        isNew: false, quantity: 1,
                    });
                }
                searchInput.value = '';
                sugBox.style.display = 'none';
            });
        });
    }

    // ----- new-med warning modal -----
    const modal = $('newMedModal');
    let pendingName = '';
    function openNewMed(name) {
        pendingName = name;
        $('newMedMsg').textContent = `"${name}" is not in the database.`;
        $('nmStrength').value = '';
        $('nmForm').value = '';
        modal.classList.add('show');
    }
    $('nmCancel').onclick = () => modal.classList.remove('show');
    $('nmConfirm').onclick = () => {
        addItem({
            name: pendingName, strength: $('nmStrength').value.trim(),
            form: $('nmForm').value.trim(), inDatabase: false, isNew: true, quantity: 1,
        });
        modal.classList.remove('show');
        searchInput.value = '';
    };

    // ----- item list -----
    // changing the medicine list means it's a different prescription -> record again on next print
    function addItem(item) {
        items.push(item);
        savedRxId = null;
        render();
    }
    function removeItem(i) { items.splice(i, 1); savedRxId = null; render(); }

    // badge reflects the requested quantity vs available stock
    function badgeFor(it) {
        if (it.isNew) return { cls: 'amber', text: 'new' };
        if (!it.inDatabase) return { cls: 'amber', text: 'pending' };
        if (it.stock >= it.quantity) return { cls: 'green', text: 'in stock' };
        if (it.stock > 0) return { cls: 'amber', text: `only ${it.stock} left` };
        return { cls: 'red', text: 'out of stock' };
    }

    function render() {
        const list = $('items');
        $('items-empty').style.display = items.length ? 'none' : 'block';
        list.innerHTML = items.map((it, i) => {
            const b = badgeFor(it);
            return `<li>
                <span class="nm">${escapeHtml(it.name)} <span class="badge ${b.cls}" data-badge="${i}">${b.text}</span>
                    <small>${escapeHtml(it.strength || '')} ${escapeHtml(it.form || '')}</small></span>
                <input class="qty" type="number" min="1" value="${it.quantity}" data-i="${i}">
                <button class="x" data-x="${i}">✕</button>
            </li>`;
        }).join('');

        list.querySelectorAll('input.qty').forEach((inp) => {
            inp.addEventListener('input', () => {
                const i = Number(inp.dataset.i);
                items[i].quantity = Number(inp.value) || 1;
                savedRxId = null;
                const b = badgeFor(items[i]);
                const el = list.querySelector(`[data-badge="${i}"]`);
                if (el) { el.className = `badge ${b.cls}`; el.textContent = b.text; }
                renderPreview();
            });
        });
        list.querySelectorAll('button.x').forEach((b) => {
            b.addEventListener('click', () => removeItem(Number(b.dataset.x)));
        });
        renderPreview();
    }

    function slipHtml() {
        const today = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });
        const val = (id) => escapeHtml($(id) ? $(id).value.trim() : '');
        const meds = items.map((it, i) => `
            <div class="med">
                <span class="num">${i + 1}</span>
                <div class="mtext">
                    <span class="mname">${escapeHtml(it.name)} <span class="mstr">${escapeHtml(it.strength || '')} ${escapeHtml(it.form || '')}</span></span>
                    <span class="mqty"># ${it.quantity}${it.form ? ' ' + escapeHtml(it.form.toLowerCase()) : ''}</span>
                </div>
            </div>`).join('');

        return `<div class="rx-form">
            <div class="rx-head">
                <div class="rx-logo">✚</div>
                <div class="rx-htext">
                    <div class="rx-hosp">TAGUM MEDICAL CITY</div>
                    <div class="rx-oper">(From the Operators of Bishop Joseph Regan Memorial Hospital)</div>
                    <div class="rx-addr">Purok 3-Rattan, Apokon, Tagum City, Davao del Norte</div>
                </div>
            </div>
            <div class="rx-date">Date: <u>${today}</u></div>
            <div class="rx-fld">Patient's Name: <u>${val('patient')}</u></div>
            <div class="rx-fld">Address: <u>${val('address')}</u></div>
            <div class="rx-fld">Age: <u>${val('age')}</u> &nbsp; Sex: <u>${val('sex')}</u></div>
            <div class="rx-body">
                <div class="rx-left">
                    <div class="rx-symbol">℞</div>
                    <div class="rx-tag">GENERIC NAME:</div>
                    <div class="rx-tag">BRAND NAME:</div>
                </div>
                <div class="rx-meds">${meds || '<div class="med-empty">— no medicines —</div>'}</div>
            </div>
            <div class="rx-signa">SIGNA</div>
            <div class="rx-foot">
                <div class="docline"><u>${val('prescriber')}</u> <b>MD</b></div>
                <div class="docfld">LIC. NO. <u>&nbsp;&nbsp;&nbsp;</u></div>
                <div class="docfld">PTR. NO. <u>&nbsp;&nbsp;&nbsp;</u></div>
                <div class="docfld">S2 <u>&nbsp;&nbsp;&nbsp;</u></div>
            </div>
        </div>`;
    }

    function renderPreview() { $('preview').innerHTML = slipHtml(); }

    // ----- print -----
    $('printBtn').onclick = async () => {
        if (!items.length) { alert('Add at least one medicine first.'); return; }

        // record the prescription once; reprints (e.g. after cancelling the dialog)
        // reuse the same record instead of double-counting demand
        if (!savedRxId) {
            const payload = {
                stationId: stationSel.value,
                patient: $('patient').value.trim(),
                prescriber: $('prescriber').value.trim(),
                items: items.map((it) => ({
                    medId: it.medId, name: it.name, strength: it.strength,
                    form: it.form, quantity: it.quantity,
                })),
            };
            const res = await api('/api/rx', { body: payload });
            if (!res.ok) { alert(res.data.message || 'Could not save prescription'); return; }
            savedRxId = res.data.rx.id;
        }

        $('print-area').innerHTML = slipHtml();
        window.print();
        // inputs are kept on purpose — use "New patient" to clear
    };

    // ----- clear for the next patient -----
    $('clearBtn').onclick = () => {
        items.length = 0;
        savedRxId = null;
        ['patient', 'address', 'age', 'sex'].forEach((id) => { $(id).value = ''; });
        render();
    };

    // live-update the preview as patient details are typed
    ['patient', 'prescriber', 'address', 'age', 'sex'].forEach((id) => {
        const el = $(id);
        if (el) el.addEventListener('input', renderPreview);
    });

    render();
})();
