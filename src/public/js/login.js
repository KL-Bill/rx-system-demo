(async function () {
    const $ = (id) => document.getElementById(id);

    // IT lands on the IT console, pharmacy on the review dashboard
    const home = (user) => (user.role === 'it' ? '/it' : '/dashboard');

    // already signed in? go straight home
    const me = await api('/api/auth/me');
    if (me.ok) { window.location.href = home(me.data.user); return; }

    const err = $('err');
    function showErr(msg) { err.textContent = msg; err.classList.add('show'); }

    async function submit() {
        err.classList.remove('show');
        const res = await api('/api/auth/login', {
            body: { username: $('username').value.trim(), password: $('password').value },
        });
        if (res.ok) { window.location.href = home(res.data.user); }
        else { showErr(res.data.message || 'Login failed'); }
    }

    $('loginBtn').onclick = submit;
    $('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
})();
