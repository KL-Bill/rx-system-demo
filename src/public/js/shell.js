/* Shared console shell: hover-expanding icon rail + filter drawer helper. */
(function (global) {
    const svg = (paths) =>
        `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

    const ICONS = {
        rx: svg('<path d="M5 21V4a1 1 0 0 1 1-1h4a4 4 0 0 1 0 8H5"/><path d="m12 11 8 10"/><path d="m20 11-8 10"/>'),
        review: svg('<rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><path d="m9 14 2 2 4-4"/>'),
        reports: svg('<path d="M3 3v18h18"/><path d="M8 17v-5"/><path d="M13 17V8"/><path d="M18 17v-8"/>'),
        logs: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/>'),
        logout: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>'),
        login: svg('<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>'),
        user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
        filter: svg('<path d="M3 4h18l-7 8v6l-4 2v-8z"/>'),
        it: svg('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>'),
    };

    const link = (href, key, label, icon, active) =>
        `<a class="rail-item${active === key ? ' active' : ''}" href="${href}">
            <span class="ico">${icon}</span><span class="txt">${label}</span></a>`;

    // mode: 'pharmacy' | 'nurse' | 'it';  active: 'rx' | 'review' | 'reports' | 'logs' | 'it'
    function mountRail({ mode, active }) {
        const nav = document.createElement('nav');
        nav.className = 'rail';

        if (mode === 'it') {
            nav.innerHTML = `
                <div class="rail-logo"><img src="/img/logo.jpg" alt="TMC"><span class="txt">TMC IT</span></div>
                <div class="rail-group">
                    <div class="rail-label">IT CONSOLE</div>
                    ${link('/it', 'it', 'IT Console', ICONS.it, active)}
                </div>
                <div class="rail-spacer"></div>
                <div class="rail-group">
                    <div class="rail-label">ACCOUNT</div>
                    <div class="rail-item" style="cursor:default">
                        <span class="ico">${ICONS.user}</span><span class="txt" id="railUser"></span>
                    </div>
                    <button class="rail-item" type="button" id="railLogout">
                        <span class="ico">${ICONS.logout}</span><span class="txt">Logout</span>
                    </button>
                </div>`;
        } else if (mode === 'nurse') {
            nav.innerHTML = `
                <div class="rail-logo"><img src="/img/logo.jpg" alt="TMC"><span class="txt">TMC Rx</span></div>
                <div class="rail-group">
                    <div class="rail-label">NURSE STATION</div>
                    ${link('/', 'rx', 'New Prescription', ICONS.rx, active)}
                </div>
                <div class="rail-spacer"></div>
                <div class="rail-group">
                    <div class="rail-label">PHARMACY</div>
                    ${link('/login', 'login', 'Pharmacy Login', ICONS.login, active)}
                </div>`;
        } else {
            nav.innerHTML = `
                <div class="rail-logo"><img src="/img/logo.jpg" alt="TMC"><span class="txt">TMC Pharmacy</span></div>
                <div class="rail-group">
                    <div class="rail-label">PHARMACY</div>
                    ${link('/dashboard', 'review', 'Review', ICONS.review, active)}
                    ${link('/reports', 'reports', 'Reports', ICONS.reports, active)}
                    ${link('/logs', 'logs', 'Logs', ICONS.logs, active)}
                </div>
                <div class="rail-spacer"></div>
                <div class="rail-group">
                    <div class="rail-label">ACCOUNT</div>
                    <div class="rail-item" style="cursor:default">
                        <span class="ico">${ICONS.user}</span><span class="txt" id="railUser"></span>
                    </div>
                    <button class="rail-item" type="button" id="railLogout">
                        <span class="ico">${ICONS.logout}</span><span class="txt">Logout</span>
                    </button>
                </div>`;
        }
        document.body.prepend(nav);

        const lo = document.getElementById('railLogout');
        if (lo) lo.onclick = async () => { await api('/api/auth/logout', { body: {} }); window.location.href = '/'; };
    }

    // wires the "Filters" button <-> right drawer. The drawer OVERLAYS the content —
    // the table keeps its width instead of being squeezed into a scrollbar.
    function initDrawer(btnId) {
        const drawer = document.querySelector('.drawer');
        const btn = document.getElementById(btnId);
        if (!drawer || !btn) return;
        const set = (on) => drawer.classList.toggle('open', on);
        btn.onclick = () => set(!drawer.classList.contains('open'));
        const close = drawer.querySelector('[data-close]');
        if (close) close.onclick = () => set(false);
    }

    global.mountRail = mountRail;
    global.initDrawer = initDrawer;
    global.ICONS = ICONS;
})(window);
