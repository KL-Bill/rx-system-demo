// ---------- the progress bar ----------
// Every call below goes through api(), so one bar at the top of the window
// covers the whole system: a page that is fetching never looks frozen. It
// waits 180 ms before appearing — anything faster than that reads as instant
// and a flash of bar is worse than none — and counts requests, so it only
// leaves when the last one is done.
//
// Autocomplete keystrokes pass quiet:true: a bar blinking on every letter is
// noise, and those boxes say "Searching…" in the list itself.
let busyCount = 0, busyTimer = null;
function busyBar() {
    let el = document.getElementById('__busy');
    if (!el) {
        el = document.createElement('div');
        el.id = '__busy';
        el.className = 'busybar';
        el.innerHTML = '<div class="busybar-in"></div>';
        document.body.appendChild(el);
    }
    return el;
}
function busyStart() {
    busyCount += 1;
    if (busyCount === 1 && !busyTimer) {
        busyTimer = setTimeout(() => { busyBar().classList.add('on'); document.body.classList.add('is-busy'); }, 180);
    }
}
function busyEnd() {
    busyCount = Math.max(0, busyCount - 1);
    if (busyCount) return;
    clearTimeout(busyTimer); busyTimer = null;
    const el = document.getElementById('__busy');
    if (el) el.classList.remove('on');
    document.body.classList.remove('is-busy');
}
// for work that is not a fetch (building a report, rendering a big table)
async function withBusy(fn) {
    busyStart();
    try { return await fn(); } finally { busyEnd(); }
}

// tiny fetch wrapper shared by all pages
async function api(path, opts = {}) {
    const quiet = !!opts.quiet || !!opts.signal;
    if (!quiet) busyStart();
    try {
        const res = await fetch(path, {
            method: opts.method || (opts.body ? 'POST' : 'GET'),
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: opts.body ? JSON.stringify(opts.body) : undefined,
            signal: opts.signal,        // callers that supersede their own requests (autocomplete) pass one
        });
        let data = {};
        try { data = await res.json(); } catch { /* no body */ }
        return { ok: res.ok, status: res.status, data };
    } finally {
        if (!quiet) busyEnd();
    }
}

// A button that says what it is doing while it does it, and cannot be
// double-clicked into sending the same thing twice.
//   await withButton(btn, 'Saving…', () => api(...))
async function withButton(btn, label, fn) {
    if (!btn) return fn();
    const was = btn.innerHTML, wasDisabled = btn.disabled;
    btn.disabled = true;
    btn.classList.add('is-working');
    if (label) btn.innerHTML = `<span class="spin"></span>${escapeHtml(label)}`;
    try { return await fn(); } finally {
        btn.innerHTML = was; btn.disabled = wasDisabled; btn.classList.remove('is-working');
    }
}

// the placeholder a table shows while its rows are on the way
function loadingRows(colspan = 6, text = 'Loading…') {
    return `<tr class="loading-row"><td colspan="${colspan}"><span class="spin dark"></span>${escapeHtml(text)}</td></tr>`;
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

// prefix a doctor name with "Dr." for display (no double-prefix; leaves blanks/placeholders alone)
function drName(name) {
    name = String(name || '').trim();
    if (!name || name === '—') return name;
    return /^dr\.?\s/i.test(name) ? name : 'Dr. ' + name;
}

// ---------- showDialog(): every message the pages put in front of a user ----------
// Never call alert()/confirm()/prompt() from these pages. They open a real OS
// dialog, and the stations run the kiosk Electron client: when that dialog
// closes, Windows does not reliably hand keyboard focus back to the page.
// Everything still paints and the mouse still works, so nothing looks broken —
// but no keystroke reaches any field. Nurses reported this as "the screen
// froze"; it never froze, it just went deaf.
//
// This is a native <dialog> + showModal(), not a hand-rolled overlay and not an
// OS window. The browser gives us the top layer, an inert page behind it, a Tab
// trap, Esc to close and focus handed back to whatever was focused before it
// opened — none of which costs the page its keyboard.
//
// Callers that want the caret somewhere specific afterwards (the field that
// failed validation, say) await the promise and focus it themselves, since the
// dialog's own hand-back would otherwise put it on the button that opened it.
//   opts.title    heading
//   opts.message  body text; newlines are kept
//   opts.detail   optional monospace line (a filename, an id), selectable
//   opts.kind     'info' (default) | 'ok' | 'warn' | 'danger'
//   opts.actions  [{ label, value, variant: 'primary'|'ghost'|'danger', cancel }]
// Resolves with the chosen action's value; Esc resolves with the cancel
// action's value, or null when there is no cancel action.
function showDialog(opts = {}) {
    const {
        title = '', message = '', detail = '', kind = 'info',
        actions = [{ label: 'OK', value: true, variant: 'primary' }],
    } = opts;

    return new Promise((resolve) => {
        const dlg = document.createElement('dialog');
        dlg.className = `dlg dlg-${kind}`;
        const titleId = `dlg-t-${Math.random().toString(36).slice(2, 8)}`;
        dlg.setAttribute('aria-labelledby', titleId);

        const h = document.createElement('h3');
        h.id = titleId; h.className = 'dlg-title'; h.textContent = title;
        dlg.appendChild(h);

        if (message) {
            const p = document.createElement('p');
            p.className = 'dlg-msg'; p.textContent = message;
            dlg.appendChild(p);
        }
        if (detail) {
            const d = document.createElement('div');
            d.className = 'dlg-detail'; d.textContent = detail;
            dlg.appendChild(d);
        }

        const bar = document.createElement('div');
        bar.className = 'dlg-actions';
        const cancelAction = actions.find((a) => a.cancel);
        let picked = cancelAction ? cancelAction.value : null;   // Esc, or any other dismissal

        actions.forEach((a) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = a.label;
            if (a.variant && a.variant !== 'primary') btn.className = a.variant;
            btn.addEventListener('click', () => { picked = a.value; dlg.close(); });
            bar.appendChild(btn);
        });
        dlg.appendChild(bar);

        dlg.addEventListener('close', () => { dlg.remove(); resolve(picked); });

        document.body.appendChild(dlg);
        dlg.showModal();

        // focus the action the user most likely wants rather than whichever
        // button happens to come first in the markup
        const btns = [...bar.querySelectorAll('button')];
        const i = actions.findIndex((a) => a.variant === 'primary');
        (btns[i > -1 ? i : btns.length - 1] || btns[0]).focus();
    });
}

// The small Medicine / Supply pill under a row's name on Review and Reports;
// a supply also shows its Bizbox code beside it.
function kindTag(r) {
    if (!r) return '';
    if (r.kind === 'supply') {
        return `<div class="kind-line"><span class="kind-pill sup">Supply</span>${r.supplyCode ? `<span class="kind-code">${escapeHtml(r.supplyCode)}</span>` : ''}</div>`;
    }
    return '<div class="kind-line"><span class="kind-pill med">Medicine</span></div>';
}
