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
        backup_downloaded: ['amber', 'Backup downloaded'],
        backup_restored: ['red', 'Backup RESTORED'],
        rx_deleted: ['red', 'Rx DELETED'],
    };
    const eventBadge = (t) => {
        const [color, label] = EVENT_BADGE[t] || ['gray', t];
        return `<span class="badge ${color}">${escapeHtml(label)}</span>`;
    };

    // ---------- tabs ----------
    document.querySelectorAll('#tabs .tab').forEach((btn) => {
        btn.onclick = () => {
            document.querySelectorAll('#tabs .tab').forEach((b) => b.classList.toggle('active', b === btn));
            document.querySelectorAll('.pane').forEach((p) => { p.style.display = 'none'; });
            $('pane-' + btn.dataset.tab).style.display = '';
            ({
                syslog: loadLogs, audit: loadAudit, accounts: loadUsers,
                prescriptions: loadPrescriptions, backups: loadBackups,
            })[btn.dataset.tab]();
        };
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
            const isIt = u.role === 'it';
            const actions = isIt ? '<span class="badge gray">console-managed</span>' : `
                <button class="ghost sm" data-act="pw" data-id="${u.id}" data-name="${escapeHtml(u.username)}" type="button">Reset password</button>
                <button class="${u.active ? 'danger' : 'green'} sm" data-act="active" data-id="${u.id}" data-to="${!u.active}" type="button">
                    ${u.active ? 'Deactivate' : 'Reactivate'}</button>`;
            return `
            <tr class="${u.active ? '' : 'inactive'}">
                <td>${escapeHtml(u.name)}</td>
                <td>${escapeHtml(u.username)}</td>
                <td><span class="badge ${u.role === 'admin' ? 'navy' : 'gray'}">${escapeHtml(u.role)}</span></td>
                <td>${u.active ? '<span class="badge green">active</span>' : '<span class="badge red">deactivated</span>'}</td>
                <td><div class="row-actions">${actions}</div></td>
            </tr>`;
        }).join('');

        $('userTbl').querySelectorAll('button[data-act]').forEach((b) => {
            if (b.dataset.act === 'pw') b.onclick = () => openPwModal(b.dataset.id, b.dataset.name);
            else b.onclick = async () => {
                const res = await api(`/api/it/users/${b.dataset.id}/active`, { body: { active: b.dataset.to === 'true' } });
                if (!res.ok) alert(res.data.message || 'Failed');
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

    async function loadPrescriptions() {
        const { from, to } = rxRange();
        const p = new URLSearchParams({ limit: PAGE, offset: rxOffset });
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
            </tr>`).join('');

        $('rxTbl').querySelectorAll('input[data-rx]').forEach((cb) => {
            cb.onchange = () => {
                if (cb.checked) rxPicked.add(cb.dataset.rx); else rxPicked.delete(cb.dataset.rx);
                rxSyncButtons();
            };
        });

        const pgTotal = Math.max(1, Math.ceil(rxTotal / PAGE));
        $('rxPgInfo').textContent = `page ${Math.floor(rxOffset / PAGE) + 1} of ${pgTotal}`;
        $('rxPrev').disabled = rxOffset === 0;
        $('rxNext').disabled = rxOffset + PAGE >= rxTotal;
        rxSyncButtons();
    }

    $('rxAll').onchange = () => {
        $('rxTbl').querySelectorAll('input[data-rx]').forEach((cb) => {
            cb.checked = $('rxAll').checked;
            if (cb.checked) rxPicked.add(cb.dataset.rx); else rxPicked.delete(cb.dataset.rx);
        });
        rxSyncButtons();
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
            ? `This permanently deletes the ${n} prescription(s) you ticked.`
            : `This permanently deletes all ${n} prescription(s) from ${from || 'the beginning'} to ${to || 'now'} — every page, not just this one.`;
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
        alert(`Database restored from ${res.data.restored}.\n\nA safety backup of the previous data was saved as:\n${res.data.safetyBackup}`);
        // the restored database may not contain this IT account at all — a
        // reload lands on /login if the session is no longer valid
        window.location.reload();
    };

    loadHealth();
    loadLogs();
})();
