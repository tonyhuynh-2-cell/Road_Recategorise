// flagged.js — the "Flagged roads" tab: pin up to 10 roads and view them on their own map scope.
//
// Flags are UI PINS ONLY (hard project rule): pinning a road never alters its verdict, the criteria
// it is graded against, or any count/breakdown on the other tabs — verdicts are earned from the
// data, never forced. The tab reuses the normal scope machinery end to end: nswInView() (grading.js)
// hides every unpinned road while the flagged view is on screen, applyLegend() (panels.js) adds +
// restyles the SAME shared road overlay (nswLayer), and the pins draw in their normal verdict
// colours, one weight bolder for focus (nswStyle). Pins persist across reloads in localStorage
// ('flaggedRoads', a JSON array of road keys — the same roadKeyOf() grouping as NSW_ROAD_LAYERS
// and click selection, so a pin always means the WHOLE road).

const FLAG_LIMIT = 10;
const FLAG_STORE = 'flaggedRoads';

// The pinned road keys. Restored from localStorage (malformed/oversized payloads degrade to empty).
const flaggedRoads = new Set((function () {
    try {
        const a = JSON.parse(localStorage.getItem(FLAG_STORE) || '[]');
        return Array.isArray(a) ? a.filter(function (k) { return typeof k === 'string'; }).slice(0, FLAG_LIMIT) : [];
    } catch (e) { return []; }
})());

function isRoadFlagged(k) { return flaggedRoads.has(k); }

function saveFlags() {
    try { localStorage.setItem(FLAG_STORE, JSON.stringify(Array.from(flaggedRoads))); }
    catch (e) { /* storage blocked/full — pins simply stay session-only */ }
}

// The flagged view owns the map scope on its own tab AND on a Road Detail opened from it
// (mapContext stays 'flagged' there) — the same "detail keeps the lens it came from" rule the NSW
// lenses follow via nswView. Read by nswInView/nswStyle (grading.js) and applyLegend (panels.js).
function inFlaggedScope() {
    return currentTab === 'flagged' || (currentTab === 'detail' && mapContext === 'flagged');
}

// Escape a road key for an HTML attribute (name-derived keys can carry quotes/apostrophes/&).
function escFlagAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The little red flag (the pin affordance): outline when unflagged, solid when flagged. The red is
// ICON-ONLY styling (#dc2626, lifted via currentColor in dark mode) — it never recolours road
// geometry or verdict chips. currentColor comes from .flag-ico in the CSS.
function flagIconSVG(solid) {
    return '<svg class="flag-ico" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
        '<path d="M3.2 1.6 V14.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>' +
        (solid
            ? '<path d="M3.2 2.4 H12.8 L10.4 5.6 L12.8 8.8 H3.2 Z" fill="currentColor"/>'
            : '<path d="M3.2 2.4 H12.8 L10.4 5.6 L12.8 8.8 H3.2 Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" opacity="0.85"/>') +
        '</svg>';
}

// The ⚑ toggle shown in the Road Detail panel (detail.js) — a plain HTML string wired to a global
// onclick, so the same markup works from any surface (side panel or popup). Only roads the flagged
// map can actually draw (present in the shared overlay's per-road layer groups) get the button.
function flagButtonHTML(k) {
    if (!k || !(window.NSW_ROAD_LAYERS && window.NSW_ROAD_LAYERS[k])) return '';
    const on = isRoadFlagged(k);
    return '<button class="flag-btn' + (on ? ' is-flagged' : '') + '" data-key="' + escFlagAttr(k) + '"' +
        ' aria-pressed="' + on + '" aria-label="' + (on ? 'Unflag this road' : 'Flag this road') + '"' +
        ' onclick="toggleRoadFlag(this.dataset.key)">' + flagIconSVG(on) + (on ? 'Unflag' : 'Flag road') + '</button>';
}

// Flag/unflag one road (global — wired from HTML strings). The 11th pin is REJECTED: the set stays
// at 10 and the top-centre pill (showMapRefresh, state.js) says so.
function toggleRoadFlag(k) {
    if (!k) return;
    if (flaggedRoads.has(k)) {
        flaggedRoads.delete(k);
        if (typeof showMapRefresh === 'function') showMapRefresh('Road unflagged (' + flaggedRoads.size + '/' + FLAG_LIMIT + ')', 1100);
    } else {
        if (flaggedRoads.size >= FLAG_LIMIT) {
            if (typeof showMapRefresh === 'function') showMapRefresh('Flag limit reached (10 roads)', 1600);
            return;
        }
        flaggedRoads.add(k);
        if (typeof showMapRefresh === 'function') showMapRefresh('Road flagged (' + flaggedRoads.size + '/' + FLAG_LIMIT + ')', 1100);
    }
    saveFlags();
    pulseFlagTab();   // confirmation pulse on the tab button — the pin visibly lands somewhere
    // Keep every surface in sync. The detail-panel ⚑ button (only if it shows THIS road) is
    // re-rendered whole, so its icon (outline/solid), label and aria state always agree.
    const btn = document.querySelector('#detail-flag-wrap .flag-btn');
    if (btn && btn.dataset.key === k) btn.outerHTML = flagButtonHTML(k);
    // Flagged view on the map (the tab itself, or a Road Detail opened from it): refresh the
    // list/counter and restyle the map immediately — the same one-pass setStyle every tab switch
    // performs (nswStyle hides/shows by pin membership), so an unpinned road disappears at once.
    if (inFlaggedScope()) {
        // The hint fades ONLY the newly pinned row in (unflag re-renders with no animation).
        refreshFlagged({ added: flaggedRoads.has(k) ? k : null });
        if (typeof nswLayer !== 'undefined' && nswLayer) nswLayer.setStyle(nswStyle);
    }
}

// Clicking a pinned-roads list ROW selects that road — the exact effect of clicking its geometry on
// the map: highlight, frame it sensibly, open Road Detail. Mirrors selectRoadFromSearch (search.js);
// the row's unflag control (the right-hand ⚑) stops propagation so unpinning never triggers a selection.
function selectFlaggedRoad(k) {
    const a = (typeof NSW_AGG !== 'undefined' && NSW_AGG[k]) || null;
    if (!a) return;
    const layers = (window.NSW_ROAD_LAYERS || {})[k] || [];
    if (layers.length) {
        highlightRoad(layers, nswLayer);
        try { map.fitBounds(L.featureGroup(layers).getBounds().pad(0.25), { maxZoom: 13 }); } catch (e) { /* no bounds */ }
    }
    showRoadDetail(Object.assign({}, a, { ref: a.ref, road_name: a.road_name }), 'nsw');
}

// Brief attention pulse on the "Flagged roads" tab button whenever a pin lands or lifts (never on
// page load — only from toggleRoadFlag). The class self-clears; under prefers-reduced-motion the
// CSS disables the keyframes, so the toggle is a no-op visually.
function pulseFlagTab() {
    const btn = document.querySelector('.tab-btn.tab-flag');
    if (!btn) return;
    btn.classList.remove('flag-pulse');
    void btn.offsetWidth;   // restart the animation when pins change in quick succession
    btn.classList.add('flag-pulse');
    clearTimeout(pulseFlagTab._t);
    pulseFlagTab._t = setTimeout(function () { btn.classList.remove('flag-pulse'); }, 600);
}

// A pinned road's verdict, sourced EXACTLY like the tab counts do (scopeCounts, panels.js):
// computed criteria first, falling back to the rolled-up status. Read-only — never written here.
function flagVerdict(k) {
    const a = (typeof NSW_AGG !== 'undefined' && NSW_AGG[k]) || {};
    const cr = window.NSW_CRIT ? window.NSW_CRIT[k] : null;
    return (cr && cr.verdict) || a.status || 'red';
}

// Fill the Flagged tab panel: the "Flagged roads (n/10)" header + the pinned-roads list. Each row:
// name/number (with route shield), class, verdict chip, and an unflag ⚑ that updates list + map.
// Rows FADE IN (.flag-in, the riseIn idiom) rather than popping: `changed` is the optional hint
// from toggleRoadFlag — { added: key } animates just that new row; with no hint (tab entry /
// first render after reload — the panels.js call site) the whole list cascades in, 40ms apart.
// Unflag removal stays instant. prefers-reduced-motion disables it all in the CSS.
function refreshFlagged(changed) {
    // Prune pins that no longer resolve to a drawn road (stale keys from an older dataset).
    if (window.NSW_ROAD_LAYERS) {
        let dropped = false;
        flaggedRoads.forEach(function (k) { if (!window.NSW_ROAD_LAYERS[k]) { flaggedRoads.delete(k); dropped = true; } });
        if (dropped) saveFlags();
    }
    const n = flaggedRoads.size;
    const hero = document.getElementById('flag-hero-title');
    if (hero) hero.textContent = 'Flagged roads (' + n + '/' + FLAG_LIMIT + ')';
    const total = document.getElementById('flag-total');
    if (total) total.textContent = n;
    const list = document.getElementById('flag-list');
    if (!list) return;
    if (!n) {
        list.innerHTML = '<div class="flag-empty">Click any road on the map and press ⚑ Flag — up to 10.</div>';
        return;
    }
    const CHIP = { green: 'Meets', orange: 'Meets 1 of 2', red: 'Does not meet' };
    let h = '';
    let i = 0;
    flaggedRoads.forEach(function (k) {
        const a = NSW_AGG[k] || {};
        const v = flagVerdict(k);
        const cls = a.admin_class === 'S' ? 'State Road' : a.admin_class === 'R' ? 'Regional Road' : 'Road';
        const num = (a.road_number != null && String(a.road_number).trim() !== '') ? String(a.road_number).trim() : '';
        // The whole row is a click target that SELECTS the road (selectFlaggedRoad — same as clicking
        // it on the map); the remove control — a solid red ⚑ on the row's right, matching the
        // detail-panel pin's flagged state — stops propagation so unpinning never also selects
        // (on hover the CSS greys the flag and strikes it through, signalling removal).
        const anim = changed ? (changed.added === k ? ' flag-in' : '') : ' flag-in';
        const delay = (!changed && i > 0) ? ' style="animation-delay:' + (i * 40) + 'ms"' : '';
        i++;
        h += '<div class="flag-row' + anim + '"' + delay + ' data-key="' + escFlagAttr(k) + '" role="button" tabindex="0"' +
            ' aria-label="Show ' + escFlagAttr(roadName(a)) + ' on the map"' +
            ' onclick="selectFlaggedRoad(this.dataset.key)"' +
            ' onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();selectFlaggedRoad(this.dataset.key)}">' +
            '<span class="flag-row-ico">' + flagIconSVG(true) + '</span>' +
            '<span class="flag-info">' +
            '<span class="flag-name">' + roadLabel(a) + '</span>' +
            '<span class="flag-meta">' + cls + (num ? ' · ' + num : '') + '</span></span>' +
            '<span class="flag-chip fc-' + v + '">' + (CHIP[v] || v) + '</span>' +
            '<button class="flag-x" data-key="' + escFlagAttr(k) + '"' +
            ' onclick="event.stopPropagation(); toggleRoadFlag(this.dataset.key)"' +
            ' title="Unflag this road" aria-label="Unflag this road">' + flagIconSVG(true) + '</button></div>';
    });
    list.innerHTML = h;
}

// Show the flagged view on the map — the SAME shared road overlay every other tab uses, restyled so
// only the pins draw (nswInView), then framed on them. Mirrors showNSW/showSydney in panels.js.
function showFlagged() {
    if (typeof cvLayer !== 'undefined' && cvLayer) map.removeLayer(cvLayer);
    applyLegend();   // adds + restyles nswLayer (one setStyle pass — the standard tab-switch cost)
    const b = flaggedBounds();
    if (b) map.fitBounds(b.pad(0.12), { maxZoom: 14 });   // frame the pins on entry; skip when empty
    mapContext = 'flagged';
}

// Combined bounds of every pinned road's layers. The first layer's bounds are CLONED — L.Polyline
// caches and returns its internal bounds object, which must never be mutated by extend().
function flaggedBounds() {
    let b = null;
    flaggedRoads.forEach(function (k) {
        ((window.NSW_ROAD_LAYERS || {})[k] || []).forEach(function (l) {
            const lb = l.getBounds();
            if (b) b.extend(lb);
            else b = L.latLngBounds(lb.getSouthWest(), lb.getNorthEast());
        });
    });
    return b;
}
