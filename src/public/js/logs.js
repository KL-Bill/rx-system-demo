(async function () {
    const $ = (id) => document.getElementById(id);
    const me = await api('/api/auth/me');
    if (!me.ok) { window.location.href = '/login'; return; }

    mountRail({ mode: 'pharmacy', active: 'logs' });
    $('railUser').textContent = `${me.data.user.name} · ${me.data.user.role}`;
    initDrawer('filtersBtn');

    let list = [], pages = [], currentRx = null;
    const detail = $('detail');
    const contentEl = document.querySelector('.content');

    const fmtDT = (t) => new Date(t).toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit', hour: 'numeric', minute: '2-digit' });
    const reasonBadge = (r) => r === 'not_in_formulary' ? '<span class="badge navy">Not in Formulary</span>'
        : r === 'out_of_stock' ? '<span class="badge amber">No stock</span>'
        : '<span class="badge red">In stock — anomaly</span>';

    // departments
    const st = await api('/api/rx/stations');
    [...new Set((st.data.stations || []).map((s) => s.department))].forEach((d) => {
        const o = document.createElement('option'); o.value = d; o.textContent = d; $('department').appendChild(o);
    });

    // ---------- data ----------
    async function load() {
        const p = new URLSearchParams();
        p.set('department', $('department').value);
        p.set('reason', $('reason').value);
        if ($('from').value) p.set('from', $('from').value);
        if ($('to').value) p.set('to', $('to').value);
        if ($('q').value.trim()) p.set('q', $('q').value.trim());
        const res = await api('/api/pharmacy/prescriptions?' + p.toString());
        if (!res.ok) { window.location.href = '/login'; return; }
        list = res.data.prescriptions;

        $('count').textContent = `${list.length} prescription${list.length === 1 ? '' : 's'}`;
        $('empty').style.display = list.length ? 'none' : 'block';
        $('kp-rx').textContent = list.length;
        $('kp-meds').textContent = list.reduce((s, x) => s + x.items.length, 0);
        $('kp-anom').textContent = list.reduce((s, x) => s + x.items.filter((i) => i.reason === 'normal').length, 0);
        showDetail(false);
        render();
    }

    function render() {
        $('tbl').innerHTML = list.map((p, i) => {
            const reasons = [...new Set(p.items.map((it) => it.reason))];
            return `<tr class="clickable" data-i="${i}">
                <td><b>${fmtDT(p.createdAt)}</b></td>
                <td>${escapeHtml(p.department)}</td>
                <td>${escapeHtml(drName(p.doctor && p.doctor.name) || '—')}</td>
                <td>${escapeHtml(p.patient || '—')}</td>
                <td>${p.items.length}</td>
                <td>${reasons.map(reasonBadge).join(' ')}</td>
            </tr>`;
        }).join('');
        $('tbl').querySelectorAll('tr').forEach((tr) => {
            tr.onclick = () => openDetail(list[Number(tr.dataset.i)], tr);
        });
    }

    // ---------- detail drawer (the actual slip) ----------
    function showDetail(on) {
        detail.classList.toggle('open', on);   // overlays the table; no reflow
        if (on) $('drawer').classList.remove('open');   // one right panel at a time
        else {
            document.querySelectorAll('#tbl tr.selected').forEach((tr) => tr.classList.remove('selected'));
            detail.classList.remove('wide');
        }
    }

    const toRxData = (p) => {
        const d = new Date(p.createdAt);
        return {
            date: d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' }),
            time: d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
            patient: p.patient, address: p.address, age: p.age, sex: p.sex,
            doctor: p.doctor || {},
            meds: p.items.map((it) => ({ label: medLabelOf(it), quantity: it.quantity, cls: reasonCls(it.reason) })),
        };
    };

    function layoutStack() {
        const stack = $('ddStack');
        if (stack.classList.contains('expanded')) return;
        const active = Number(stack.dataset.page || 0);
        pages.forEach((pg, i) => {
            const d = i - active;
            if (d < 0) { pg.style.opacity = '0'; pg.style.zIndex = '0'; pg.style.transform = 'translate(-14px,-8px) scale(.97)'; }
            else {
                pg.style.opacity = d > 2 ? '0' : '1';
                pg.style.zIndex = String(100 - d);
                pg.style.transform = `translate(${d * 12}px, ${d * 9}px) scale(${1 - d * 0.02})`;
            }
        });
        $('ddPg').textContent = `${active + 1} / ${pages.length}`;
    }

    const kv = (k, v) => `<div><div class="k">${k}</div><div class="v">${escapeHtml(v || '—')}</div></div>`;

    function openDetail(p, tr) {
        currentRx = p;
        document.querySelectorAll('#tbl tr.selected').forEach((x) => x.classList.remove('selected'));
        if (tr) tr.classList.add('selected');

        $('ddPatient').textContent = p.patient || 'No patient name';
        $('ddWhen').textContent = `${fmtDT(p.createdAt)} · ${p.department} · ${drName(p.doctor && p.doctor.name) || '—'}`;
        $('ddBadges').innerHTML = [...new Set(p.items.map((i) => i.reason))].map(reasonBadge).join(' ');

        const d = p.doctor || {};
        $('ddGrid').innerHTML =
            kv('Department', p.department) + kv('Doctor', drName(d.name)) +
            kv('License (PRC)', d.license) + kv('PTR / S2', [d.ptr, d.s2].filter(Boolean).join(' / ')) +
            kv('Patient', p.patient) + kv('Age / Sex', [p.age, p.sex].filter(Boolean).join(' / ')) +
            kv('Address', p.address) + kv('Medicines', String(p.items.length));

        // build the real slip pages
        pages = buildSlipPages(toRxData(p));
        const stack = $('ddStack');
        stack.className = 'slip-stack';
        stack.dataset.page = '0';
        stack.innerHTML = '';
        pages.forEach((pg) => stack.appendChild(pg));
        $('ddPager').style.display = pages.length > 1 ? 'inline' : 'none';
        $('ddExpand').textContent = 'Expand';
        layoutStack();

        showDetail(true);
    }

    $('ddPrev').onclick = () => {
        const s = $('ddStack');
        s.dataset.page = String(Math.max(0, Number(s.dataset.page) - 1));
        layoutStack();
    };
    $('ddNext').onclick = () => {
        const s = $('ddStack');
        s.dataset.page = String(Math.min(pages.length - 1, Number(s.dataset.page) + 1));
        layoutStack();
    };
    $('ddExpand').onclick = () => {
        const s = $('ddStack');
        const on = s.classList.toggle('expanded');
        $('ddExpand').textContent = on ? 'Collapse' : 'Expand';
        detail.classList.toggle('wide', on);   // widen the panel to fit pages side by side
        if (!on) layoutStack();
    };
    $('ddPrint').onclick = () => {
        if (!currentRx) return;
        $('print-area').innerHTML = slipPagesHtml(toRxData(currentRx));
        window.print();
    };
    $('ddClose').onclick = () => showDetail(false);
    $('filtersBtn').addEventListener('click', () => showDetail(false));

    // ---------- filters ----------
    ['department', 'reason', 'from', 'to'].forEach((id) => { $(id).onchange = load; });
    let t = null;
    $('q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
    $('refreshBtn').onclick = load;
    $('clearFilters').onclick = () => {
        $('department').value = 'all'; $('reason').value = 'all';
        $('from').value = ''; $('to').value = ''; $('q').value = '';
        load();
    };

    await load();
})();
