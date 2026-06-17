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
