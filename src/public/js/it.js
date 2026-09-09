(async function () {
    const $ = (id) => document.getElementById(id);
    const me = await api('/api/auth/me');
    if (!me.ok) { window.location.href = '/login'; return; }
    if (me.data.user.role !== 'it') { window.location.href = '/dashboard'; return; }

    mountRail({ mode: 'it', active: 'it' });
    $('railUser').textContent = `${me.data.user.name} · IT`;

    const PAGE = 50;
    let logOffset = 0, logTotal = 0;

    const fmtDT = (t) => new Date(t).toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit', hour: 'numeric', minute: '2-digit' });
    const fmtSize = (b) => (b == null ? '—' : b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB');
    const fmtUp = (s) => (s >= 86400 ? Math.floor(s / 86400) + 'd ' : '') + Math.floor((s % 86400) / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';

    const EVENT_BADGE = {
        login: ['green', 'Login'],
        login_failed: ['red', 'Login failed'],
        logout: ['gray', 'Logout'],
        rx_created: ['navy', 'Rx printed'],
        user_created: ['navy', 'Account created'],
        password_reset: ['amber', 'Password reset'],
        user_deactivated: ['red', 'Deactivated'],
        user_reactivated: ['green', 'Reactivated'],
        backup_created: ['green', 'Backup taken'],
        backup_downloaded: ['amber', 'Backup downloaded'],
        backup_restored: ['red', 'Backup RESTORED'],
        rx_deleted: ['red', 'Rx DELETED'],
    };
    const eventBadge = (t) => {
        const [color, label] = EVENT_BADGE[t] || ['gray', t];
        return `<span class="badge ${color}">${escapeHtml(label)}</span>`;
    };

    // Accounts is master IT's alone: an IT account made on this page runs the
    // console but never sees who else has a login
    if (!me.data.user.master) {
        const t = document.querySelector('#tabs .tab[data-tab="accounts"]');
        if (t) t.remove();
        $('pane-accounts').remove();
    }

    // ---------- tabs ----------
    document.querySelectorAll('#tabs .tab').forEach((btn) => {
        btn.onclick = () => {
            document.querySelectorAll('#tabs .tab').forEach((b) => b.classList.toggle('active', b === btn));
            document.querySelectorAll('.pane').forEach((p) => { p.style.display = 'none'; });
            $('pane-' + btn.dataset.tab).style.display = '';
            ({
                syslog: loadLogs, audit: loadAudit, accounts: loadUsers,
                prescriptions: loadPrescriptions, backups: loadBackups, medicines: loadMedicines, master: loadMaster,
            })[btn.dataset.tab]();
        };
    });

    // ---------- Medicines: RX Formulary + Bizbox import (js/formulary.js), mounted once ----------
    let importUi = null;
    function loadMedicines() {
        if (!importUi) importUi = RxFormulary.mount($('importRoot'));
    }

    // ---------- doctors & stations ----------
    let doctors = [], stations = [];
    const masterModal = $('masterModalBg');
    // one small form for both lists: title, two fields, optional "fix the past" tick
    function openMaster({ title, aLabel, aValue = '', bLabel, bValue = '', fixText, onSave }) {
        $('mmTitle').textContent = title;
        $('mmALabel').textContent = aLabel; $('mmA').value = aValue;
        $('mmBLabel').textContent = bLabel; $('mmB').value = bValue;
        $('mmFixWrap').style.display = fixText ? '' : 'none';
        if (fixText) { $('mmFixText').textContent = fixText; $('mmFix').checked = true; }
        $('mmErr').textContent = '';
        masterModal.classList.add('show');
        $('mmA').focus();
        $('mmSave').onclick = async () => {
            $('mmErr').textContent = '';
            const err = await onSave({ a: $('mmA').value.trim(), b: $('mmB').value.trim(), fix: !!fixText && $('mmFix').checked });
            if (err) { $('mmErr').textContent = err; return; }
            masterModal.classList.remove('show');
        };
    }

    async function loadMaster() {
        const [d, st] = await Promise.all([api('/api/it/doctors'), api('/api/it/stations')]);
        if (d.ok) doctors = d.data.doctors;
        if (st.ok) stations = st.data.stations;
        renderDoctors(); renderStations();
    }
    function renderDoctors() {
        const q = $('docQ').value.trim().toLowerCase();
        const showRemoved = $('docShowRemoved').checked;
        const list = doctors.filter((x) => (showRemoved || !x.deletedAt) && (!q || `${x.name} ${x.license || ''}`.toLowerCase().includes(q)));
        $('docEmpty').style.display = list.length ? 'none' : 'block';
        $('docTbl').innerHTML = list.map((x) => `
            <tr class="${x.deletedAt ? 'inactive' : ''}">
                <td><b>${escapeHtml(x.name)}</b>${x.deletedAt ? ` <span class="badge red">removed ${fmtDT(x.deletedAt)}</span>` : ''}</td>
                <td class="mono">${escapeHtml(x.license || '')}</td>
                <td>${x.prescriptions}</td>
                <td><div class="row-actions">
                    ${x.deletedAt ? `<button class="green sm" data-restore="${x.id}" type="button">Restore</button>` : `
                    <button class="ghost sm" data-edit="${x.id}" type="button">Edit</button>
                    <button class="danger sm" data-del="${x.id}" type="button">Remove</button>`}
                </div></td>
            </tr>`).join('');
        $('docTbl').querySelectorAll('[data-restore]').forEach((b) => {
            b.onclick = async () => {
                const res = await api(`/api/it/doctors/${b.dataset.restore}/restore`, { body: {} });
                if (!res.ok) await showDialog({ kind: 'danger', title: 'Could not restore', message: res.data.message || 'Try again in a moment.' });
                loadMaster();
            };
        });
        $('docTbl').querySelectorAll('[data-edit]').forEach((b) => {
            b.onclick = () => {
                const x = doctors.find((y) => y.id === b.dataset.edit);
                openMaster({
                    title: 'Edit doctor', aLabel: 'Name', aValue: x.name, bLabel: 'License (PRC) No.', bValue: x.license || '',
                    fixText: `Also fix the ${x.prescriptions} past prescription${x.prescriptions === 1 ? '' : 's'} written under the old name`,
                    onSave: async ({ a, b: lic, fix }) => {
                        const res = await api(`/api/it/doctors/${x.id}`, { body: { name: a, license: lic, fixPast: fix } });
                        if (!res.ok) return res.data.message || 'Could not save';
                        await loadMaster();
                        if (res.data.rewritten) await showDialog({ kind: 'ok', title: 'Doctor updated', message: `${res.data.rewritten} past prescription${res.data.rewritten === 1 ? '' : 's'} now carr${res.data.rewritten === 1 ? 'ies' : 'y'} the corrected name.` });
                        return null;
                    },
                });
            };
        });
        $('docTbl').querySelectorAll('[data-del]').forEach((b) => {
            b.onclick = async () => {
                const x = doctors.find((y) => y.id === b.dataset.del);
                const go = await showDialog({
                    kind: 'warn', title: 'Remove this doctor?',
                    message: `${x.name} will no longer be offered on the nurse page. Past prescriptions keep the name as it was written. You can bring the doctor back with "Show removed".`,
                    actions: [{ label: 'Remove', value: true, variant: 'danger' }, { label: 'Keep', value: false, variant: 'ghost', cancel: true }],
                });
                if (!go) return;
                const res = await api(`/api/it/doctors/${x.id}/delete`, { body: {} });
                if (!res.ok) await showDialog({ kind: 'danger', title: 'Could not remove', message: res.data.message || 'Try again in a moment.' });
                loadMaster();
            };
        });
    }
    function renderStations() {
        $('stTbl').innerHTML = stations.map((x) => `
            <tr>
                <td><b>${escapeHtml(x.name)}</b></td>
                <td>${escapeHtml(x.department)}</td>
                <td class="mono muted">/?station=${escapeHtml(x.id)}</td>
                <td>${x.prescriptions}</td>
                <td><div class="row-actions"><button class="ghost sm" data-edit="${x.id}" type="button">Edit</button></div></td>
            </tr>`).join('');
        $('stTbl').querySelectorAll('[data-edit]').forEach((b) => {
            b.onclick = () => {
                const x = stations.find((y) => y.id === b.dataset.edit);
                openMaster({
                    title: 'Edit station', aLabel: 'Station name', aValue: x.name, bLabel: 'Department', bValue: x.department,
                    fixText: `If the department changes, also move its ${x.prescriptions} past prescription${x.prescriptions === 1 ? '' : 's'} to the new department`,
                    onSave: async ({ a, b: dep, fix }) => {
                        const res = await api(`/api/it/stations/${x.id}`, { body: { name: a, department: dep, fixPast: fix } });
                        if (!res.ok) return res.data.message || 'Could not save';
                        await loadMaster();
                        return null;
                    },
                });
            };
        });
    }
    $('docQ').addEventListener('input', renderDoctors);
    $('docShowRemoved').addEventListener('change', renderDoctors);
    $('newDoctorBtn').onclick = () => openMaster({
        title: 'Add doctor', aLabel: 'Name', bLabel: 'License (PRC) No. (optional)',
        onSave: async ({ a, b }) => {
            const res = await api('/api/it/doctors', { body: { name: a, license: b } });
            if (!res.ok) return res.data.message || 'Could not add';
            await loadMaster(); return null;
        },
    });
    $('newStationBtn').onclick = () => openMaster({
        title: 'Add station', aLabel: 'Station name', bLabel: 'Department',
        onSave: async ({ a, b }) => {
            const res = await api('/api/it/stations', { body: { name: a, department: b } });
            if (!res.ok) return res.data.message || 'Could not add';
            await loadMaster(); return null;
        },
    });

    // ---------- health strip ----------
    async function loadHealth() {
        const res = await api('/api/it/health');
        if (!res.ok) return;
        const h = res.data.health;
        $('kp-db').textContent = h.dbOk ? 'OK' : 'DOWN';
        $('kp-db').classList.toggle('warn', !h.dbOk);
        $('kp-fail').textContent = h.failedLogins24h;
        $('kp-fail').classList.toggle('warn', h.failedLogins24h > 0);
        $('kp-users').textContent = h.users;
        $('kp-up').textContent = fmtUp(h.uptimeSec);
    }

    // ---------- system log ----------
    async function loadLogs() {
        const p = new URLSearchParams({ limit: PAGE, offset: logOffset });
        if ($('type').value) p.set('type', $('type').value);
        if ($('q').value.trim()) p.set('q', $('q').value.trim());
        if ($('from').value) p.set('from', new Date($('from').value).getTime());
        if ($('to').value) p.set('to', new Date($('to').value).getTime() + 86399999); // include the whole "to" day
        const res = await api('/api/it/logs?' + p.toString());
        if (!res.ok) return;

        logTotal = res.data.total;
        const rows = res.data.rows;
        $('logCount').textContent = `${logTotal} event${logTotal === 1 ? '' : 's'}`;
        $('logEmpty').style.display = rows.length ? 'none' : 'block';
        $('logTbl').innerHTML = rows.map((r) => `
            <tr>
                <td>${fmtDT(r.at)}</td>
                <td>${eventBadge(r.type)}</td>
                <td>${escapeHtml(r.actor || '—')}${r.role ? ` <span class="badge gray">${escapeHtml(r.role)}</span>` : ''}</td>
                <td>${escapeHtml(r.target || '—')}</td>
                <td class="mono">${escapeHtml(r.ip || '—')}</td>
                <td class="mono">${r.details ? escapeHtml(Object.entries(r.details).map(([k, v]) => `${k}: ${v}`).join(' · ')) : ''}</td>
            </tr>`).join('');

        const pgTotal = Math.max(1, Math.ceil(logTotal / PAGE));
        $('pgInfo').textContent = `page ${Math.floor(logOffset / PAGE) + 1} of ${pgTotal}`;
        $('prevPg').disabled = logOffset === 0;
        $('nextPg').disabled = logOffset + PAGE >= logTotal;
    }
    $('refreshLog').onclick = () => { logOffset = 0; loadLogs(); };
    $('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { logOffset = 0; loadLogs(); } });
    ['type', 'from', 'to'].forEach((id) => { $(id).onchange = () => { logOffset = 0; loadLogs(); }; });
    $('prevPg').onclick = () => { logOffset = Math.max(0, logOffset - PAGE); loadLogs(); };
    $('nextPg').onclick = () => { logOffset += PAGE; loadLogs(); };

    // ---------- pharmacy audit ----------
    async function loadAudit() {
        const res = await api('/api/it/audit');
        if (!res.ok) return;
        const rows = res.data.audit;
        $('auditEmpty').style.display = rows.length ? 'none' : 'block';
        $('auditTbl').innerHTML = rows.map((r) => `
            <tr>
                <td>${fmtDT(r.at)}</td>
                <td>${escapeHtml(r.action || '—')}</td>
                <td>${escapeHtml(r.drug || '—')}</td>
                <td>${escapeHtml(r.reason || '—')}</td>
                <td>${escapeHtml(r.status || '—')}</td>
                <td>${escapeHtml(r.actor || '—')}</td>
                <td>${escapeHtml(r.authorizedBy || '—')}</td>
            </tr>`).join('');
    }

    // ---------- accounts ----------
    async function loadUsers() {
        const res = await api('/api/it/users');
        if (!res.ok) return;
        $('userTbl').innerHTML = res.data.users.map((u) => {
            // your own account: reset the password, but no deactivate button —
            // the server refuses it anyway, this just keeps the trap out of sight
            const self = u.id === me.data.user.id;
            const actions = `
                <button class="ghost sm" data-act="pw" data-id="${u.id}" data-name="${escapeHtml(u.username)}" type="button">Reset password</button>
                ${self ? '<span class="badge gray">you</span>' : `<button class="${u.active ? 'danger' : 'green'} sm" data-act="active" data-id="${u.id}" data-to="${!u.active}" type="button">
                    ${u.active ? 'Deactivate' : 'Reactivate'}</button>`}`;
            return `
            <tr class="${u.active ? '' : 'inactive'}">
                <td>${escapeHtml(u.name)}</td>
                <td>${escapeHtml(u.username)}</td>
                <td><span class="badge ${u.role === 'admin' ? 'navy' : u.role === 'it' ? 'green' : 'gray'}">${escapeHtml(u.role)}</span>${u.role === 'it' ? (u.master ? ' <span class="badge gray" title="Made at the server console; manages accounts">master</span>' : ' <span class="badge gray" title="Made on this page; cannot manage accounts">no account access</span>') : ''}</td>
                <td>${u.active ? '<span class="badge green">active</span>' : '<span class="badge red">deactivated</span>'}</td>
                <td><div class="row-actions">${actions}</div></td>
            </tr>`;
        }).join('');

        $('userTbl').querySelectorAll('button[data-act]').forEach((b) => {
            if (b.dataset.act === 'pw') b.onclick = () => openPwModal(b.dataset.id, b.dataset.name);
            else b.onclick = async () => {
                const res = await api(`/api/it/users/${b.dataset.id}/active`, { body: { active: b.dataset.to === 'true' } });
                if (!res.ok) {
                    await showDialog({
                        kind: 'danger', title: 'Could not update the account',
                        message: res.data.message || 'The account was left as it was. Try again in a moment.',
                    });
                }
                loadUsers(); loadHealth();
            };
        });
    }

    // new-account modal
    const userModal = $('userModalBg');
    $('newUserBtn').onclick = () => {
        ['uName', 'uUsername', 'uPassword'].forEach((id) => { $(id).value = ''; });
        $('uRole').value = 'staff';
        $('userErr').textContent = '';
        userModal.classList.add('show');
    };
    $('createUserBtn').onclick = async () => {
        $('userErr').textContent = '';
        const res = await api('/api/it/users', {
            body: { name: $('uName').value, username: $('uUsername').value, password: $('uPassword').value, role: $('uRole').value },
        });
        if (!res.ok) { $('userErr').textContent = res.data.message || 'Failed to create the account'; return; }
        userModal.classList.remove('show');
        loadUsers(); loadHealth();
    };

    // reset-password modal
    const pwModal = $('pwModalBg');
    let pwUserId = null;
    function openPwModal(id, username) {
        pwUserId = id;
        $('pwWho').textContent = `Set a new password for "${username}". They should change it after logging in.`;
        $('pwNew').value = '';
        $('pwErr').textContent = '';
        pwModal.classList.add('show');
    }
    $('resetPwBtn').onclick = async () => {
        $('pwErr').textContent = '';
        const res = await api(`/api/it/users/${pwUserId}/reset-password`, { body: { password: $('pwNew').value } });
        if (!res.ok) { $('pwErr').textContent = res.data.message || 'Failed to reset the password'; return; }
        pwModal.classList.remove('show');
    };

    document.querySelectorAll('.modal-bg [data-close]').forEach((b) => {
        b.onclick = () => b.closest('.modal-bg').classList.remove('show');
    });

    // ---------- prescriptions ----------
    // Selection is kept in a Set of ids, not read off the checkboxes, so it
    // survives paging — tick rows on page 1, page forward, come back, still
    // ticked. "Select all" only covers the page you can see; wiping a whole
    // test period is what "Delete all in range" is for.
    let rxOffset = 0, rxTotal = 0, rxRows = [];
    const rxPicked = new Set();

    const rxRange = () => ({ from: $('rxFrom').value, to: $('rxTo').value });

    function rxSyncButtons() {
        const { from, to } = rxRange();
        $('rxDelSel').disabled = rxPicked.size === 0;
        $('rxDelSel').textContent = rxPicked.size ? `Delete selected (${rxPicked.size})` : 'Delete selected';
        // deleting "everything, no filter" is not something to offer behind a
        // single click — a range has to be set first
        $('rxDelRange').disabled = !(from || to) || rxTotal === 0;
        $('rxDelRange').textContent = (from || to) && rxTotal ? `Delete all in range (${rxTotal})` : 'Delete all in range';
        const boxes = [...$('rxTbl').querySelectorAll('input[data-rx]')];
        $('rxAll').checked = boxes.length > 0 && boxes.every((b) => b.checked);
    }

    const rxView = () => $('rxView').value;          // 'live' | 'deleted'
    function syncRestore() {
        const del = rxView() === 'deleted';
        $('rxRestoreSel').style.display = del ? '' : 'none';
        $('rxDelSel').style.display = del ? 'none' : '';
        $('rxDelRange').style.display = del ? 'none' : '';
        $('rxDelHead').style.display = del ? '' : 'none';
        $('rxRestoreSel').disabled = !rxPicked.size;
    }
    async function loadPrescriptions() {
        const { from, to } = rxRange();
        const p = new URLSearchParams({ limit: PAGE, offset: rxOffset, deleted: rxView() === 'deleted' ? 'only' : 'no' });
        if (from) p.set('from', from);
        if (to) p.set('to', to);
        const res = await api('/api/it/prescriptions?' + p.toString());
        if (!res.ok) return;

        rxTotal = res.data.total;
        rxRows = res.data.prescriptions;
        $('rxCount').textContent = `${rxTotal} prescription${rxTotal === 1 ? '' : 's'}`;
        $('rxEmpty').style.display = rxRows.length ? 'none' : 'block';
        $('rxTbl').innerHTML = rxRows.map((r) => `
            <tr>
                <td><input type="checkbox" data-rx="${escapeHtml(r.id)}" ${rxPicked.has(r.id) ? 'checked' : ''}></td>
                <td>${fmtDT(r.createdAt)}</td>
                <td>${escapeHtml(r.station || '—')}</td>
                <td>${escapeHtml(r.department || '—')}</td>
                <td>${escapeHtml(drName(r.doctor) || '—')}</td>
                <td>${r.meds}</td>
                ${rxView() === 'deleted' ? `<td class="muted">${fmtDT(r.deletedAt)}${r.deletedBy ? ` · ${escapeHtml(r.deletedBy)}` : ''}</td>` : ''}
            </tr>`).join('');

        $('rxTbl').querySelectorAll('input[data-rx]').forEach((cb) => {
            cb.onchange = () => {
                if (cb.checked) rxPicked.add(cb.dataset.rx); else rxPicked.delete(cb.dataset.rx);
                rxSyncButtons(); syncRestore();
            };
        });

        const pgTotal = Math.max(1, Math.ceil(rxTotal / PAGE));
        $('rxPgInfo').textContent = `page ${Math.floor(rxOffset / PAGE) + 1} of ${pgTotal}`;
        $('rxPrev').disabled = rxOffset === 0;
        $('rxNext').disabled = rxOffset + PAGE >= rxTotal;
        rxSyncButtons(); syncRestore();
    }
    $('rxView').onchange = () => { rxOffset = 0; rxPicked.clear(); loadPrescriptions(); };
    $('rxRestoreSel').onclick = async () => {
        const res = await api('/api/it/prescriptions/restore', { body: { ids: [...rxPicked] } });
        if (!res.ok) { await showDialog({ kind: 'danger', title: 'Could not restore', message: res.data.message || 'Try again in a moment.' }); return; }
        rxPicked.clear(); loadPrescriptions(); loadHealth();
    };

    $('rxAll').onchange = () => {
        $('rxTbl').querySelectorAll('input[data-rx]').forEach((cb) => {
            cb.checked = $('rxAll').checked;
            if (cb.checked) rxPicked.add(cb.dataset.rx); else rxPicked.delete(cb.dataset.rx);
        });
        rxSyncButtons(); syncRestore();
    };
    $('rxRefresh').onclick = () => { rxOffset = 0; rxPicked.clear(); loadPrescriptions(); };
    $('rxClear').onclick = () => {
        $('rxFrom').value = ''; $('rxTo').value = '';
        rxOffset = 0; rxPicked.clear(); loadPrescriptions();
    };
    ['rxFrom', 'rxTo'].forEach((id) => { $(id).onchange = () => { rxOffset = 0; rxPicked.clear(); loadPrescriptions(); }; });
    $('rxPrev').onclick = () => { rxOffset = Math.max(0, rxOffset - PAGE); loadPrescriptions(); };
    $('rxNext').onclick = () => { rxOffset += PAGE; loadPrescriptions(); };

    // delete modal — mode is 'selection' or 'range'
    const rxDelModal = $('rxDelModalBg');
    let rxDelMode = 'selection';
    function openRxDelModal(mode) {
        rxDelMode = mode;
        const { from, to } = rxRange();
        const n = mode === 'selection' ? rxPicked.size : rxTotal;
        $('rxDelWhat').textContent = mode === 'selection'
            ? `This deletes the ${n} prescription(s) you ticked.`
            : `This deletes all ${n} prescription(s) from ${from || 'the beginning'} to ${to || 'now'} — every page, not just this one.`;
        $('rxDelCount').textContent = String(n);
        $('rxDelConfirm').value = '';
        $('rxDelPassword').value = '';
        $('rxDelErr').textContent = '';
        rxDelModal.classList.add('show');
    }
    $('rxDelSel').onclick = () => openRxDelModal('selection');
    $('rxDelRange').onclick = () => openRxDelModal('range');

    $('rxDelBtn').onclick = async () => {
        $('rxDelErr').textContent = '';
        const { from, to } = rxRange();
        const body = {
            confirm: $('rxDelConfirm').value,
            password: $('rxDelPassword').value,
            ...(rxDelMode === 'selection' ? { ids: [...rxPicked] } : { from, to }),
        };
        $('rxDelBtn').disabled = true;
        const res = await api('/api/it/prescriptions/delete', { body });
        $('rxDelBtn').disabled = false;
        if (!res.ok) { $('rxDelErr').textContent = res.data.message || 'Delete failed'; return; }

        rxDelModal.classList.remove('show');
        rxPicked.clear();
        rxOffset = 0;
        loadPrescriptions(); loadHealth();
    };

    // ---------- backups ----------
    // pg_dump on a real database is not instant, so the button locks and says
    // so — a second click while the first is still running would start a
    // competing dump and register a second row.
    $('backupNow').onclick = async () => {
        const btn = $('backupNow'), msg = $('backupNowMsg');
        btn.disabled = true;
        btn.textContent = 'Backing up…';
        msg.textContent = 'Dumping the database — this can take a moment on a large one.';
        msg.className = 'sub';

        const res = await api('/api/it/backups', { method: 'POST' });

        btn.disabled = false;
        btn.textContent = 'Back up now';
        if (!res.ok) {
            msg.textContent = res.data.message || 'Backup failed.';
            msg.className = 'sub err show';
        } else {
            msg.textContent = `✓ ${res.data.file} — ${fmtSize(res.data.sizeBytes)} in ${Math.max(1, Math.round(res.data.durationMs / 1000))}s`;
            msg.className = 'sub';
        }
        loadBackups();
    };

    async function loadBackups() {
        const res = await api('/api/it/backups');
        if (!res.ok) return;
        const { backups, lastOkAt, stale } = res.data;

        $('backupStatus').innerHTML = stale
            ? `<div class="bk-stale">⚠ ${lastOkAt
                ? `Last successful backup was ${fmtDT(lastOkAt)} — more than 13 hours ago. The rx-system-backup scheduled task on the host may have stopped; check Task Scheduler.`
                : 'No successful backup has ever been recorded. Check the rx-system-backup scheduled task on the host.'}</div>`
            : `<div class="bk-ok">✓ Last successful backup: ${fmtDT(lastOkAt)} (runs every 12 h, 7-day retention on the host).</div>`;

        $('backupEmpty').style.display = backups.length ? 'none' : 'block';
        $('backupTbl').innerHTML = backups.map((b) => {
            // a plain link, not fetch() — lets the browser stream a large .sql
            // straight to disk with its own progress/save dialog
            const action = b.downloadable
                ? `<a class="btn-link" href="/api/it/backups/${encodeURIComponent(b.file)}/download">Download</a>
                   <button class="danger sm" data-restore="${escapeHtml(b.file)}" data-at="${b.at}" type="button">Restore</button>`
                : `<span class="muted" title="Not on the server anymore — it may have passed the 7-day retention window.">—</span>`;
            return `
            <tr>
                <td>${fmtDT(b.at)}</td>
                <td class="mono">${escapeHtml(b.file)}</td>
                <td>${fmtSize(b.sizeBytes)}</td>
                <td>${b.durationMs == null ? '—' : (b.durationMs / 1000).toFixed(1) + 's'}</td>
                <td>${b.status === 'ok' ? '<span class="badge green">ok</span>' : '<span class="badge red">failed</span>'}</td>
                <td><div class="row-actions">${action}</div></td>
            </tr>`;
        }).join('');

        $('backupTbl').querySelectorAll('button[data-restore]').forEach((b) => {
            b.onclick = () => openRestoreModal(b.dataset.restore, Number(b.dataset.at));
        });
    }

    // ---------- restore ----------
    const restoreModal = $('restoreModalBg');
    let restoreFile = null;

    function openRestoreModal(file, at) {
        restoreFile = file;
        $('rsFile').textContent = file;
        $('rsLoss').textContent = `Everything recorded since ${fmtDT(at)} — prescriptions, accounts, logs — will be lost.`;
        $('rsConfirm').value = '';
        $('rsPassword').value = '';
        $('rsErr').textContent = '';
        restoreModal.classList.add('show');
    }

    $('restoreBtn').onclick = async () => {
        const btn = $('restoreBtn');
        $('rsErr').textContent = '';
        // a big database takes a while to dump + reload; don't let a second
        // click fire a concurrent restore
        btn.disabled = true;
        btn.textContent = 'Restoring…';
        const res = await api(`/api/it/backups/${encodeURIComponent(restoreFile)}/restore`, {
            body: { confirm: $('rsConfirm').value.trim(), password: $('rsPassword').value },
        });
        btn.disabled = false;
        btn.textContent = 'Restore database';

        if (!res.ok) { $('rsErr').textContent = res.data.message || 'Restore failed'; return; }
        restoreModal.classList.remove('show');
        // One of the few things in this app that earns a modal: it is
        // consequential, one-way, and names a filename worth reading before it
        // scrolls away. A toast that fades on its own is the wrong shape for it.
        await showDialog({
            kind: 'ok',
            title: 'Database restored',
            message: `Restored from ${res.data.restored}.\n\nA safety backup of the previous data was saved as:`,
            detail: res.data.safetyBackup,
            actions: [{ label: 'Reload console', value: 'ok', variant: 'primary' }],
        });
        // the restored database may not contain this IT account at all, so the
        // console reloads either way — that lands on /login if the session is
        // no longer valid
        window.location.reload();
    };

    loadHealth();
    loadLogs();
})();
