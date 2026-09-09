/* Bizbox import — the whole flow in one component, mounted on the IT console
 * (Medicines tab) and on the pharmacy head's Medicines page.
 *
 *   BizboxImport.mount(rootElement)
 *
 * Upload -> pick the two columns -> Analyzing (live progress) -> Confirmation
 * summary -> Review grid (tabs by category, inline edits, same/new/skip,
 * exclude) -> Applying (live progress) -> Result. Everything is a job on the
 * server; this page only polls it, so a refresh — or another person opening
 * the same import — lands on the same step.
 */
(function (global) {
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmtDT = (t) => (t ? new Date(t).toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit', hour: 'numeric', minute: '2-digit' }) : '');
    const CATS = [
        ['attention', 'Needs attention', 'The split is doubtful — check brand, form and strength, then accept or exclude.'],
        ['same', 'Possibly the same', 'Same generic and brand; form or strength differs only by spelling. Confirm it is the same product, or keep it as new.'],
        ['similar', 'Similar exists', 'Same generic and brand, but another strength or form. New by default — pick "Same as" if it is really one of those.'],
        ['new', 'New', 'Nothing like it in the list. Will be created and marked in Bizbox.'],
        ['flag', 'Now in Bizbox', 'The exact product exists in the list but was not marked in Bizbox. Will be marked.'],
        ['unchanged', 'Unchanged', 'Already in Bizbox. Only the Bizbox wording and "last seen" are refreshed.'],
        ['excluded', 'Excluded', 'Skipped: blank, a duplicate line, or remembered from an earlier import.'],
    ];
    const CAT_LABEL = Object.fromEntries(CATS.map(([k, l]) => [k, l]));
    const STATUS_LABEL = { uploaded: 'Waiting for columns', analyzing: 'Analyzing', awaiting_review: 'Awaiting review', applying: 'Applying', done: 'Done', cancelled: 'Cancelled', failed: 'Failed' };
    const STATUS_TONE = { done: 'green', awaiting_review: 'amber', analyzing: 'navy', applying: 'navy', failed: 'red', cancelled: 'gray', uploaded: 'gray' };

    function mount(root) {
        let job = null;          // the import being worked on (summary only)
        let items = null;        // its rows, when in review / done
        let tab = 'attention';
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
            host.innerHTML = `<table class="dense"><thead><tr><th>When</th><th>File</th><th>By</th><th>Status</th><th>Rows</th><th>Result</th><th></th></tr></thead><tbody>${list.map((j) => {
                const r = j.summary.result;
                const c = j.summary.counts;
                const res = r ? `flagged ${r.flagged} · created ${r.created} · linked ${r.linked} · unchanged ${r.unchanged}${j.summary.missingCount ? ` · <span class="muted">${j.summary.missingCount} missing from file</span>` : ''}`
                    : c ? `attention ${c.attention || 0} · same ${c.same || 0} · new ${c.new || 0} · flag ${c.flag || 0}` : (j.summary.error ? `<span class="muted">${esc(j.summary.error)}</span>` : '');
                return `<tr><td>${fmtDT(j.startedAt)}</td><td class="mono">${esc(j.file)}</td><td>${esc(j.uploadedBy || '')}</td><td><span class="badge ${STATUS_TONE[j.status] || 'gray'}">${STATUS_LABEL[j.status] || j.status}</span></td><td>${j.total || j.summary.rowCount || ''}</td><td class="muted" style="font-size:12px">${res}</td><td class="row-actions"><button class="ghost sm" data-open="${j.id}" type="button">${j.status === 'awaiting_review' ? 'Resume' : 'Open'}</button></td></tr>`;
            }).join('')}</tbody></table>`;
            host.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => open(b.dataset.open); });
        }

        // ---------- upload ----------
        function renderUpload() {
            stopPoll(); job = null; items = null;
            main.innerHTML = `
                <div class="card imp-card">
                    <h2>Import from Bizbox</h2>
                    <p class="sub">Upload the Bizbox medicine export (.xlsx or .csv, two columns: generic and description). Nothing is changed until you review the rows and press Apply.</p>
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
                    <div class="tbl-wrap" style="margin-top:12px"><table class="dense imp-sample"><thead><tr>${up.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${up.sample.map((r) => `<tr>${up.headers.map((_, i) => `<td>${esc(r[i] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
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
            if (job.status === 'awaiting_review') { if (!job.confirmed) renderSummary(); else loadRows().then(renderReview); return; }
            if (job.status === 'done') { renderResult(); return; }
            renderEnded();
        }
        function startPoll() {
            stopPoll();
            poll = setInterval(async () => {
                const res = await api(`/api/import/${job.id}`);
                if (!res.ok) return;
                const was = job.status;
                job = { ...res.data.import, confirmed: job.confirmed };
                if (job.status !== was) { stopPoll(); loadHistory(); route(); }
                else renderProgress();
            }, 500);
        }
        function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }

        // ---------- progress ----------
        function renderProgress() {
            const analyzing = job.status === 'analyzing';
            const pct = job.total ? Math.round(100 * job.processed / job.total) : 0;
            const counts = job.summary.counts || {};
            const result = job.summary.result || {};
            const live = analyzing
                ? CATS.map(([k, l]) => `<span class="imp-chip">${l}: <b>${counts[k] || 0}</b></span>`).join('')
                : ['flagged', 'created', 'linked', 'unchanged', 'excluded', 'skipped'].map((k) => `<span class="imp-chip">${k}: <b>${result[k] || 0}</b></span>`).join('');
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
            main.querySelector('#impPhase').textContent = analyzing ? 'Analyzing the file…' : 'Applying to the catalog…';
            main.querySelector('#impPhaseSub').textContent = analyzing ? 'Each row is split and matched against the medicine list. Nothing is saved yet.' : 'Marking, creating and linking products. Please keep this page open.';
            main.querySelector('#impBar').style.width = pct + '%';
            main.querySelector('#impCount').textContent = `${analyzing ? 'Analyzed' : 'Applied'} ${job.processed} of ${job.total} (${pct}%)`;
            main.querySelector('#impLive').innerHTML = live;
        }

        // ---------- confirmation summary ----------
        function renderSummary() {
            const c = job.summary.counts || {};
            const total = job.total || 0;
            main.innerHTML = `
                <div class="card imp-card">
                    <h2>Analysis of ${esc(job.file)}</h2>
                    <p class="sub">${total} rows. Here is what the import would do. Nothing has been changed yet — review the rows next, then apply.</p>
                    <div class="imp-summary">
                        ${CATS.map(([k, l, d]) => `<div class="imp-sum ${k}"><div class="n">${c[k] || 0}</div><div class="l">${l}</div><div class="d">${d}</div></div>`).join('')}
                    </div>
                    <div class="infobox" style="margin-top:12px">The import never removes or unmarks a medicine. Products marked in Bizbox that this file does not list are reported at the end, and left alone.</div>
                    <div class="mb-foot" style="justify-content:flex-end">
                        <button class="ghost" id="impCancel" type="button">Cancel import</button>
                        <button id="impReview" type="button">Review rows</button>
                    </div>
                </div>`;
            main.querySelector('#impCancel').onclick = async () => { await api(`/api/import/${job.id}/cancel`, { body: {} }); loadHistory(); renderUpload(); };
            main.querySelector('#impReview').onclick = async () => { job.confirmed = true; await loadRows(); renderReview(); };
        }

        async function loadRows() {
            const res = await api(`/api/import/${job.id}?rows=1`);
            if (res.ok) { items = res.data.import.rows || []; job = { ...res.data.import, rows: undefined, confirmed: job.confirmed }; }
            else items = [];
        }

        // ---------- review grid ----------
        const rowCat = (r) => (r.excluded ? 'excluded' : r.category);
        const countsNow = () => { const c = {}; CATS.forEach(([k]) => { c[k] = 0; }); items.forEach((r) => { c[rowCat(r)]++; }); return c; };
        // undecided, or to be created/linked with no generic to file it under (mirrors the server)
        const pendingCount = () => items.filter((r) => !r.excluded && (r.action === 'review' || (r.action !== 'skip' && !r.generic))).length;
        const productText = (p) => (p ? (p.description || [p.brand, p.strength, p.form].filter(Boolean).join(' ')) : '');

        function renderReview() {
            const readOnly = job.status !== 'awaiting_review';
            const c = countsNow();
            if (!c[tab] && !readOnly) tab = CATS.map(([k]) => k).find((k) => c[k]) || 'new';
            const [, tabLabel, tabDesc] = CATS.find(([k]) => k === tab);
            const left = pendingCount();
            main.innerHTML = `
                <div class="card imp-card imp-review">
                    <div class="imp-h">
                        <div><h2>${readOnly ? 'Rows of' : 'Review'} ${esc(job.file)}</h2>
                        <p class="sub" style="margin:0">${readOnly ? `Applied ${fmtDT(job.finishedAt)} by ${esc(job.summary.appliedBy || job.uploadedBy || '')}. Read-only.` : 'Fix what the split got wrong, decide the doubtful ones, then apply.'}</p></div>
                        <div class="tb-right">
                            <input id="impFilter" placeholder="Find a row…" value="${esc(filter)}" style="max-width:220px">
                            ${readOnly ? `<a class="btn-link" href="/api/import/${job.id}/report.csv">Download CSV</a><button class="ghost sm" id="impClose" type="button">Close</button>`
                                : `<button class="ghost sm" id="impCancel" type="button">Cancel import</button><button class="sm" id="impApply" type="button" ${left ? 'disabled' : ''}>Apply ${left ? `(${left} to decide)` : 'to catalog'}</button>`}
                        </div>
                    </div>
                    <div class="tabs imp-tabs">${CATS.map(([k, l]) => `<button class="tab ${k === tab ? 'active' : ''}" data-t="${k}" type="button">${l} <span class="cnt">${c[k]}</span></button>`).join('')}</div>
                    <p class="sub imp-tabdesc">${tabDesc}${tab === 'attention' && !readOnly && c.attention ? ' <button class="ghost sm" id="impAcceptAll" type="button">Accept all shown as New</button>' : ''}</p>
                    <div class="tbl-wrap imp-grid-wrap"><table class="dense imp-grid" id="impGrid"></table></div>
                </div>`;
            main.querySelectorAll('.imp-tabs .tab').forEach((b) => { b.onclick = () => { tab = b.dataset.t; renderReview(); }; });
            const f = main.querySelector('#impFilter');
            let ft = null; f.oninput = () => { clearTimeout(ft); ft = setTimeout(() => { filter = f.value.trim().toLowerCase(); renderGrid(); }, 200); };
            if (readOnly) main.querySelector('#impClose').onclick = () => { renderUpload(); };
            else {
                main.querySelector('#impCancel').onclick = async () => { await api(`/api/import/${job.id}/cancel`, { body: {} }); loadHistory(); renderUpload(); };
                main.querySelector('#impApply').onclick = applyNow;
                const acc = main.querySelector('#impAcceptAll');
                // rows with no generic stay: there is nothing to file them under until one is typed
                if (acc) acc.onclick = () => { shown().forEach((r) => { if (r.action === 'review' && r.generic) decide(r, { action: 'new' }); }); renderReview(); };
            }
            renderGrid();
        }
        const shown = () => items.filter((r) => rowCat(r) === tab && (!filter || `${r.generic} ${r.description} ${r.brand} ${r.form} ${r.strength}`.toLowerCase().includes(filter)));

        function renderGrid() {
            const readOnly = job.status !== 'awaiting_review';
            const list = shown();
            const grid = main.querySelector('#impGrid');
            const editable = !readOnly && tab !== 'unchanged';
            const inp = (r, f, w) => (editable ? `<input class="cell" data-f="${f}" value="${esc(r[f])}" style="width:${w}px">` : esc(r[f]));
            grid.innerHTML = `<thead><tr>
                    <th>#</th><th>Bizbox description</th><th>Generic</th><th>Brand</th><th>Form</th><th>Strength</th>
                    <th>${tab === 'similar' || tab === 'attention' ? 'Also under this brand' : 'Matched product'}</th><th>Flags</th><th>Decision</th>${readOnly ? '' : '<th>Exclude</th>'}
                </tr></thead><tbody>${list.slice(0, 400).map((r) => {
                    const matchCell = r.match
                        ? `<div class="imp-match">${esc(r.match.generic)}<br><b>${esc(productText(r.match))}</b> <span class="badge ${r.match.ihf ? 'green' : 'amber'}">${r.match.ihf ? 'In Bizbox' : 'Not marked'}</span></div>`
                        : (r.siblings && r.siblings.length)
                            ? `<div class="imp-sibs">${r.siblings.map((s, k) => `<label><input type="radio" name="sib-${r.i}" data-sib="${k}" ${!readOnly ? '' : 'disabled'}> ${esc(productText(s))} ${s.ihf ? '<span class="badge green">In Bizbox</span>' : ''}</label>`).join('')}</div>`
                            : '<span class="muted">—</span>';
                    const needsGeneric = !r.excluded && r.action !== 'skip' && !r.generic;
                    const flags = [...(r.warnings || []).map((w) => `<span class="badge amber">${esc(w)}</span>`), needsGeneric ? '<span class="badge red">type a generic, or skip</span>' : '', r.note ? `<span class="badge gray">${esc(r.note)}</span>` : '', r.edited ? '<span class="badge navy">edited</span>' : '', r.error ? `<span class="badge red">${esc(r.error)}</span>` : ''].filter(Boolean).join(' ');
                    const decision = readOnly ? `<span class="badge ${r.excluded ? 'gray' : r.action === 'skip' ? 'gray' : 'green'}">${r.excluded ? 'excluded' : r.action}</span>`
                        : `<select class="act" ${r.excluded ? 'disabled' : ''}>
                            ${r.category === 'unchanged' ? '<option value="skip">Keep (refresh wording)</option>' : ''}
                            ${r.action === 'review' ? '<option value="review" selected>Decide…</option>' : ''}
                            ${r.match && !r.match.ihf ? `<option value="flag" ${r.action === 'flag' ? 'selected' : ''}>Mark in Bizbox</option>` : ''}
                            ${r.match ? `<option value="same" ${r.action === 'same' ? 'selected' : ''}>Same as matched product</option>` : ''}
                            ${r.category !== 'unchanged' ? `<option value="new" ${r.action === 'new' ? 'selected' : ''}>New product</option>` : ''}
                            <option value="skip" ${r.action === 'skip' && r.category !== 'unchanged' ? 'selected' : ''}>Skip this time</option>
                        </select>`;
                    return `<tr data-i="${r.i}" class="${r.excluded ? 'inactive' : ''}">
                        <td class="muted">${r.i + 2}</td>
                        <td class="imp-desc">${esc(r.description)}</td>
                        <td>${inp(r, 'generic', 150)}</td><td>${inp(r, 'brand', 120)}</td><td>${inp(r, 'form', 110)}</td><td>${inp(r, 'strength', 110)}</td>
                        <td>${matchCell}</td><td>${flags}</td><td>${decision}</td>
                        ${readOnly ? '' : `<td class="imp-ex"><label><input type="checkbox" class="ex" ${r.excluded ? 'checked' : ''}> skip</label><label class="muted"><input type="checkbox" class="rem" ${r.remember ? 'checked' : ''} ${r.excluded ? '' : 'disabled'}> remember</label></td>`}
                    </tr>`;
                }).join('')}</tbody>`;
            if (list.length > 400) grid.insertAdjacentHTML('beforeend', `<tfoot><tr><td colspan="10" class="muted">Showing the first 400 of ${list.length} — use the search box to narrow.</td></tr></tfoot>`);
            if (!list.length) grid.insertAdjacentHTML('beforeend', `<tbody><tr><td colspan="10" class="muted" style="text-align:center;padding:24px">Nothing here.</td></tr></tbody>`);
            if (readOnly) return;

            grid.querySelectorAll('tr[data-i]').forEach((tr) => {
                const r = items.find((x) => x.i === Number(tr.dataset.i));
                tr.querySelectorAll('input.cell').forEach((cell) => {
                    cell.onchange = () => decide(r, { [cell.dataset.f]: cell.value.trim() }, true);
                });
                const sel = tr.querySelector('select.act');
                if (sel) sel.onchange = () => { decide(r, { action: sel.value }); refreshApply(); };
                tr.querySelectorAll('input[data-sib]').forEach((rb) => {
                    rb.onchange = () => { const s = r.siblings[Number(rb.dataset.sib)]; decide(r, { action: 'same', sameAs: s }); r.match = s; renderGrid(); refreshApply(); };
                });
                const ex = tr.querySelector('input.ex'), rem = tr.querySelector('input.rem');
                ex.onchange = () => { decide(r, { exclude: ex.checked, remember: ex.checked && rem.checked }); renderReview(); };
                rem.onchange = () => decide(r, { exclude: ex.checked, remember: rem.checked });
            });
        }

        // local state first (the grid answers immediately), server a moment later
        function decide(r, d, reclassify) {
            Object.assign(r, d.action !== undefined ? { action: d.action } : {}, d.exclude !== undefined ? { excluded: d.exclude, remember: !!d.remember } : {});
            ['generic', 'brand', 'form', 'strength'].forEach((f) => { if (d[f] !== undefined) { r[f] = d[f]; r.edited = true; } });
            if (r.excluded) r.action = 'skip';
            if (reclassify && r.action === 'review') { /* stays to be decided */ }
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
            b.disabled = left > 0; b.textContent = left ? `Apply (${left} to decide)` : 'Apply to catalog';
            main.querySelectorAll('.imp-tabs .tab').forEach((t) => { t.querySelector('.cnt').textContent = countsNow()[t.dataset.t]; });
        }

        async function applyNow() {
            clearTimeout(flushT); await flush();
            const c = countsNow();
            const willDo = items.filter((r) => !r.excluded && r.action !== 'skip' && r.action !== 'review').length;
            const go = await showDialog({
                kind: 'warn', title: 'Apply this import?',
                message: `${willDo} row${willDo === 1 ? '' : 's'} will be written to the medicine list: new products created, existing ones marked in Bizbox, spellings linked. ${c.unchanged} unchanged rows get their Bizbox wording refreshed. ${c.excluded} excluded.\n\nNothing is removed. This cannot be undone from here.`,
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
                        ${[['flagged', 'Marked in Bizbox'], ['created', 'Created'], ['linked', 'Linked as same'], ['unchanged', 'Unchanged'], ['excluded', 'Excluded'], ['skipped', 'Skipped']].map(([k, l]) => `<div class="imp-sum"><div class="n">${r[k] || 0}</div><div class="l">${l}</div></div>`).join('')}
                    </div>
                    <div class="okbox" style="margin-top:12px">The nurse's list now reads these products as In Bizbox. Anything the file did not list was left exactly as it was.</div>
                    ${missing.length ? `<details class="imp-missing"><summary><b>${job.summary.missingCount}</b> product${job.summary.missingCount === 1 ? '' : 's'} marked in Bizbox that this file does not list — for information only, nothing was changed</summary>
                        <div class="tbl-wrap"><table class="dense"><thead><tr><th>Generic</th><th>Brand/Form/Strength</th><th>Last seen in a file</th></tr></thead><tbody>${missing.map((m) => `<tr><td>${esc(m.generic)}</td><td>${esc(m.description)}</td><td class="muted">${m.seenAt ? fmtDT(m.seenAt) : 'never'}</td></tr>`).join('')}</tbody></table></div>
                        ${job.summary.missingCount > missing.length ? `<div class="muted" style="font-size:12px;margin-top:6px">First ${missing.length} shown.</div>` : ''}</details>` : ''}
                    <div class="mb-foot" style="justify-content:flex-end">
                        <a class="btn-link" href="/api/import/${job.id}/report.csv">Download row report (CSV)</a>
                        <button class="ghost" id="impRows" type="button">View rows</button>
                        <button id="impNew" type="button">New import</button>
                    </div>
                </div>`;
            main.querySelector('#impNew').onclick = renderUpload;
            main.querySelector('#impRows').onclick = async () => { await loadRows(); tab = 'new'; renderReview(); };
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

        // resume the newest open review if there is one, else start fresh
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
