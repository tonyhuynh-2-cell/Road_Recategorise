// search.js — road search box (by road name or road ID) over the NSW network.
// Builds a lightweight index from NSW_AGG (the per-road rolled-up aggregate). On select it makes the
// road visible in the active lens, highlights it, frames it, and opens its Road Detail panel — the
// same end state as clicking the road on the map. Loaded after grading/detail, before init (which
// calls initRoadSearch() once NSW_AGG + window.NSW_ROAD_LAYERS exist).

let ROAD_INDEX = [];     // [{key, num, name, ref, cls}]
let _rsResults = [];     // result keys currently shown (for keyboard nav)
let _rsActive = -1;      // active row index

function initRoadSearch() {
    ROAD_INDEX = [];
    const agg = (typeof NSW_AGG !== 'undefined' && NSW_AGG) || {};
    Object.keys(agg).forEach(function (key) {
        const a = agg[key];
        if (!a || (a.admin_class !== 'S' && a.admin_class !== 'R')) return;
        const num = (a.road_number != null && String(a.road_number).trim()) ? String(a.road_number).trim() : '';
        const name = (a.road_name && String(a.road_name).trim()) ? String(a.road_name).trim() : '';
        const ref = a.ref ? String(a.ref).trim() : '';
        if (!num && !name && !ref) return;
        ROAD_INDEX.push({ key: key, num: num, name: name, ref: ref, cls: a.admin_class });
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
    scored.sort(function (a, b) { return b[0] - a[0] || a[1].name.localeCompare(b[1].name); });
    const top = scored.slice(0, 12);
    _rsResults = top.map(function (x) { return x[1].key; });
    _rsActive = top.length ? 0 : -1;
    box.classList.add('rs-open');
    if (!top.length) { box.innerHTML = '<div class="rs-empty">No matching road</div>'; return; }
    box.innerHTML = top.map(function (x, i) {
        const e = x[1];
        const label = roadLabel({ road_name: e.name, ref: e.ref, admin_class: e.cls });
        const meta = (e.num ? 'ID ' + e.num : 'no ID') + ' &middot; ' + (e.cls === 'S' ? 'State' : 'Regional');
        const key = e.key.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        return '<div class="rs-item' + (i === 0 ? ' rs-on' : '') + '" data-key="' + key + '"' +
            ' onmousedown="event.preventDefault(); selectRoadFromSearch(this.getAttribute(\'data-key\'))"' +
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
    if (ev.key === 'ArrowDown') { ev.preventDefault(); rsSetActive((_rsActive + 1) % n); _rsScrollActive(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); rsSetActive((_rsActive - 1 + n) % n); _rsScrollActive(); }
    else if (ev.key === 'Enter') { ev.preventDefault(); if (_rsActive >= 0) selectRoadFromSearch(_rsResults[_rsActive]); }
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
function selectRoadFromSearch(key) {
    const agg = (typeof NSW_AGG !== 'undefined' && NSW_AGG) || {};
    const a = agg[key];
    if (!a) return;
    hideRoadResults();
    const inp = document.getElementById('rs-input');
    if (inp) { inp.value = roadName({ road_name: a.road_name, admin_class: a.admin_class }); inp.blur(); }
    // If the road is hidden in the active lens, drop to Overview (shows all State + Regional roads).
    if (typeof nswInView === 'function' && !nswInView(a)) switchTab('overview');
    const layers = (window.NSW_ROAD_LAYERS || {})[key] || [];
    if (layers.length) {
        highlightRoad(layers, nswLayer);
        try { map.fitBounds(L.featureGroup(layers).getBounds().pad(0.25), { maxZoom: 13 }); } catch (e) { /* no bounds */ }
    }
    showRoadDetail(Object.assign({}, a, { ref: a.ref, road_name: a.road_name }), 'nsw');
}

// Close the dropdown when clicking outside the search box.
document.addEventListener('click', function (e) {
    const wrap = document.getElementById('road-search');
    if (wrap && !wrap.contains(e.target)) hideRoadResults();
});
