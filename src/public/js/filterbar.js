/* Notion-style filter bar.
 *
 * A row above a table: "+ Add filter" opens a small popover — pick a
 * property, an operator, a value — and the result sits in the bar as a chip
 * ("Department is ER ✕"). Chips are AND-ed, click one to edit it, "Clear all"
 * removes them. Filters persist in localStorage per page, so a station's
 * kiosk client opens the way it was left.
 *
 *   FilterBar.create({ mount, storageKey, fields, onChange, quick })
 *     quick: [{ label, filter: { key, op, value } }] -- one-click toggles shown
 *       beside "Add filter" (e.g. "Branded only"); a click adds the chip, a
 *       second click removes it
 *     fields: [{ key, label, type, get, options }]
 *       type    'enum' | 'text' | 'number' | 'date'
 *       get     row -> value (a scalar, or an array for "any of these")
 *       options enum only: [{ value, label }] or a function returning that,
 *               called when the popover opens (departments come from the data)
 *   -> { apply(rows), filters(), clear(), summary() }
 *
 * Everything is client-side over rows already loaded — the review and the
 * report both hold their whole result set, so there is no round trip.
 */
(function (global) {
    const OPS = {
        enum: [['is', 'is'], ['is_not', 'is not'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
        text: [['contains', 'contains'], ['not_contains', 'does not contain'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
        number: [['gte', 'is at least'], ['lte', 'is at most'], ['eq', 'is exactly']],
        date: [['after', 'is on or after'], ['before', 'is on or before']],
    };
    const NEEDS_VALUE = (op) => op !== 'empty' && op !== 'not_empty';
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function create({ mount, storageKey, fields, onChange, quick = [] }) {
        const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
        let filters = [];
        try { filters = (JSON.parse(localStorage.getItem(storageKey) || '[]') || []).filter((f) => byKey[f.key]); } catch { filters = []; }

        const save = () => { try { localStorage.setItem(storageKey, JSON.stringify(filters)); } catch { /* private mode */ } };
        const optionsOf = (def) => (typeof def.options === 'function' ? def.options() : def.options) || [];
        const labelOfValue = (def, value) => {
            if (def.type === 'enum') { const o = optionsOf(def).find((x) => String(x.value) === String(value)); return o ? o.label : value; }
            return value;
        };

        // ---- matching ----
        const isBlank = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
        function matches(row, f) {
            const def = byKey[f.key];
            if (!def) return true;
            const v = def.get(row);
            if (f.op === 'empty') return isBlank(v);
            if (f.op === 'not_empty') return !isBlank(v);
            const want = f.value;
            if (def.type === 'enum') {
                const has = Array.isArray(v) ? v.map(String).includes(String(want)) : String(v) === String(want);
                return f.op === 'is' ? has : !has;
            }
            if (def.type === 'text') {
                const hay = (Array.isArray(v) ? v.join(' ') : String(v ?? '')).toLowerCase();
                const has = hay.includes(String(want).toLowerCase());
                return f.op === 'contains' ? has : !has;
            }
            if (def.type === 'number') {
                const n = Number(v), w = Number(want);
                if (!Number.isFinite(n) || !Number.isFinite(w)) return false;
                return f.op === 'gte' ? n >= w : f.op === 'lte' ? n <= w : n === w;
            }
            if (def.type === 'date') {
                if (!v) return false;
                const day = new Date(want + 'T00:00:00').getTime();
                return f.op === 'after' ? v >= day : v <= day + 86399999;
            }
            return true;
        }

        // ---- bar ----
        mount.classList.add('fbar');
        const sameFilter = (a, b) => a.key === b.key && a.op === b.op && String(a.value ?? '') === String(b.value ?? '');
        function render() {
            const chips = filters.map((f, i) => {
                const def = byKey[f.key];
                const op = (OPS[def.type].find(([k]) => k === f.op) || [])[1] || f.op;
                const val = NEEDS_VALUE(f.op) ? `<b>${esc(labelOfValue(def, f.value))}</b>` : '';
                return `<span class="fchip" data-i="${i}" title="Click to edit"><span class="k">${esc(def.label)}</span> <span class="o">${esc(op)}</span> ${val}<button type="button" class="x" data-x="${i}" title="Remove">✕</button></span>`;
            }).join('');
            const quicks = quick.map((q, i) => `<button type="button" class="fquick ${filters.some((f) => sameFilter(f, q.filter)) ? 'on' : ''}" data-q="${i}">${esc(q.label)}</button>`).join('');
            mount.innerHTML = `
                <div class="frow frow-top">
                    <button type="button" class="fadd" id="${mount.id}-add">+ Add filter</button>
                    ${quicks}
                    ${filters.length ? `<button type="button" class="fclear" id="${mount.id}-clear">Clear all</button>` : ''}
                </div>
                ${filters.length ? `<div class="frow frow-chips">${chips}<span class="fcount" id="${mount.id}-count"></span></div>` : ''}`;
            mount.querySelectorAll('.fchip').forEach((c) => { c.onclick = (e) => { if (e.target.closest('.x')) return; openPopover(c, Number(c.dataset.i)); }; });
            mount.querySelectorAll('.fchip .x').forEach((x) => { x.onclick = () => { filters.splice(Number(x.dataset.x), 1); commit(); }; });
            mount.querySelector('.fadd').onclick = (e) => openPopover(e.currentTarget, -1);
            mount.querySelectorAll('.fquick').forEach((btn) => {
                btn.onclick = () => {
                    const q = quick[Number(btn.dataset.q)].filter;
                    const at = filters.findIndex((f) => sameFilter(f, q));
                    if (at >= 0) filters.splice(at, 1); else filters.push({ ...q });
                    commit();
                };
            });
            const clr = mount.querySelector('.fclear');
            if (clr) clr.onclick = () => { filters = []; commit(); };
        }
        function commit() { save(); render(); if (onChange) onChange(); }

        // ---- popover ----
        let pop = null;
        function closePopover() { if (pop) { pop.remove(); pop = null; document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); } }
        const onDoc = (e) => { if (pop && !pop.contains(e.target)) closePopover(); };
        const onKey = (e) => { if (e.key === 'Escape') closePopover(); };

        function openPopover(anchor, index) {
            closePopover();
            const editing = index >= 0 ? filters[index] : null;
            pop = document.createElement('div');
            pop.className = 'fpop';
            pop.innerHTML = `
                <div class="fpop-row">
                    <select class="f-field">${fields.map((f) => `<option value="${esc(f.key)}">${esc(f.label)}</option>`).join('')}</select>
                    <select class="f-op"></select>
                    <span class="f-val"></span>
                </div>
                <div class="fpop-actions">
                    ${editing ? '<button type="button" class="ghost sm f-remove">Remove</button>' : ''}
                    <span class="sp"></span>
                    <button type="button" class="ghost sm f-cancel">Cancel</button>
                    <button type="button" class="sm f-apply">${editing ? 'Update' : 'Add'}</button>
                </div>`;
            const fieldSel = pop.querySelector('.f-field'), opSel = pop.querySelector('.f-op'), valWrap = pop.querySelector('.f-val');

            const fillOps = (keepOp) => {
                const def = byKey[fieldSel.value];
                opSel.innerHTML = OPS[def.type].map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
                if (keepOp && OPS[def.type].some(([k]) => k === keepOp)) opSel.value = keepOp;
                fillValue();
            };
            const fillValue = (keepValue) => {
                const def = byKey[fieldSel.value];
                if (!NEEDS_VALUE(opSel.value)) { valWrap.innerHTML = ''; return; }
                if (def.type === 'enum') {
                    valWrap.innerHTML = `<select class="f-value">${optionsOf(def).map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select>`;
                } else {
                    const type = def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text';
                    valWrap.innerHTML = `<input class="f-value" type="${type}" placeholder="${def.type === 'text' ? 'Type a value…' : ''}">`;
                }
                if (keepValue != null) valWrap.querySelector('.f-value').value = keepValue;
            };
            fieldSel.onchange = () => fillOps();
            opSel.onchange = () => fillValue();
            if (editing) { fieldSel.value = editing.key; fillOps(editing.op); fillValue(editing.value); }
            else fillOps();

            pop.querySelector('.f-cancel').onclick = closePopover;
            const rm = pop.querySelector('.f-remove');
            if (rm) rm.onclick = () => { filters.splice(index, 1); closePopover(); commit(); };
            const apply = () => {
                const f = { key: fieldSel.value, op: opSel.value };
                if (NEEDS_VALUE(f.op)) {
                    const inp = valWrap.querySelector('.f-value');
                    f.value = inp ? inp.value.trim() : '';
                    if (f.value === '') { if (inp) inp.focus(); return; }
                }
                if (editing) filters[index] = f; else filters.push(f);
                closePopover(); commit();
            };
            pop.querySelector('.f-apply').onclick = apply;
            pop.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName !== 'SELECT') { e.preventDefault(); apply(); } });

            // under the anchor, inside the bar so it scrolls with the page
            mount.appendChild(pop);
            const a = anchor.getBoundingClientRect(), m = mount.getBoundingClientRect();
            pop.style.left = Math.max(0, Math.min(a.left - m.left, m.width - pop.offsetWidth - 8)) + 'px';
            pop.style.top = (a.bottom - m.top + 6) + 'px';
            setTimeout(() => { document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey); }, 0);
            const first = pop.querySelector('.f-value') || fieldSel;
            first.focus();
        }

        render();
        return {
            apply: (rows) => rows.filter((r) => filters.every((f) => matches(r, f))),
            filters: () => filters.slice(),
            clear: () => { filters = []; commit(); },
            setCount: (shown, total) => { const c = mount.querySelector('.fcount'); if (c) c.textContent = filters.length ? `${shown} of ${total}` : ''; },
            // one line for a report header: "Department is ER · # RX is at least 3"
            summary: () => filters.map((f) => {
                const def = byKey[f.key];
                const op = (OPS[def.type].find(([k]) => k === f.op) || [])[1] || f.op;
                return `${def.label} ${op}${NEEDS_VALUE(f.op) ? ' ' + labelOfValue(def, f.value) : ''}`;
            }).join(' · '),
        };
    }

    global.FilterBar = { create };
})(window);
