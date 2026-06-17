(async function () {
    const $ = (id) => document.getElementById(id);

    // already signed in? go straight to the dashboard
    const me = await api('/api/auth/me');
    if (me.ok) { window.location.href = '/dashboard'; return; }

    const err = $('err');
    function showErr(msg) { err.textContent = msg; err.classList.add('show'); }

    async function submit() {
        err.classList.remove('show');
        const res = await api('/api/auth/login', {
            body: { username: $('username').value.trim(), password: $('password').value },
        });
        if (res.ok) { window.location.href = '/dashboard'; }
        else { showErr(res.data.message || 'Login failed'); }
    }

    $('loginBtn').onclick = submit;
    $('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
})();
