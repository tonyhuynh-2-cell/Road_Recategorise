// search.js — road search box (by road name or road ID) over the NSW network.
// Builds a lightweight index from NSW_AGG (the per-road rolled-up aggregate). On select it makes the
// road visible in the active lens, highlights it, frames it, and opens its Road Detail panel — the
// same end state as clicking the road on the map. Loaded after grading/detail, before init (which
// calls initRoadSearch() once NSW_AGG + window.NSW_ROAD_LAYERS exist).

let ROAD_INDEX = [];     // [{key, num, name, ref, cls}]
let _rsResults = [];     // [{key,name}] results currently shown (for keyboard nav)
let _rsActive = -1;      // active row index
let _rsTabStarted = false; // Tab-cycle: has Tab advanced past the top result yet

function initRoadSearch() {
    ROAD_INDEX = [];
    const agg = (typeof NSW_AGG !== 'undefined' && NSW_AGG) || {};
    Object.keys(agg).forEach(function (key) {
        const a = agg[key];
        if (!a || (a.admin_class !== 'S' && a.admin_class !== 'R')) return;
        const num = (a.road_number != null && String(a.road_number).trim()) ? String(a.road_number).trim() : '';
        // Index EVERY distinct name the road carries — a single road_number can span several named sections
        // (e.g. 0000090 = The Bucketts Way + Wallanbah Rd), so any of its names should find it. One entry per
        // name (all sharing the key); the dropdown de-dupes by key and shows the best-matching name.
        let names = (a._names && a._names.length) ? a._names.slice() : [];
        const primaryName = (a.road_name && String(a.road_name).trim()) ? String(a.road_name).trim() : '';
        if (primaryName && names.indexOf(primaryName) === -1) names.unshift(primaryName);
        if (!names.length) names = [''];
        const hasRef = !!a.ref || Object.keys(a._nameRefs || {}).length > 0;
        if (!num && !hasRef && !names.some(function (n) { return n; })) return;
        names.forEach(function (nm) {
            const nameRef = a._nameRefs && a._nameRefs[nm] ? a._nameRefs[nm] : a.ref;
            ROAD_INDEX.push({ key: key, num: num, name: nm, ref: nameRef ? String(nameRef).trim() : '', cls: a.admin_class, pri: nm === primaryName });
        });
    });
}

// Score a candidate against the lowercased query; -1 = no match. Higher = better.
function _scoreRoad(e, q) {
    const num = e.num.toLowerCase(), name = e.name.toLowerCase(), ref = e.ref.toLowerCase();
    if (num && num === q) return 100;
    if (ref && ref === q) return 95;
    if (num && num.indexOf(q) === 0) return 90;
    if (name && name.indexOf(q) === 0) return 80;
    if (ref && ref.indexOf(q) === 0) return 78;
    if (name && name.indexOf(q) !== -1) return 60;
    if (num && num.indexOf(q) !== -1) return 50;
    return -1;
}

function onRoadSearchInput(val) {
    const q = String(val || '').trim().toLowerCase();
    const box = document.getElementById('rs-results');
    const wrap = document.getElementById('road-search');
    if (wrap) wrap.classList.toggle('rs-has-text', q.length > 0);
    if (!box) return;
    if (q.length < 1) { box.innerHTML = ''; box.classList.remove('rs-open'); _rsResults = []; _rsActive = -1; return; }
    const scored = [];
    for (let i = 0; i < ROAD_INDEX.length; i++) {
        const s = _scoreRoad(ROAD_INDEX[i], q);
        if (s >= 0) scored.push([s, ROAD_INDEX[i]]);
    }
    scored.sort(function (a, b) { return b[0] - a[0] || ((b[1].pri ? 1 : 0) - (a[1].pri ? 1 : 0)) || a[1].name.localeCompare(b[1].name); });
    // De-dupe by road key — a road indexed under several names can match more than once; keep its
    // best-scoring name (already first after the sort) so each road appears once.
    const seenKeys = {}, top = [];
    for (let i = 0; i < scored.length && top.length < 12; i++) {
        const e = scored[i][1];
        if (seenKeys[e.key]) continue;
        seenKeys[e.key] = 1;
        top.push(scored[i]);
    }
    _rsResults = top.map(function (x) { return { key: x[1].key, name: x[1].name, ref: x[1].ref }; });
    _rsActive = top.length ? 0 : -1;
    _rsTabStarted = false;   // new result list — Tab restarts from the top result
    box.classList.add('rs-open');
    if (!top.length) { box.innerHTML = '<div class="rs-empty">No matching road</div>'; return; }
    box.innerHTML = top.map(function (x, i) {
        const e = x[1];
        const label = roadLabel({ road_name: e.name, ref: e.ref, admin_class: e.cls });
        const meta = (e.num ? 'ID ' + e.num : 'no ID') + ' &middot; ' + (e.cls === 'S' ? 'State' : 'Regional');
        const key = e.key.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        const name = e.name.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        const ref = e.ref.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        return '<div class="rs-item' + (i === 0 ? ' rs-on' : '') + '" data-key="' + key + '"' +
            ' data-name="' + name + '"' +
            ' data-ref="' + ref + '"' +
            ' onmousedown="event.preventDefault(); selectRoadFromSearch(this.getAttribute(\'data-key\'), this.getAttribute(\'data-name\'), this.getAttribute(\'data-ref\'))"' +
            ' onmouseenter="rsSetActive(' + i + ')">' +
            '<div class="rs-name">' + label + '</div><div class="rs-meta">' + meta + '</div></div>';
    }).join('');
}

function rsSetActive(i) {
    _rsActive = i;
    document.querySelectorAll('#rs-results .rs-item').forEach(function (el, k) {
        el.classList.toggle('rs-on', k === i);
    });
}

function onRoadSearchKey(ev) {
    if (ev.key === 'Escape') { clearRoadSearch(); return; }
    const n = _rsResults.length;
    if (!n) return;
    const box = document.getElementById('rs-results');
    const open = !!(box && box.classList.contains('rs-open'));
    if (ev.key === 'ArrowDown') { ev.preventDefault(); rsSetActive((_rsActive + 1) % n); _rsScrollActive(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); rsSetActive((_rsActive - 1 + n) % n); _rsScrollActive(); }
    else if (ev.key === 'Tab' && open) {
        // Tab cycles the highlighted road (1st, 2nd, 3rd… wrapping) and previews its name in the box; Shift+Tab
        // steps back. First Tab commits to the top result; Enter loads the highlighted road.
        ev.preventDefault();
        let idx;
        if (ev.shiftKey) idx = (_rsActive - 1 + n) % n;
        else if (_rsTabStarted) idx = (_rsActive + 1) % n;
        else idx = (_rsActive < 0 ? 0 : _rsActive);
        _rsTabStarted = true;
        rsSetActive(idx);
        _rsScrollActive();
        const inp = document.getElementById('rs-input');
        const item = document.querySelectorAll('#rs-results .rs-item')[idx];
        const nm = item && item.querySelector('.rs-name');
        if (inp && nm) inp.value = nm.textContent;
    }
    else if (ev.key === 'Enter') {
        ev.preventDefault();
        if (_rsActive >= 0) selectRoadFromSearch(_rsResults[_rsActive].key, _rsResults[_rsActive].name, _rsResults[_rsActive].ref);
    }
}
function _rsScrollActive() {
    const el = document.querySelectorAll('#rs-results .rs-item')[_rsActive];
    if (el) el.scrollIntoView({ block: 'nearest' });
}

function hideRoadResults() {
    const box = document.getElementById('rs-results'); if (box) box.classList.remove('rs-open');
}
function clearRoadSearch() {
    const inp = document.getElementById('rs-input'); if (inp) { inp.value = ''; inp.focus(); }
    onRoadSearchInput('');
}

// Jump to a road: ensure it's shown in the current lens, highlight it, frame it, open Road Detail.
function selectRoadFromSearch(key, matchedName, matchedRef) {
    const agg = (typeof NSW_AGG !== 'undefined' && NSW_AGG) || {};
    const a = agg[key];
    if (!a) return;
    const selected = Object.assign({}, a, {
        ref: matchedRef || null,
        road_name: matchedName || a.road_name
    });
    if (typeof traceCode === 'function') traceCode(
        'Search selected road: ' + roadName(selected),
        'Road search jumps to the stored road group, highlights its map layers, frames the map, then opens the same road detail path as a click.',
        "function selectRoadFromSearch(key) {\n  const a = NSW_AGG[key];\n  if (!nswInView(a)) switchTab('overview');\n  const layers = window.NSW_ROAD_LAYERS[key];\n  highlightRoad(layers, nswLayer);\n  map.fitBounds(L.featureGroup(layers).getBounds());\n  showRoadDetail(a, 'nsw');\n}",
        'road key=' + key
    );
    hideRoadResults();
    const inp = document.getElementById('rs-input');
    if (inp) { inp.value = roadName(selected); inp.blur(); }
    // If the road is hidden in the active lens, drop to Overview (shows all State + Regional roads).
    if (typeof nswInView === 'function' && !nswInView(a)) switchTab('overview');
    const layers = (window.NSW_ROAD_LAYERS || {})[key] || [];
    if (layers.length) {
        highlightRoad(layers, nswLayer, matchedName);
        try { map.fitBounds(L.featureGroup(layers).getBounds().pad(0.25), { maxZoom: 13 }); } catch (e) { /* no bounds */ }
    }
    showRoadDetail(selected, 'nsw');
}

// Close the dropdown when clicking outside the search box.
document.addEventListener('click', function (e) {
    const wrap = document.getElementById('road-search');
    if (wrap && !wrap.contains(e.target)) hideRoadResults();
});
