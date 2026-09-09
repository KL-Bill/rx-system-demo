/* Bizbox import — the whole flow in one component, mounted on the IT console
 * (Medicines tab) and on the pharmacy head's Medicines page.
 *
 *   BizboxImport.mount(rootElement)
 *
 * Upload -> pick the two columns -> Analyzing (live progress) -> one review
 * screen with four plain groups -> Applying (live progress) -> Result. The
 * job lives on the server; this page only polls it, so a refresh — or another
 * person opening the same import — lands on the same step.
 *
 * The four groups, in the reviewer's words:
 *   Needs your decision   the import could not settle these on its own
 *   New medicines         will be added and marked In Bizbox
 *   Now marked In Bizbox  exist in the list, will be marked (spelling aside)
 *   Already In Bizbox     nothing to do
 * Blank, duplicate and remembered lines are a footnote.
 */
(function (global) {
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmtDT = (t) => (t ? new Date(t).toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit', hour: 'numeric', minute: '2-digit' }) : '');

    const GROUPS = [
        ['decide', 'Needs your decision', 'The import could not settle these. Each says why. Choose Same, New, or Skip.', 'decide'],
        ['new', 'New medicines', 'Not in the list yet. Each will be added and marked In Bizbox.', ''],
        ['marked', 'Now marked In Bizbox', 'Already in the list under another spelling or not yet marked. Each will be marked In Bizbox.', ''],
        ['unchanged', 'Already In Bizbox', 'Already in the list and marked. Nothing changes except the Bizbox wording.', ''],
    ];
    const DONE_LABEL = { decide: 'Decided', new: 'Added', marked: 'Marked In Bizbox', unchanged: 'Already In Bizbox' };
    const STATUS_LABEL = { uploaded: 'Waiting for columns', analyzing: 'Analyzing', awaiting_review: 'Awaiting review', applying: 'Applying', done: 'Done', cancelled: 'Cancelled', failed: 'Failed' };
    const STATUS_TONE = { done: 'green', awaiting_review: 'amber', analyzing: 'navy', applying: 'navy', failed: 'red', cancelled: 'gray', uploaded: 'gray' };
    const WARN_TEXT = {
        'no generic': 'No generic given — type one, or skip',
        'no form': 'Could not tell the form',
        'no strength': 'Could not find a strength',
        'digit in brand': 'The brand has numbers in it — check the split',
        'long brand': 'The brand looks too long — check the split',
        'nothing recognised': 'Nothing recognisable — probably not a medicine',
        'no form or strength': 'Needs at least a form or a strength',
    };

    // which group a row belongs to, from its current decision
    const groupOf = (r) => {
        if (r.excluded || r.category === 'excluded') return 'excluded';
        if (r.action === 'review') return 'decide';
        if (r.action === 'skip') return r.category === 'unchanged' ? 'unchanged' : 'skipped';
        if (r.action === 'new') return 'new';
        return 'marked';                                    // flag | same
    };
    const productText = (p) => (p ? (p.description || [p.brand, p.strength, p.form].filter(Boolean).join(' ')) : '');
    const ownText = (r) => [r.brand, r.strength, r.form].filter(Boolean).join(' ');
    // why a row landed in "Needs your decision", in plain words
    const reasonText = (r) => {
        if (r.match && r.category === 'same') return `Looks like an existing product — same medicine?`;
        const w = (r.warnings || []).map((x) => WARN_TEXT[x] || x);
        return w.length ? w.join('. ') : 'Please check this one';
    };

    function mount(root) {
        let job = null;          // the import being worked on (summary only)
        let items = null;        // its rows, when in review / done
        let group = 'decide';
        let poll = null;
        let pendingDecisions = new Map();   // i -> decision, flushed on a timer
        let flushT = null;
        let filter = '';

        root.classList.add('imp');
        root.innerHTML = `
            <div class="imp-main" id="impMain"></div>
            <div class="imp-history">
                <div class="imp-h"><h3>Import history</h3><button class="ghost sm" id="impRefresh" type="button">Refresh</button></div>
                <div id="impHistory" class="muted">Loading…</div>
            </div>`;
        const main = root.querySelector('#impMain');
        root.querySelector('#impRefresh').onclick = loadHistory;

        // ---------- history ----------
        async function loadHistory() {
            const res = await api('/api/import');
            const host = root.querySelector('#impHistory');
            if (!res.ok) { host.textContent = 'Could not load the history.'; return; }
            const list = res.data.imports || [];
            if (!list.length) { host.innerHTML = '<div class="muted">No imports yet.</div>'; return; }
            host.innerHTML = `<table class="dense"><thead><tr><th>When</th><th>File</th><th>By</th><th>Status</th><th>Rows</th><th>Outcome</th><th></th></tr></thead><tbody>${list.map((j) => {
                const r = j.summary.result;
                const c = j.summary.counts;
                const out = r ? `added ${r.created} · marked ${r.flagged + r.linked} · already in Bizbox ${r.unchanged}${j.summary.missingCount ? ` · <span class="muted">${j.summary.missingCount} not in file</span>` : ''}`
                    : c ? `to decide ${(c.attention || 0) + (c.same || 0)} · new ${(c.new || 0) + (c.similar || 0)} · to mark ${c.flag || 0}` : (j.summary.error ? `<span class="muted">${esc(j.summary.error)}</span>` : '');
                return `<tr><td>${fmtDT(j.startedAt)}</td><td class="mono">${esc(j.file)}</td><td>${esc(j.uploadedBy || '')}</td><td><span class="badge ${STATUS_TONE[j.status] || 'gray'}">${STATUS_LABEL[j.status] || j.status}</span></td><td>${j.total || j.summary.rowCount || ''}</td><td class="muted" style="font-size:12px">${out}</td><td class="row-actions"><button class="ghost sm" data-open="${j.id}" type="button">${j.status === 'awaiting_review' ? 'Continue' : 'Open'}</button></td></tr>`;
            }).join('')}</tbody></table>`;
            host.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => open(b.dataset.open); });
        }

        // ---------- upload ----------
        function renderUpload() {
            stopPoll(); job = null; items = null;
            main.innerHTML = `
                <div class="card imp-card">
                    <h2>Import from Bizbox</h2>
                    <p class="sub">Upload the Bizbox medicine export (.xlsx or .csv, two columns: generic and description). Nothing is changed until you review and press Apply.</p>
                    <label class="imp-drop" id="impDrop">
                        <input type="file" id="impFile" accept=".xlsx,.csv" hidden>
                        <div><b>Choose the export file</b><div class="muted" style="font-size:12.5px">or drop it here</div></div>
                    </label>
                    <div class="errbox" id="impErr"></div>
                </div>`;
            const input = main.querySelector('#impFile'), drop = main.querySelector('#impDrop');
            input.onchange = () => { if (input.files[0]) uploadFile(input.files[0]); };
            drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
            drop.ondragleave = () => drop.classList.remove('over');
            drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) uploadFile(f); };
        }
        const err = (id, msg) => { const e = main.querySelector('#' + id); if (e) { e.textContent = msg; e.classList.add('show'); } };

        async function uploadFile(file) {
            const drop = main.querySelector('#impDrop');
            drop.innerHTML = `<div><b>Uploading ${esc(file.name)}…</b></div>`;
            const res = await fetch(`/api/import/upload?name=${encodeURIComponent(file.name)}`, {
                method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
            });
            let data = {}; try { data = await res.json(); } catch { /* no body */ }
            if (!res.ok) { renderUpload(); err('impErr', data.message || 'Upload failed'); return; }
            renderColumns(data);
        }

        // ---------- columns ----------
        function renderColumns(up) {
            const opts = (sel) => up.headers.map((h, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${esc(h)}</option>`).join('');
            main.innerHTML = `
                <div class="card imp-card">
                    <h2>Which column is which?</h2>
                    <p class="sub"><b>${esc(up.rowCount)}</b> rows in the file. Confirm the generic column and the description column, then analyze.</p>
                    <div class="mb-row">
                        <div class="search-wrap"><label>Generic column</label><select id="impGen">${opts(up.guess.genericCol)}</select></div>
                        <div class="search-wrap"><label>Description column (brand / strength / form)</label><select id="impDesc">${opts(up.guess.descCol)}</select></div>
                    </div>
                    ${up.sample.length ? `<div class="tbl-wrap" style="margin-top:12px"><table class="dense imp-sample"><thead><tr>${up.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${up.sample.map((r) => `<tr>${up.headers.map((_, i) => `<td>${esc(r[i] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : ''}
                    <div class="errbox" id="impErr"></div>
                    <div class="mb-foot" style="justify-content:flex-end">
                        <button class="ghost" id="impBack" type="button">Cancel</button>
                        <button id="impAnalyze" type="button">Analyze</button>
                    </div>
                </div>`;
            main.querySelector('#impBack').onclick = async () => { await api(`/api/import/${up.id}/cancel`, { body: {} }); renderUpload(); loadHistory(); };
            main.querySelector('#impAnalyze').onclick = async () => {
                const genericCol = Number(main.querySelector('#impGen').value), descCol = Number(main.querySelector('#impDesc').value);
                if (genericCol === descCol) { err('impErr', 'Pick two different columns.'); return; }
                const res = await api(`/api/import/${up.id}/analyze`, { body: { genericCol, descCol } });
                if (!res.ok) { err('impErr', res.data.message || 'Could not start'); return; }
                open(up.id);
            };
        }

        // ---------- open a job (any status) ----------
        async function open(id) {
            stopPoll();
            const res = await api(`/api/import/${id}`);
            if (!res.ok) { renderUpload(); err('impErr', res.data.message || 'Could not open the import'); return; }
            job = res.data.import; items = null;
            route();
        }
        function route() {
            if (job.status === 'uploaded') { renderColumns({ id: job.id, headers: job.summary.headers || [], guess: job.summary.guess || { genericCol: 0, descCol: 1 }, rowCount: job.summary.rowCount || 0, sample: [] }); return; }
            if (job.status === 'analyzing' || job.status === 'applying') { renderProgress(); startPoll(); return; }
            if (job.status === 'awaiting_review') { loadRows().then(() => { group = firstGroupWithRows(); renderReview(); }); return; }
            if (job.status === 'done') { renderResult(); return; }
            renderEnded();
        }
        function startPoll() {
            stopPoll();
            poll = setInterval(async () => {
                const res = await api(`/api/import/${job.id}`);
                if (!res.ok) return;
                const was = job.status;
                job = res.data.import;
                if (job.status !== was) { stopPoll(); loadHistory(); route(); }
                else renderProgress();
            }, 500);
        }
        function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }

        // ---------- progress ----------
        function renderProgress() {
            const analyzing = job.status === 'analyzing';
            const pct = job.total ? Math.round(100 * job.processed / job.total) : 0;
            const c = job.summary.counts || {};
            const result = job.summary.result || {};
            const live = analyzing
                ? [['Needs your decision', (c.attention || 0) + (c.same || 0)], ['New medicines', (c.new || 0) + (c.similar || 0)], ['Now marked In Bizbox', c.flag || 0], ['Already In Bizbox', c.unchanged || 0], ['Skipped lines', c.excluded || 0]]
                : [['Added', result.created || 0], ['Marked In Bizbox', (result.flagged || 0) + (result.linked || 0)], ['Already In Bizbox', result.unchanged || 0], ['Skipped', (result.skipped || 0) + (result.excluded || 0)]];
            if (!main.querySelector('#impBar')) {
                main.innerHTML = `
                    <div class="card imp-card">
                        <h2 id="impPhase"></h2>
                        <p class="sub" id="impPhaseSub"></p>
                        <div class="imp-progress"><div class="imp-bar" id="impBar"></div></div>
                        <div class="imp-count" id="impCount"></div>
                        <div class="imp-live" id="impLive"></div>
                        <div class="mb-foot" style="justify-content:flex-end"><button class="ghost sm" id="impCancel" type="button">Cancel import</button></div>
                    </div>`;
                main.querySelector('#impCancel').onclick = async () => { await api(`/api/import/${job.id}/cancel`, { body: {} }); stopPoll(); loadHistory(); renderUpload(); };
                if (!analyzing) main.querySelector('#impCancel').style.display = 'none';
            }
            main.querySelector('#impPhase').textContent = analyzing ? 'Analyzing the file…' : 'Applying to the medicine list…';
            main.querySelector('#impPhaseSub').textContent = analyzing ? 'Each line is compared with the medicine list. Nothing is saved yet.' : 'Adding and marking medicines. Please keep this page open.';
            main.querySelector('#impBar').style.width = pct + '%';
            main.querySelector('#impCount').textContent = `${analyzing ? 'Checked' : 'Applied'} ${job.processed} of ${job.total} (${pct}%)`;
            main.querySelector('#impLive').innerHTML = live.map(([l, n]) => `<span class="imp-chip">${l}: <b>${n}</b></span>`).join('');
        }

        async function loadRows() {
            const res = await api(`/api/import/${job.id}?rows=1`);
            if (res.ok) { items = res.data.import.rows || []; job = { ...res.data.import, rows: undefined }; }
            else items = [];
        }

        // ---------- review: one screen, four groups ----------
        const countsNow = () => { const c = { decide: 0, new: 0, marked: 0, unchanged: 0, skipped: 0, excluded: 0 }; items.forEach((r) => { c[groupOf(r)]++; }); return c; };
        const pendingCount = () => items.filter((r) => !r.excluded && (r.action === 'review' || (r.action !== 'skip' && !r.generic))).length;
        const firstGroupWithRows = () => { const c = countsNow(); return GROUPS.map(([k]) => k).find((k) => c[k]) || 'new'; };
        const shown = () => items.filter((r) => groupOf(r) === group && (!filter || `${r.generic} ${r.description} ${r.brand} ${r.form} ${r.strength}`.toLowerCase().includes(filter)));

        function renderReview() {
            const readOnly = job.status !== 'awaiting_review';
            const c = countsNow();
            const [, gLabel, gDesc] = GROUPS.find(([k]) => k === group);
            const left = pendingCount();
            const footnote = c.excluded + c.skipped;
            main.innerHTML = `
                <div class="card imp-card imp-review">
                    <div class="imp-h">
                        <div><h2>${readOnly ? 'What the import did — ' : ''}${esc(job.file)}</h2>
                        <p class="sub" style="margin:0">${readOnly ? `Applied ${fmtDT(job.finishedAt)} by ${esc(job.summary.appliedBy || job.uploadedBy || '')}.` : `${job.total} lines checked against the medicine list. Decide the first group, glance at the rest, then Apply.`}</p></div>
                        <div class="tb-right">
                            <input id="impFilter" placeholder="Find a medicine…" value="${esc(filter)}" style="max-width:220px">
                            ${readOnly ? `<a class="btn-link" href="/api/import/${job.id}/report.csv">Download CSV</a><button class="ghost" id="impClose" type="button">Close</button>`
                                : `<button class="ghost" id="impCancel" type="button">Cancel import</button><button id="impApply" type="button" ${left ? 'disabled' : ''}>${left ? `Apply (${left} to decide)` : 'Apply'}</button>`}
                        </div>
                    </div>
                    <div class="imp-groups">${GROUPS.map(([k, l]) => `<button type="button" class="imp-group ${k} ${k === group ? 'active' : ''} ${!c[k] ? 'empty' : ''}" data-g="${k}"><span class="n">${c[k]}</span><span class="l">${readOnly ? DONE_LABEL[k] : l}</span></button>`).join('')}</div>
                    <p class="sub imp-tabdesc">${readOnly ? '' : gDesc}${group === 'decide' && !readOnly && c.decide ? ' <button class="ghost sm" id="impAcceptAll" type="button">Accept every suggestion</button>' : ''}</p>
                    <div class="tbl-wrap imp-grid-wrap"><table class="dense imp-grid" id="impGrid"></table></div>
                    ${footnote ? `<div class="imp-foot muted">${c.excluded ? `${c.excluded} line${c.excluded === 1 ? '' : 's'} skipped automatically (blank, duplicate, or remembered as not a medicine)` : ''}${c.excluded && c.skipped ? ' · ' : ''}${c.skipped ? `${c.skipped} skipped by you` : ''} — <a href="#" id="impShowSkipped">${group === 'skipped' || group === 'excluded' ? 'back to the groups' : 'show'}</a></div>` : ''}
                </div>`;
            main.querySelectorAll('.imp-group').forEach((b) => { b.onclick = () => { group = b.dataset.g; renderReview(); }; });
            const f = main.querySelector('#impFilter');
            let ft = null; f.oninput = () => { clearTimeout(ft); ft = setTimeout(() => { filter = f.value.trim().toLowerCase(); renderGrid(); }, 200); };
            const sk = main.querySelector('#impShowSkipped');
            if (sk) sk.onclick = (e) => { e.preventDefault(); group = (group === 'skipped' || group === 'excluded') ? firstGroupWithRows() : (c.skipped ? 'skipped' : 'excluded'); renderReview(); };
            if (readOnly) main.querySelector('#impClose').onclick = () => renderUpload();
            else {
                main.querySelector('#impCancel').onclick = async () => {
                    const go = await showDialog({ kind: 'warn', title: 'Cancel this import?', message: 'Nothing has been written. Your decisions on this file will be lost.', actions: [{ label: 'Cancel import', value: true, variant: 'danger' }, { label: 'Keep working', value: false, variant: 'ghost', cancel: true }] });
                    if (!go) return;
                    await api(`/api/import/${job.id}/cancel`, { body: {} }); loadHistory(); renderUpload();
                };
                main.querySelector('#impApply').onclick = applyNow;
                const acc = main.querySelector('#impAcceptAll');
                if (acc) acc.onclick = () => { shown().forEach((r) => { if (r.action === 'review' && r.match) decide(r, { action: 'same' }); }); renderReview(); };
            }
            renderGrid();
        }

        // what will happen to a row, in one line
        const outcomeText = (r, past) => {
            const g = groupOf(r);
            if (g === 'new') return `${past ? 'Added' : 'Will be added'} as <b>${esc(r.generic)}</b> — ${esc(ownText(r))}`;
            if (g === 'marked') return `${past ? 'Marked' : 'Will mark'} <b>${esc(r.match ? r.match.generic : r.generic)}</b> — ${esc(productText(r.match))}`;
            if (g === 'unchanged') return `Already In Bizbox as <b>${esc(r.match ? r.match.generic : r.generic)}</b> — ${esc(productText(r.match))}`;
            if (g === 'skipped') return past ? 'Skipped' : 'Will be skipped';
            if (g === 'excluded') return r.note ? `Skipped — ${esc(r.note)}` : 'Skipped';
            return '';
        };

        function renderGrid() {
            const readOnly = job.status !== 'awaiting_review';
            const list = shown();
            const grid = main.querySelector('#impGrid');
            const past = readOnly;
            let head, body;
            if (group === 'decide' && !readOnly) {
                head = '<th>#</th><th>Bizbox line</th><th>Why it needs you</th><th>Our reading</th><th>Decision</th>';
                body = list.slice(0, 300).map((r) => {
                    const needsGeneric = !r.generic;
                    const reading = `
                        <div class="imp-read">
                            <label>Generic <input class="cell" data-f="generic" value="${esc(r.generic)}" placeholder="type the generic" ${needsGeneric ? 'style="border-color:var(--red)"' : ''}></label>
                            <label>Brand <input class="cell" data-f="brand" value="${esc(r.brand)}"></label>
                            <label>Form <input class="cell" data-f="form" value="${esc(r.form)}"></label>
                            <label>Strength <input class="cell" data-f="strength" value="${esc(r.strength)}"></label>
                        </div>`;
                    const suggestion = r.match
                        ? `<div class="imp-suggest">Existing: <b>${esc(r.match.generic)}</b> — ${esc(productText(r.match))} <span class="badge ${r.match.ihf ? 'green' : 'amber'}">${r.match.ihf ? 'In Bizbox' : 'Not marked'}</span></div>`
                        : (r.siblings && r.siblings.length)
                            ? `<div class="imp-suggest muted">Same brand has: ${r.siblings.slice(0, 3).map((s) => esc(productText(s))).join(' · ')}</div>` : '';
                    return `<tr data-i="${r.i}">
                        <td class="muted">${r.i + 2}</td>
                        <td class="imp-desc">${esc(r.description)}</td>
                        <td class="imp-why">${reasonText(r)}${suggestion}</td>
                        <td>${reading}</td>
                        <td class="imp-acts">
                            ${r.match ? `<button type="button" class="sm act-same">Same as existing</button>` : ''}
                            <button type="button" class="ghost sm act-new" ${needsGeneric ? 'disabled title="type a generic first"' : ''}>Add as new</button>
                            <button type="button" class="ghost sm act-skip">Skip</button>
                        </td>
                    </tr>`;
                }).join('');
            } else {
                head = `<th>#</th><th>Bizbox line</th><th>${past ? 'What happened' : 'What will happen'}</th>${readOnly ? '' : '<th></th>'}`;
                body = list.slice(0, 400).map((r) => `<tr data-i="${r.i}" class="${groupOf(r) === 'skipped' ? 'inactive' : ''}">
                        <td class="muted">${r.i + 2}</td>
                        <td class="imp-desc">${esc(r.description)}</td>
                        <td class="imp-out">${outcomeText(r, past)}${r.error ? ` <span class="badge red">${esc(r.error)}</span>` : ''}${r.note && groupOf(r) !== 'excluded' ? ` <span class="muted">(${esc(r.note)})</span>` : ''}</td>
                        ${readOnly ? '' : `<td class="imp-acts">${groupOf(r) === 'skipped' ? '<button type="button" class="ghost sm act-undo">Undo skip</button>' : groupOf(r) === 'excluded' ? '' : '<button type="button" class="ghost sm act-skip">Skip</button>'}</td>`}
                    </tr>`).join('');
            }
            grid.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
            if (list.length > 300) grid.insertAdjacentHTML('beforeend', `<tfoot><tr><td colspan="5" class="muted">Showing the first rows of ${list.length} — use the search box to narrow.</td></tr></tfoot>`);
            if (!list.length) grid.insertAdjacentHTML('beforeend', `<tbody><tr><td colspan="5" class="muted" style="text-align:center;padding:24px">Nothing here.</td></tr></tbody>`);
            if (readOnly) return;

            grid.querySelectorAll('tr[data-i]').forEach((tr) => {
                const r = items.find((x) => x.i === Number(tr.dataset.i));
                tr.querySelectorAll('input.cell').forEach((cell) => { cell.onchange = () => { decide(r, { [cell.dataset.f]: cell.value.trim() }); renderGrid(); refreshApply(); }; });
                const on = (cls, fn) => { const b = tr.querySelector(cls); if (b) b.onclick = fn; };
                on('.act-same', () => { decide(r, { action: 'same' }); renderReview(); });
                on('.act-new', () => { if (r.generic) { decide(r, { action: 'new' }); renderReview(); } });
                on('.act-skip', () => { decide(r, { action: 'skip' }); renderReview(); });
                on('.act-undo', () => { decide(r, { action: r.category === 'attention' || r.category === 'same' ? 'review' : (r.match && !r.match.ihf ? 'same' : 'new') }); renderReview(); });
            });
        }

        // local state first (the screen answers immediately), server a moment later
        function decide(r, d) {
            if (d.action !== undefined) r.action = d.action;
            ['generic', 'brand', 'form', 'strength'].forEach((f) => { if (d[f] !== undefined) { r[f] = d[f]; r.edited = true; } });
            const prev = pendingDecisions.get(r.i) || { i: r.i };
            pendingDecisions.set(r.i, { ...prev, ...d, i: r.i });
            clearTimeout(flushT); flushT = setTimeout(flush, 600);
            refreshApply();
        }
        async function flush() {
            if (!pendingDecisions.size || !job) return;
            const decisions = [...pendingDecisions.values()];
            pendingDecisions = new Map();
            const res = await api(`/api/import/${job.id}/decisions`, { body: { decisions } });
            if (!res.ok) showDialog({ kind: 'danger', title: 'Could not save', message: res.data.message || 'Your last change was not saved. Try again.' });
        }
        function refreshApply() {
            const b = main.querySelector('#impApply'); if (!b) return;
            const left = pendingCount();
            b.disabled = left > 0; b.textContent = left ? `Apply (${left} to decide)` : 'Apply';
            const c = countsNow();
            main.querySelectorAll('.imp-group').forEach((g) => { g.querySelector('.n').textContent = c[g.dataset.g]; g.classList.toggle('empty', !c[g.dataset.g]); });
        }

        async function applyNow() {
            clearTimeout(flushT); await flush();
            const c = countsNow();
            const go = await showDialog({
                kind: 'warn', title: 'Apply this import?',
                message: `${c.new} medicine${c.new === 1 ? '' : 's'} will be added, ${c.marked} marked In Bizbox, ${c.unchanged} left as they are (wording refreshed), ${c.skipped + c.excluded} skipped.\n\nNothing is removed. This cannot be undone from here.`,
                actions: [{ label: 'Apply', value: true, variant: 'primary' }, { label: 'Not yet', value: false, variant: 'ghost', cancel: true }],
            });
            if (!go) return;
            const res = await api(`/api/import/${job.id}/apply`, { body: {} });
            if (!res.ok) { showDialog({ kind: 'danger', title: 'Cannot apply', message: res.data.message || 'Try again.' }); return; }
            open(job.id);
        }

        // ---------- result ----------
        function renderResult() {
            const r = job.summary.result || {};
            const missing = job.summary.missing || [];
            main.innerHTML = `
                <div class="card imp-card">
                    <h2>Import applied</h2>
                    <p class="sub">${esc(job.file)} · ${fmtDT(job.finishedAt)} · by ${esc(job.summary.appliedBy || job.uploadedBy || '')}</p>
                    <div class="imp-summary">
                        ${[['created', 'Added', 'New medicines, now marked In Bizbox'], ['linked', 'Marked In Bizbox', 'Existing medicines, marked'], ['unchanged', 'Already In Bizbox', 'No change needed'], ['skipped', 'Skipped', 'By you, or not a medicine']].map(([k, l, d]) => `<div class="imp-sum"><div class="n">${k === 'linked' ? (r.linked || 0) + (r.flagged || 0) : k === 'skipped' ? (r.skipped || 0) + (r.excluded || 0) : (r[k] || 0)}</div><div class="l">${l}</div><div class="d">${d}</div></div>`).join('')}
                    </div>
                    <div class="okbox" style="margin-top:12px">The nurse's list now shows these medicines as In Bizbox. Anything the file did not mention was left exactly as it was.</div>
                    ${missing.length ? `<details class="imp-missing"><summary><b>${job.summary.missingCount}</b> medicine${job.summary.missingCount === 1 ? '' : 's'} marked In Bizbox in this system but not in this file — for information only, nothing was changed</summary>
                        <div class="tbl-wrap"><table class="dense"><thead><tr><th>Generic</th><th>Brand / Form / Strength</th><th>Last seen in a file</th></tr></thead><tbody>${missing.map((m) => `<tr><td>${esc(m.generic)}</td><td>${esc(m.description)}</td><td class="muted">${m.seenAt ? fmtDT(m.seenAt) : 'never'}</td></tr>`).join('')}</tbody></table></div>
                        ${job.summary.missingCount > missing.length ? `<div class="muted" style="font-size:12px;margin-top:6px">First ${missing.length} shown.</div>` : ''}</details>` : ''}
                    <div class="mb-foot" style="justify-content:flex-end">
                        <a class="btn-link" href="/api/import/${job.id}/report.csv">Download row report (CSV)</a>
                        <button class="ghost" id="impRows" type="button">See what was done</button>
                        <button id="impNew" type="button">New import</button>
                    </div>
                </div>`;
            main.querySelector('#impNew').onclick = renderUpload;
            main.querySelector('#impRows').onclick = async () => { await loadRows(); group = firstGroupWithRows(); renderReview(); };
        }
        function renderEnded() {
            main.innerHTML = `
                <div class="card imp-card">
                    <h2>${STATUS_LABEL[job.status] || job.status}</h2>
                    <p class="sub">${esc(job.file)} · ${fmtDT(job.startedAt)}${job.summary.error ? ` · ${esc(job.summary.error)}` : ''}</p>
                    <div class="mb-foot" style="justify-content:flex-end"><button id="impNew" type="button">New import</button></div>
                </div>`;
            main.querySelector('#impNew').onclick = renderUpload;
        }

        // resume the newest open import if there is one, else start fresh
        (async () => {
            await loadHistory();
            const res = await api('/api/import');
            const openJob = res.ok && (res.data.imports || []).find((j) => ['analyzing', 'applying', 'awaiting_review'].includes(j.status));
            if (openJob) open(openJob.id); else renderUpload();
        })();

        return { open, reset: renderUpload };
    }

    global.BizboxImport = { mount };
})(window);
