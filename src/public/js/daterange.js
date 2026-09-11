/* One date-range picker for every page.
 *
 * Every page that filters by date already has a From box and a To box, and
 * its own code reads them ($('from').value). Rather than replace those, this
 * attaches to the pair: a "Quick range" menu goes beside them, a reversed
 * range is swapped as it is typed, and the choice can be remembered per
 * browser. Existing code keeps reading the same two inputs.
 *
 *   const dr = DateRange.enhance(fromInput, toInput, { storageKey, defaultPreset, onChange })
 *     storageKey     remember the choice in localStorage (per browser = per kiosk)
 *     defaultPreset  used when nothing is remembered: 'all' (default), 'today', '7', ...
 *     onChange       called after a quick pick; without it, a 'change' event is
 *                    dispatched on the To box so the page's own handler runs
 *   dr.apply(preset)  set a preset from code
 *   dr.label()        "All time", "Last 7 days", "09/01/26 – 09/11/26"
 *
 * Relative presets are stored by name, not as dates, so "Last 7 days" still
 * means the last seven days when the page is opened next week.
 */
(function (global) {
    const pad = (n) => String(n).padStart(2, '0');
    const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const PRESETS = [
        ['today', 'Today'],
        ['7', 'Last 7 days'],
        ['30', 'Last 30 days'],
        ['month', 'This month'],
        ['lastmonth', 'Last month'],
        ['all', 'All time'],
    ];
    const LABEL = Object.fromEntries(PRESETS);

    // -> { from, to } as YYYY-MM-DD ('' = open end)
    function rangeFor(key) {
        const now = new Date();
        const today = iso(now);
        const back = (days) => { const d = new Date(now); d.setDate(d.getDate() - (days - 1)); return iso(d); };
        switch (key) {
            case 'today': return { from: today, to: today };
            case '7': return { from: back(7), to: today };
            case '30': return { from: back(30), to: today };
            case 'month': return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
            case 'lastmonth': return {
                from: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
                to: iso(new Date(now.getFullYear(), now.getMonth(), 0)),
            };
            default: return { from: '', to: '' };
        }
    }
    const short = (s) => { if (!s) return ''; const [y, m, d] = s.split('-'); return `${m}/${d}/${y.slice(2)}`; };

    function enhance(fromEl, toEl, opts = {}) {
        const { storageKey, defaultPreset = 'all', onChange } = opts;
        const sel = document.createElement('select');
        sel.className = 'dr-quick';
        sel.title = 'Quick range';
        sel.innerHTML = PRESETS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')
            + '<option value="custom">Custom dates</option>';
        toEl.insertAdjacentElement('afterend', sel);

        const save = (v) => { if (!storageKey) return; try { localStorage.setItem(storageKey, JSON.stringify(v)); } catch { /* private mode */ } };
        const fill = (key) => { const r = rangeFor(key); fromEl.value = r.from; toEl.value = r.to; sel.value = key; };
        const fire = () => { if (onChange) onChange(); else toEl.dispatchEvent(new Event('change', { bubbles: true })); };

        // remembered choice, else the default; no event — the page loads after this
        let saved = null;
        if (storageKey) { try { saved = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { saved = null; } }
        if (saved && saved.preset && LABEL[saved.preset]) fill(saved.preset);
        else if (saved && (saved.from || saved.to)) { fromEl.value = saved.from || ''; toEl.value = saved.to || ''; sel.value = 'custom'; }
        else fill(defaultPreset);

        sel.addEventListener('change', () => {
            if (sel.value === 'custom') { fromEl.focus(); return; }
            fill(sel.value);
            save({ preset: sel.value });
            fire();
        });
        // typed dates: swap a reversed range before the page's own handler reads it
        // (capture runs first on the target), and remember them as custom
        const typed = () => {
            if (fromEl.value && toEl.value && fromEl.value > toEl.value) { const t = fromEl.value; fromEl.value = toEl.value; toEl.value = t; }
            sel.value = fromEl.value || toEl.value ? 'custom' : 'all';
            save(sel.value === 'all' ? { preset: 'all' } : { from: fromEl.value, to: toEl.value });
        };
        fromEl.addEventListener('change', typed, { capture: true });
        toEl.addEventListener('change', typed, { capture: true });

        return {
            apply: (key) => { fill(key); save({ preset: key }); },
            label: () => (sel.value !== 'custom' ? LABEL[sel.value]
                : `${short(fromEl.value) || '…'} – ${short(toEl.value) || '…'}`),
            select: sel,
        };
    }

    global.DateRange = { enhance, rangeFor, PRESETS };
})(window);
