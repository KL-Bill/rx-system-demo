// tiny fetch wrapper shared by all pages
async function api(path, opts = {}) {
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
