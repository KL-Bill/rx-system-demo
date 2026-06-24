// tiny fetch wrapper shared by all pages
async function api(path, opts = {}) {
    const res = await fetch(path, {
        method: opts.method || (opts.body ? 'POST' : 'GET'),
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: opts.body ? JSON.stringify(opts.body) : undefined,
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
