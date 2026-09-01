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

// ---------- notify(): the in-page replacement for alert() ----------
// Never call alert()/confirm() from these pages. They open a real OS dialog,
// and the stations run the kiosk Electron client: when that dialog closes,
// Windows does not reliably hand keyboard focus back to the page. Everything
// still paints and the mouse still works, so nothing looks broken — but no
// keystroke reaches any field. Nurses reported this as "the screen froze";
// it never froze, it just went deaf. A banner drawn inside the page cannot
// take focus off the window, so the caret stays where it was.
//   opts.kind    'err' (default) | 'warn' | 'ok'
//   opts.focus   id or element to put the caret in — usually the field to fix
//   opts.timeout ms before it fades; 0 keeps it until dismissed
//   opts.onClose runs once, after fade or dismissal
function notify(message, opts = {}) {
    const { kind = 'err', focus = null, timeout = 6000, onClose = null } = opts;

    let host = document.getElementById('toasts');
    if (!host) {
        host = document.createElement('div');
        host.id = 'toasts';
        host.className = 'toasts';
        host.setAttribute('aria-live', 'assertive');
        document.body.appendChild(host);
    }

    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = '<span class="toast-msg"></span><button class="toast-x" type="button" tabindex="-1" aria-label="Dismiss">✕</button>';
    el.querySelector('.toast-msg').textContent = message;

    let closed = false;
    function close() {
        if (closed) return;
        closed = true;
        el.classList.add('out');
        setTimeout(() => { el.remove(); if (onClose) onClose(); }, 200);
    }
    // mousedown + preventDefault, not click: clicking a button focuses it, and
    // the whole point here is to leave the user's focus alone
    el.querySelector('.toast-x').addEventListener('mousedown', (e) => { e.preventDefault(); close(); });

    host.appendChild(el);
    if (timeout) setTimeout(close, timeout);

    if (focus) {
        const f = typeof focus === 'string' ? document.getElementById(focus) : focus;
        if (f) f.focus();
    }
    return close;
}

// ---------- showDialog(): the in-page modal ----------
// For the few messages that must be acknowledged before anything else happens.
// A native <dialog> + showModal(), not a hand-rolled overlay: the browser puts
// it in the top layer, makes the page behind it inert, traps Tab inside it,
// closes it on Esc and — the part that matters here — hands focus back to
// whatever was focused before it opened. None of that is an OS window, so it
// costs the page nothing the way alert() did (see notify() above).
// Most messages do NOT belong here. A modal demands a click before the user
// can carry on typing, which is the interruption alert() was punishing them
// with; validation nudges and transient errors stay on notify().
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
