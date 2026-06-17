(async function () {
    const $ = (id) => document.getElementById(id);

    // ----- auth gate -----
    const me = await api('/api/auth/me');
    if (!me.ok) { window.location.href = '/login'; return; }
    const user = me.data.user;
    const isStaff = user.role === 'staff';
    $('whoami').textContent = `${user.name} · ${user.role}`;

    $('logout').onclick = async () => { await api('/api/auth/logout', { body: {} }); window.location.href = '/'; };

    let currentStation = ''; // '' = overall
    let stations = [];

    // ----- station chips -----
    function renderChips() {
        const chips = [{ id: '', name: 'Overall' }, ...stations];
        $('chips').innerHTML = chips.map((s) =>
            `<div class="chip ${s.id === currentStation ? 'active' : ''}" data-id="${s.id}">${escapeHtml(s.name)}</div>`
        ).join('');
        $('chips').querySelectorAll('.chip').forEach((c) => {
            c.onclick = () => { currentStation = c.dataset.id; load(); };
        });
    }

    // ----- load + render dashboard -----
    async function load() {
        const q = currentStation ? '?station=' + encodeURIComponent(currentStation) : '';
        const res = await api('/api/dashboard' + q);
        if (!res.ok) { window.location.href = '/login'; return; }
        const d = res.data.data;

        stations = d.stations;
        renderChips();
        $('scopeLabel').textContent = d.scope ? '— ' + d.scope.name : '— Overall';

        $('kp-rx').textContent = d.totals.prescriptions;
        $('kp-items').textContent = d.totals.itemsPrescribed;
        $('kp-pending').textContent = d.totals.pendingReview;
        $('kp-low').textContent = d.totals.lowStockCount;

        // pending review
        $('empty-pending').style.display = d.mostInDemandNotInDb.length ? 'none' : 'block';
        $('tbl-pending').innerHTML = d.mostInDemandNotInDb.map((m) => `
            <tr>
                <td>${escapeHtml(m.name)} <span class="muted">${escapeHtml(m.strength)} ${escapeHtml(m.form)}</span></td>
                <td>${m.demand}</td>
                <td>${m.qty}</td>
                <td class="muted">${escapeHtml((m.departments || []).join(', ') || '—')}</td>
                <td><span class="badge red">${m.score}</span></td>
                <td><button class="sm" data-review="${m.id}">Review</button></td>
            </tr>`).join('');

        // priority
        $('tbl-priority').innerHTML = d.priority.map((m) => `
            <tr>
                <td>${escapeHtml(m.name)} <span class="muted">${escapeHtml(m.strength)}</span></td>
                <td>${m.inDatabase ? '<span class="badge green">yes</span>' : '<span class="badge amber">no</span>'}</td>
                <td>${m.stock == null ? '—' : m.stock}</td>
                <td>${m.demand}</td>
                <td>${m.unmet}</td>
                <td>${fulfillBadge(m.fulfillment)}</td>
                <td><b>${m.score}</b></td>
            </tr>`).join('');

        // low stock
        $('empty-low').style.display = d.lowStock.length ? 'none' : 'block';
        $('tbl-low').innerHTML = d.lowStock.map((m) => `
            <tr>
                <td>${escapeHtml(m.name)} <span class="muted">${escapeHtml(m.strength)}</span></td>
                <td><span class="badge ${m.stock <= 5 ? 'red' : 'amber'}">${m.stock}</span></td>
                <td>${m.demand}</td>
                <td>${fulfillBadge(m.fulfillment)}</td>
                <td><button class="sm ghost" data-edit="${m.id}">Edit stock</button></td>
            </tr>`).join('');

        wireRowButtons(d);
    }

    function fulfillBadge(pct) {
        const cls = pct >= 80 ? 'green' : pct >= 50 ? 'amber' : 'red';
        return `<span class="badge ${cls}">${pct}%</span>`;
    }

    // ----- review / edit modal -----
    const modal = $('reviewModal');
    let editingId = null;
    let mode = 'confirm'; // 'confirm' (pending med) or 'edit' (existing)

    function wireRowButtons(d) {
        document.querySelectorAll('[data-review]').forEach((b) => {
            b.onclick = () => {
                const m = d.mostInDemandNotInDb.find((x) => x.id === b.dataset.review);
                openModal('confirm', m);
            };
        });
        document.querySelectorAll('[data-edit]').forEach((b) => {
            b.onclick = () => {
                const m = d.lowStock.find((x) => x.id === b.dataset.edit);
                openModal('edit', m);
            };
        });
    }

    function openModal(m, med) {
        mode = m;
        editingId = med.id;
        $('rmTitle').textContent = m === 'confirm' ? 'Confirm new medicine' : 'Edit medicine';
        $('rmSub').textContent = m === 'confirm'
            ? 'Check the details, set the starting stock, then add it to the database.'
            : 'Update the medicine details.';
        $('rmSave').textContent = m === 'confirm' ? 'Confirm & add to database' : 'Save changes';
        $('rmName').value = med.name || '';
        $('rmStrength').value = med.strength || '';
        $('rmForm').value = med.form || '';
        $('rmStock').value = med.stock == null ? '' : med.stock;
        $('rmAuthWrap').style.display = isStaff ? 'block' : 'none';
        $('rmAuth').value = '';
        $('rmErr').classList.remove('show');
        modal.classList.add('show');
    }

    $('rmCancel').onclick = () => modal.classList.remove('show');

    $('rmSave').onclick = async () => {
        const body = {
            name: $('rmName').value.trim(),
            strength: $('rmStrength').value.trim(),
            form: $('rmForm').value.trim(),
            stock: $('rmStock').value,
        };
        if (isStaff) body.authorizerPassword = $('rmAuth').value;

        const url = mode === 'confirm'
            ? `/api/pharmacy/meds/${editingId}/confirm`
            : `/api/pharmacy/meds/${editingId}`;
        const res = await api(url, { method: mode === 'confirm' ? 'POST' : 'PUT', body });

        if (res.ok) { modal.classList.remove('show'); load(); }
        else { $('rmErr').textContent = res.data.message || 'Could not save'; $('rmErr').classList.add('show'); }
    };

    await load();
})();
