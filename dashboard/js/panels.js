// panels.js — tab switching, NSW/CV map show, and the lens + overview stat panels.

// Area filter: when an area is selected from the dropdown, switch to that area's tab.
// When the category dropdown changes while an area is active, keep that area open
// (which will re-filter by the current nswView/lens).
let _activeArea = '';

function setArea(area) {
    _activeArea = area || '';
    if (area) {
        // Switch to the selected area tab (Sydney or Clarence Valley)
        switchTab(area);
    } else {
        // "All NSW" — go back to the current lens on the NSW overview
        const lens = document.getElementById('lens-select');
        switchTab(lens ? lens.value : 'overview');
    }
}

// Override the lens-select onchange to preserve the selected area
(function() {
    const origOnChange = function(val) {
        if (_activeArea) {
            // Update the lens (nswView) directly without switching away from the area tab.
            // This avoids the zoom-out-then-back-in that switchTab(val) would cause.
            nswView = (val === 'overview') ? 'all' : val;
            // Sync the lens dropdown display
            const sel = document.getElementById('lens-select');
            if (sel) sel.value = val;
            // Re-render the area view with the new lens applied (road styling uses nswView)
            if (_activeArea === 'cv') { refreshCV(); showCV(); }
            else if (_activeArea === 'sydney') { refreshSydney(); showSydney(); }
            renderMapLegend();
        } else {
            switchTab(val);
        }
    };
    // Attach after DOM ready
    document.addEventListener('DOMContentLoaded', function() {
        const sel = document.getElementById('lens-select');
        if (sel) sel.onchange = function() { origOnChange(this.value); };
    });
})();

function switchTab(tab) {
    if (tab === 'detail' && currentTab !== 'detail') lastViewTab = currentTab;   // remember where to return
    if (tab !== 'detail' && typeof clearSelectedRoad === 'function') clearSelectedRoad();
    // Keep Area dropdown in sync
    const areaSel = document.getElementById('area-select');
    if (areaSel) {
        if (tab === 'sydney' || tab === 'cv') areaSel.value = tab;
        else if (tab !== 'detail' && !_activeArea) areaSel.value = '';
    }
    if (typeof traceCode === 'function') traceCode(
        'Tab switch: ' + tab,
        tab === 'detail'
            ? 'showRoadDetail() calls switchTab("detail") internally. This does not run a new map assessment; it only swaps the sidebar from the map summary panel to the road detail panel.'
            : 'The tab button calls switchTab(). This updates the active sidebar panel, chooses the matching map lens, then calls the view function for that tab.',
        "function switchTab(tab) {\n  currentTab = tab;\n  const contentId = tab === 'overview' ? 'overview'\n    : NSW_LENSES.includes(tab) ? 'nsw' : tab;\n  document.getElementById(`tab-${contentId}`).classList.add('active');\n\n  if (NSW_MAP_TABS.includes(tab)) {\n    refresh the NSW map view;\n  } else if (tab === 'cv') {\n    refreshCV(); showCV();\n  } else if (tab === 'sydney') {\n    refreshSydney(); showSydney();\n  } else if (tab === 'detail') {\n    // no new map calculation; just show the detail sidebar\n  }\n}",
        'previous tab: ' + currentTab + ' -> next tab: ' + tab
    );
    currentTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    const btn = document.querySelector(`.tab-btn[onclick*="'${tab}'"]`);
    if (btn) btn.classList.add('active');
    // The lens dropdown (#lens-select) carries .tab-btn, so the sweep above just stripped its
    // active look; re-sync its value + active state for the new tab (see syncLensSelect below).
    syncLensSelect(tab);
    // Overview has its own panel; the three lenses share #tab-nsw; CV and Detail have their own.
    const contentId = (tab === 'overview') ? 'overview' : NSW_LENSES.includes(tab) ? 'nsw' : tab;
    document.getElementById(`tab-${contentId}`).classList.add('active');

    if (NSW_MAP_TABS.includes(tab)) {
        nswView = (tab === 'overview') ? 'all' : tab;
        if (tab === 'overview') refreshOverview(); else if (tab === 'fresh') refreshFresh(); else if (tab === 'corridor') beginCorridorAssessment(); else refreshNswView();
        showNSW();
    } else if (tab === 'cv' || tab === 'sydney') {
        // Area focus keeps the category lens (nswInView filters by nswView there). Align nswView with
        // the dropdown — it can lag when the previous tab didn't drive it (e.g. the Local tab).
        const lens = document.getElementById('lens-select');
        if (lens && lens.value && lens.value !== '__hold__') nswView = (lens.value === 'overview') ? 'all' : lens.value;
        if (tab === 'cv') { refreshCV(); showCV(); } else { refreshSydney(); showSydney(); }
    }
    else if (tab === 'flagged') { refreshFlagged(); showFlagged(); }   // ⚑ pinned roads (flagged.js)
    else if (tab === 'local') { refreshLocal(); showLocal(); }
    renderMapLegend();   // rebuild the floating legend for this view (also re-syncs the toggle dimming)
    // The network-growth reveal plays ONCE per page load, at boot (hideLoader → revealFromSydney,
    // landing on the Overview). Tab switches — including back to Overview — are always instant.
}

// Road Detail is shown on a road click (it's not a tab) — return to the view that was open.
function backFromDetail() {
    switchTab(lastViewTab || 'overview');
    // Leaving Road Detail: the criteria reference modal drops its road-specific annotations
    if (typeof refreshCriteriaModal === 'function') refreshCriteriaModal();
}

// The five map lenses that live in the sidebar's ONE dropdown control (#lens-select, index.html);
// the other views (Sydney / Clarence Valley / Flagged / Detail) stay individual buttons.
const LENS_SELECT_TABS = ['overview', 'nsr', 'state', 'regional', 'local', 'fresh', 'corridor'];

// Keep the lens dropdown in step with EVERY tab change, however it was driven (its own change
// event, a tab button, boot, a road-detail open, a search jump…). Called by switchTab right after
// the .tab-btn active sweep: on one of the lens tabs the dropdown takes that value + the active
// pill look (mirroring how the old buttons lit up). Inside an area focus (Sydney / Clarence Valley)
// the lens stays FUNCTIONAL and filters roads within that area, so it keeps the active
// look and its current value. On flagged / detail it KEEPS showing the last lens but drops the
// active styling — exactly like an unselected tab button.
function syncLensSelect(tab) {
    const sel = document.getElementById('lens-select');
    if (!sel) return;
    // Any pending re-pick hold (see the IIFE below) is finished the moment a real switch lands.
    const hold = sel.querySelector('option[value="__hold__"]');
    if (hold) { hold.remove(); delete sel.dataset.holding; }
    if (LENS_SELECT_TABS.includes(tab)) {
        sel.value = tab;
        sel.classList.add('active');
    } else if (tab === 'cv' || tab === 'sydney') {
        sel.classList.add('active');      // Area focus: lens still drives the road filter — stays lit
    } else {
        sel.classList.remove('active');   // sweep already stripped it; keep this explicit + idempotent
    }
}

// Same-lens re-pick: while the dropdown is INACTIVE (a non-lens view is open) it still shows its
// last lens — but a native <select> fires NO change event when the user picks the value it already
// shows, so "return to Overview from the Sydney tab via the dropdown" would go dead. Fix: on a
// mouse open in the inactive state, park the selection on a hidden placeholder option carrying the
// SAME label (the collapsed box looks identical), so ANY pick — the shown lens included — is a real
// value change and fires the markup's onchange → switchTab. A dismiss without a pick restores the
// parked lens on blur/Escape; a landed switch is cleaned up by syncLensSelect above.
(function () {
    const sel = document.getElementById('lens-select');
    if (!sel) return;
    sel.addEventListener('mousedown', function () {
        if (sel.classList.contains('active') || sel.dataset.holding) return;
        const cur = sel.selectedOptions[0];
        if (!cur) return;
        const dummy = document.createElement('option');
        dummy.value = '__hold__';
        dummy.hidden = true;                    // never offered in the open list
        dummy.textContent = cur.textContent;    // collapsed box keeps reading the parked lens
        sel.dataset.holding = cur.value;
        sel.appendChild(dummy);
        sel.value = '__hold__';
    });
    const restore = function () {
        const hold = sel.querySelector('option[value="__hold__"]');
        if (!hold) return;
        if (sel.value === '__hold__' && sel.dataset.holding) sel.value = sel.dataset.holding;
        hold.remove();
        delete sel.dataset.holding;
    };
    sel.addEventListener('blur', restore);
    sel.addEventListener('keydown', function (e) { if (e.key === 'Escape') restore(); });
})();

// Tab colour group (matches the tab-btn tinting + the floating legend accent):
// g1 = Overview · g2 = Nat.Significant / State / Regional / Local / Flagged (red — matches the ⚑
// red-flag motif) · g3 = Sydney / Clarence Valley.
function tabGroup(tab) {
    if (tab === 'nsr' || tab === 'state' || tab === 'regional' || tab === 'local' || tab === 'flagged' || tab === 'fresh') return 'g2';
    if (tab === 'sydney' || tab === 'cv') return 'g3';
    return 'g1';   // overview + detail
}

// Apply the legend on/off toggles + per-lens NLTN style to the map for the CURRENT view.
function applyLegend(opts) {
    if (typeof traceCode === 'function') traceCode(
        'Apply map layers',
        'After a tab or legend change, applyLegend() decides which layers should be on the map and whether the roads need to be recoloured.',
        "function applyLegend(opts) {\n  const cvClip = currentTab === 'cv' && legendToggles.clip;\n  const nsrLens = currentTab !== 'cv' && currentTab !== 'sydney' && nswView === 'nsr';\n  const hideNsw = cvClip || currentTab === 'local' || nsrLens;\n\n  hideNsw ? map.removeLayer(nswLayer) : map.addLayer(nswLayer);\n  if (nltnLayer && (currentTab === 'nsr' || currentTab === 'overview' || currentTab === 'sydney')) {\n    map.addLayer(nltnLayer);\n  }\n}",
        'currentTab=' + currentTab + ', nswView=' + nswView + ', clip=' + legendToggles.clip
    );
    // opts.skipRoadRestyle (set by toggleLegendItem for keys that cannot change nswStyle's output —
    // towns / boundaries / bypass / NLTN / highlight rings): skip re-styling the ~17.6k road paths, the
    // most expensive thing this function does. The canvas styles stay correct because those keys are not
    // inputs to nswStyle. A layer being (re-)ADDED always restyles, whatever the caller asked.
    const restyleRoads = !(opts && opts.skipRoadRestyle);
    // CV tab + "Show only roads inside the area" swaps the full road overlay for the clipped copy.
    // Local tab → hide the State/Regional overlay entirely, so only the green local roads show.
    // Nat. Significant lens → nswInView hides EVERY road there (its subject is the NLTN layer), so take
    // the layer OFF the map instead of drawing 17.6k invisible paths: zoom/pan then skip re-projecting
    // them entirely. The lens applies INSIDE an area focus too (CV / Sydney keep the category dropdown
    // functional — see nswInView); the detail view keeps whatever lens it came from (nswView unchanged).
    const cvClip = currentTab === 'cv' && legendToggles.clip;
    const areaTab = currentTab === 'cv' || currentTab === 'sydney';
    // Flagged view: the ⚑ pins are drawn by this SAME overlay (nswStyle hides the unpinned roads),
    // so an 'nsr' nswView must not take the layer off the map there (inFlaggedScope, flagged.js).
    const nsrLens = !inFlaggedScope() && nswView === 'nsr';
    // Local lens in an LGA mirrors the Local tab's map treatment: the S/R overlay comes off (street
    // labels appear once zoomed in; the full council-road assessment lives on the Local tab).
    const hideNsw = cvClip || currentTab === 'local' || nsrLens || (areaTab && nswView === 'local');
    if (nswLayer) {
        if (hideNsw) map.removeLayer(nswLayer);
        else { const wasOn = map.hasLayer(nswLayer); map.addLayer(nswLayer); if (restyleRoads || !wasOn) nswLayer.setStyle(nswStyle); }
    }
    if (cvClipLayer) {
        if (cvClip) { const wasOn = map.hasLayer(cvClipLayer); map.addLayer(cvClipLayer); if (restyleRoads || !wasOn) cvClipLayer.setStyle(nswStyle); }
        else map.removeLayer(cvClipLayer);
    }
    if (cvLayer) cvLayer.setStyle(cvStyle);
    // NLTN national network: the SUBJECT of the Nat. Significant lens only — graded green/orange.
    // Hidden on every other tab, incl. CV (it is no longer a reference underlay).
    if (nltnLayer) {
        // Shown on the Nat. Significant lens, the Overview, AND inside an area focus when the lens is
        // Overview (Sydney only — its Overview always drew it) or Nat. Sig (both LGAs — the lens's
        // subject): the green/orange national network drawn alongside / instead of the road overlay.
        const onNltnTab = (currentTab === 'nsr' || currentTab === 'overview'
            || (currentTab === 'sydney' && (nswView === 'all' || nswView === 'nsr'))
            || (currentTab === 'cv' && nswView === 'nsr')) && legendToggles.nltn;
        // Flagged view: show the national network too, but only when a national route is pinned — its
        // style (nltnFeatureStyle) then hides every unpinned route, so ONLY the pins draw.
        const onFlagged = typeof inFlaggedScope === 'function' && inFlaggedScope() && typeof anyNltnFlagged === 'function' && anyNltnFlagged();
        if (onNltnTab || onFlagged) {
            map.addLayer(nltnLayer);
            nltnLayer.setStyle(nltnFeatureStyle);   // per-feature grade + proposed translucency (+ flagged filter)
        } else map.removeLayer(nltnLayer);
    }
    // Connectivity highlights honour their per-category toggles — re-render the current selection.
    refreshConnections();
    // Town/City pins
    if (nswTownsLayer) map.removeLayer(nswTownsLayer);
    if (nswLocalityCentresLayer) map.removeLayer(nswLocalityCentresLayer);
    if (cvTownsLayer) map.removeLayer(cvTownsLayer);
    const towns = (currentTab === 'cv') ? cvTownsLayer : nswTownsLayer;   // Sydney reuses the statewide town pins
    if (towns && legendToggles.towns && currentTab !== 'corridor') map.addLayer(towns);
    // Suburb/locality-centre pins (dots + labels appearing with zoom): OFF by default, shown via
    // the bottom-right "Localities" toggle. Their SAL candidates feed the criteria regardless.
    if (currentTab !== 'cv' && currentTab !== 'corridor' && nswLocalityCentresLayer && legendToggles.localities) map.addLayer(nswLocalityCentresLayer);
    // Region boundary outlines — CV LGA on the CV tab, Sydney SUA on the Sydney tab (one at a time).
    if (cvBoundaryLayer) { if (currentTab === 'cv' && legendToggles.boundary) map.addLayer(cvBoundaryLayer); else map.removeLayer(cvBoundaryLayer); }
    if (sydBoundaryLayer) { if (currentTab === 'sydney' && legendToggles.boundary) map.addLayer(sydBoundaryLayer); else map.removeLayer(sydBoundaryLayer); }
    // HV bypass network highlight (statewide; off by default) — halo under the roads.
    if (bypassLayer) { if (legendToggles.bypass && currentTab !== 'corridor') map.addLayer(bypassLayer); else map.removeLayer(bypassLayer); }
    // Local roads (council) — lazy-loaded live, zoom-gated (see local.js). Refresh for the current view.
    if (typeof updateLocalRoads === 'function') updateLocalRoads();
    if (typeof updateLocalX === 'function') updateLocalX();   // Cross-test tab: green local-road vectors
    if (typeof updateStatewideLocalRoads === 'function') updateStatewideLocalRoads();
}

// Shared "Highlights" legend block: the on-select connection rings (blue centres, red hospitals,
// purple ports/airports/intermodals, teal employment). Same data-legend-key wiring as the verdict
// rows, so toggleLegendItem handles them generically.
function hiliteLegendHTML() {
    const dot = c => '<span class="legend-swatch"><span class="legend-pin" style="background:' + c + '"></span></span>';
    const row = (key, swatch, label) => '<div class="legend-item" data-legend-key="' + key + '" onclick="toggleLegendItem(\'' + key + '\')">' + swatch + ' ' + label + '</div>';
    let h = '<h3 class="legend-sub">Highlights</h3>';
    h += row('c_centre', dot('#1d4ed8'), 'Connected centres / urban areas');
    h += row('c_hosp', dot('#dc2626'), 'Connected hospitals');
    h += row('c_dest', dot('#7c3aed'), 'Connected ports / airports / intermodals');
    h += row('c_employ', dot('#0f766e'), 'Connected employment centres');
    return h;
}

// The single floating legend (top-right of the map). Rebuilt for the current view: verdict colours +
// route/town rows + the tab-specific rows (CV boundary/clip, Nat. Significant proposed note) + the
// shared Highlights block. All rows are data-legend-key toggles handled by toggleLegendItem.
function renderMapLegend() {
    const el = document.getElementById('map-legend');
    if (!el) return;
    const li = (key, swatch, label) => '<div class="legend-item" data-legend-key="' + key + '" onclick="toggleLegendItem(\'' + key + '\')">' + swatch + ' ' + label + '</div>';
    const liStatic = (swatch, label) => '<div class="legend-item legend-static">' + swatch + ' ' + label + '</div>';
    const sw = c => '<div class="legend-color" style="background:' + c + '"></div>';
    const dashSw = '<div class="legend-color legend-dash"></div>';
    const townSw = '<div class="legend-color" style="background:transparent; width:24px; height:auto; display:flex; align-items:center; justify-content:center;"><span style="width:10px; height:10px; border-radius:50%; background:#57534e; display:block;"></span></div>';
    const vkeys = ['green', 'orange', 'red'];
    let h = '<div class="ml-header"><h3>Map legend</h3><div class="ml-actions">' +
        '<button class="ml-btn" onclick="resetLegendToggles()" title="Reset all layers"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"></path><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg></button>' +
        '<button class="ml-btn" onclick="toggleLegendCollapse()" title="Minimise legend"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg></button>' +
        '</div></div>';
    if (currentTab === 'corridor') {
        h += liStatic('<div class="legend-color" style="background:#a52b32; height:4px"></div>', 'Selected corridor');
        h += liStatic('<div style="width:24px;display:flex;justify-content:center"><span style="width:10px;height:10px;border-radius:50%;background:#2563eb;border:2px solid #fff"></span></div>', 'Selected endpoint');
    } else if (currentTab === 'cv' || currentTab === 'sydney') {
        // Area focus: the verdict/category rows follow the active lens. The two sidebar dropdowns
        // are orthogonal: Category picks the rows and Area supplies its outline/clip extras.
        if (nswView === 'fresh') {
            FRESH_CATS.forEach(k => { h += li(k, sw(FRESH_META[k].color), FRESH_META[k].label); });
            h += liStatic(dashSw, 'Dashed — provisional: gate passed, 1 of 2 optional');
        } else if (nswView === 'nsr') {
            NSW_VIEW_META.nsr.legend.forEach(([col, lab], i) => { h += li(vkeys[i], sw(col), lab); });
            h += liStatic('<div class="legend-color" style="background:#16a34a; opacity:0.45"></div>', 'Proposed corridor — not yet built (translucent)');
        } else if (nswView === 'local') {
            h += liStatic('<div class="legend-color" style="background:#9a938c; height:2px"></div>', 'Local streets — names label once zoomed in; the full council-road assessment is on the Local tab');
        } else {
            // State / Regional lens rows from NSW_VIEW_META; Overview ('all') keeps the generic rows.
            const m = NSW_VIEW_META[nswView];
            const rows = m ? m.legend : [
                ['#16a34a', 'Passes criteria'],
                ['#f59e0b', 'Passes 1 of 2 criteria'],
                ['#dc2626', 'Fails criteria']
            ];
            rows.forEach(([col, lab], i) => { h += li(vkeys[i], sw(col), lab); });
            h += li('dashed', dashSw, 'Route-numbered road A / B / D / M (dashed)');
        }
        h += li('towns', townSw, currentTab === 'cv' ? 'Town centres / POIs' : 'Centres / localities · zoom in');
        h += li('boundary', '<div class="legend-color" style="background:#000000; height:2.5px"></div>', currentTab === 'cv' ? 'Area boundary (outline)' : 'Sydney outline');
        if (currentTab === 'cv')
            h += li('clip', '<div class="legend-color" style="background:transparent; border:1.5px solid #1c1917; height:11px; border-radius:2px"></div>', 'Show only roads inside the area');
    } else if (currentTab === 'local') {
        // Verdict rows follow the ACTIVE local cross-test mode (own = plain green, no verdicts).
        const lm = (typeof xLens !== 'undefined') ? xLens.local : false;
        h += liStatic('<div class="legend-color" style="background:#16a34a; height:2px"></div>', 'Local road (council)' + (lm ? '' : ' — green'));
        if (lm === 'state') {
            h += li('green', sw('#16a34a'), 'Tested: meets State (centres + facility)');
            h += li('orange', sw('#f59e0b'), 'Tested: likely passes State criteria');
            h += li('red', sw('#dc2626'), 'Tested: meets no State criterion');
        } else if (lm) {
            h += li('green', sw('#16a34a'), 'Tested: meets Regional (≥ 2 centres)');
            h += li('orange', sw('#f59e0b'), 'Tested: 1 centre nearby');
            h += li('red', sw('#dc2626'), 'Tested: no ≥ 2-centre link');
        }
        h += li('towns', townSw, 'Centres / localities · zoom in');
    } else if (currentTab === 'fresh' || (currentTab === 'detail' && nswView === 'fresh' && !inFlaggedScope())) {
        // Best fit lens: the map encodes CATEGORY (blank-slate re-bin), not verdict — four
        // toggleable bins in the fresh palette + a static row explaining the dashed "likely" tier.
        // A Road Detail opened from this lens keeps the fresh map colours (nswStyle), so its
        // legend must keep these rows too — not the generic verdict rows below.
        FRESH_CATS.forEach(k => { h += li(k, sw(FRESH_META[k].color), FRESH_META[k].label); });
        h += liStatic('<div class="legend-color" style="background:#57534e; height:2px"></div>', 'Statewide LocalRoad geometry · visible at 2 km scale');
        h += liStatic(dashSw, 'Dashed — provisional: gate passed, 1 of 2 optional');
        h += li('towns', townSw, 'Centres / localities · zoom in');
    } else if (NSW_LENSES.includes(currentTab) && NSW_VIEW_META[nswView]) {
        const m = NSW_VIEW_META[nswView];
        // Cross-criteria test active → the verdict rows describe the TARGET category's tiers.
        const xm = (nswView === 'state' && xLens.state) || (nswView === 'regional' && xLens.regional) || false;
        const legendRows = (xm && XT_MODE_LEGEND[xm]) ? XT_MODE_LEGEND[xm] : m.legend;
        legendRows.forEach(([col, lab], i) => { h += li(vkeys[i], sw(col), lab); });
        if (nswView === 'nsr') h += liStatic('<div class="legend-color" style="background:#16a34a; opacity:0.45"></div>', 'Proposed corridor — not yet built (translucent)');
        else h += li('dashed', dashSw, 'Route-numbered road A / B / D / M (dashed)');
        h += li('towns', townSw, 'Centres / localities · zoom in');
    } else {   // overview + detail
        h += li('green', sw('#16a34a'), 'Passes criteria');
        h += li('orange', sw('#f59e0b'), 'Passes 1 of 2 criteria');
        h += li('red', sw('#dc2626'), 'Fails criteria');
        h += li('dashed', dashSw, 'Route-numbered road A / B / D / M (dashed)');
        h += li('towns', townSw, 'Town/City');
    }
    // Local roads & street names (basemap label overlay) — a toggle on the road-map tabs; the labels
    // switch on once zoomed in (LOCAL_ZOOM), naming the local roads already drawn on the base map.
    if (['overview', 'state', 'regional', 'sydney', 'cv', 'local', 'fresh'].indexOf(currentTab) !== -1)
        h += li('local', '<div class="legend-color" style="background:#9a938c; height:2px"></div>', 'Local roads & street names · zoom in');
    if (currentTab !== 'corridor') h += hiliteLegendHTML();
    el.innerHTML = h;
    el.classList.remove('legend-g1', 'legend-g2', 'legend-g3');
    el.classList.add('legend-' + tabGroup(currentTab));   // accent the legend to match the active tab group
    syncLegendVisuals();
}

// HV bypass isolate (bottom-left checkbox): ON hides every other legend layer + highlight and shows
// ONLY the NHVR heavy-vehicle bypass overlay; OFF restores the exact previous toggle state.
let _bypassSaved = null;
// Bottom-right "Localities" checkbox — shows/hides the suburb/locality centre pins (zoom-gated
// dots + labels). Purely a display toggle: the SAL candidates feed the criteria either way.
function toggleLocalities(on) {
    legendToggles.localities = !!on;
    applyLegend();
}

function toggleBypassIsolate(on) {
    if (typeof traceCode === 'function') traceCode(
        'HV bypass isolate: ' + (on ? 'on' : 'off'),
        'This checkbox temporarily changes the legend toggles so only the heavy-vehicle bypass overlay is visible, then redraws the map layers.',
        "function toggleBypassIsolate(on) {\n  if (on) {\n    _bypassSaved = Object.assign({}, legendToggles);\n    Object.keys(legendToggles).forEach(k => legendToggles[k] = false);\n    legendToggles.bypass = true;\n  } else {\n    legendToggles = _bypassSaved;\n  }\n  renderMapLegend();\n  applyLegend();\n}",
        'bypass overlay is drawn from nhvr_networks.json flags'
    );
    if (on) {
        _bypassSaved = Object.assign({}, legendToggles);
        Object.keys(legendToggles).forEach(function (k) { if (k !== 'clip') legendToggles[k] = false; });
        legendToggles.bypass = true;
    } else {
        if (_bypassSaved) { Object.keys(_bypassSaved).forEach(function (k) { legendToggles[k] = _bypassSaved[k]; }); _bypassSaved = null; }
        legendToggles.bypass = false;
    }
    syncLegendVisuals();
    renderMapLegend();
    applyLegend();
    // Revamp: brief top-centre pill while the network restyles (informative only).
    if (typeof showMapRefresh === 'function') showMapRefresh(on ? 'Isolating HV bypass network…' : 'Restoring full network…', 1100);
}

// Legend keys that are INPUTS to the road style (nswStyle/cvStyle): the verdict colours, the dashed
// route-number treatment, and the clip layer swap. Toggling any other key (towns, boundary, bypass,
// nltn, the c_* highlight rings) cannot change a road's style, so the road repaint is skipped.
const ROADSTYLE_KEYS = { green: 1, orange: 1, red: 1, dashed: 1, clip: 1, fnat: 1, fstate: 1, freg: 1, flocal: 1 };

// Reset all legend toggles to ON (re-enable all hidden layers)
function resetLegendToggles() {
    Object.keys(legendToggles).forEach(function (k) {
        if (k !== 'clip') legendToggles[k] = true;   // keep clip as-is (it's a special mode)
    });
    syncLegendVisuals();
    applyLegend();
}

// Minimise/expand the legend body (keep just the header visible)
function toggleLegendCollapse() {
    var el = document.getElementById('map-legend');
    if (el) el.classList.toggle('ml-collapsed');
}

// Clicking a legend swatch toggles that category on/off across the map.
function toggleLegendItem(key) {
    if (typeof traceCode === 'function') traceCode(
        'Legend toggle: ' + key,
        'Legend rows flip a visibility flag. applyLegend() then redraws the relevant layer or restyles road colours.',
        "function toggleLegendItem(key) {\n  legendToggles[key] = !legendToggles[key];\n  applyLegend({ skipRoadRestyle: ROADSTYLE_KEYS[key] !== 1 });\n}",
        key + ' will become ' + (legendToggles[key] ? 'off' : 'on')
    );
    legendToggles[key] = !legendToggles[key];
    if (key === 'clip') deselect();   // swapping the road layer — clear any stale selection/highlight
    // Only the clicked key's row changed state — update just its row(s) rather than re-sweeping every
    // legend row (syncLegendVisuals, still used on full rebuilds + the multi-toggle bypass isolate).
    document.querySelectorAll('.legend-item[data-legend-key="' + key + '"]').forEach(function (el) {
        el.classList.toggle('legend-off', !legendToggles[key]);
    });
    applyLegend({ skipRoadRestyle: ROADSTYLE_KEYS[key] !== 1 });
}

// Dim the disabled rows on every legend so all tabs stay in sync with the toggle state.
function syncLegendVisuals() {
    document.querySelectorAll('.legend-item[data-legend-key]').forEach(function (el) {
        el.classList.toggle('legend-off', !legendToggles[el.getAttribute('data-legend-key')]);
    });
}

function showNSW() {
    if (typeof traceCode === 'function') traceCode(
        'Show NSW view',
        'The Overview, State and Regional tabs all use the same NSW road layer. nswView decides whether it shows all roads, State roads, Regional roads or hides them for Nat. Sig.',
        "function showNSW() {\n  applyLegend();\n  if (mapContext !== 'nsw' && nswLayer) {\n    map.fitBounds(nswLayer.getBounds().pad(0.05));\n  }\n  mapContext = 'nsw';\n}",
        'nswView=' + nswView
    );
    if (cvLayer) map.removeLayer(cvLayer);
    // The road overlay is owned by applyLegend(): it adds + styles it for the Overview/State/Regional
    // lenses and removes it for Nat. Significant (all roads hidden there — see hideNsw). Adding it here
    // first would project all ~17.6k paths only for applyLegend to tear them straight down on nsr.
    applyLegend();
    // Frame NSW only when arriving from a different context (or first load) — switching among the
    // NSW lens tabs preserves the user's current pan/zoom.
    if (mapContext !== 'nsw') map.setView([-32.0, 149.5], 6);
    mapContext = 'nsw';
}

function showCV() {
    if (typeof traceCode === 'function') traceCode(
        'Show Clarence Valley',
        'The Clarence Valley area reuses the statewide assessment, draws the area outline, filters the stats to roads touching it, and frames the map to the boundary.',
        "function showCV() {\n  applyLegend();\n  if (mapContext !== 'cv' && cvBoundaryLayer) {\n    map.fitBounds(cvBoundaryLayer.getBounds().pad(0.12));\n  }\n  mapContext = 'cv';\n}",
        'stats source: scopeCounts(\"cv\"), boundary: clarence_valley_boundary.geojson'
    );
    // The CV tab IS the Overview, zoomed into the Clarence Valley LGA with its outline drawn. The
    // council assessment layer (cvLayer) is retired; applyLegend adds the road overlay (full nswLayer,
    // or the clipped cvClipLayer when "inside only" is on).
    if (cvLayer) map.removeLayer(cvLayer);
    applyLegend();
    // Frame the LGA from the boundary outline (with padding) when arriving from a different context.
    if (mapContext !== 'cv' && cvBoundaryLayer) map.fitBounds(cvBoundaryLayer.getBounds().pad(0.12));
    mapContext = 'cv';
}

function showSydney() {
    if (typeof traceCode === 'function') traceCode(
        'Show Sydney',
        'The Sydney tab uses the same statewide assessment as Overview, but it tags roads inside the Sydney Significant Urban Area and frames the map to that outline.',
        "function showSydney() {\n  applyLegend();\n  if (mapContext !== 'sydney' && sydBoundaryLayer) {\n    map.fitBounds(sydBoundaryLayer.getBounds().pad(0.08));\n  }\n  mapContext = 'sydney';\n}",
        'stats source: scopeCounts(\"syd\"), boundary: SUA_OUTLINES[30]'
    );
    // The Sydney tab IS the Overview, zoomed into the Sydney Significant Urban Area with its outline drawn.
    // Uses the full road overlay (nswLayer) — same as the Overview, just framed on Sydney.
    if (cvLayer) map.removeLayer(cvLayer);
    applyLegend();
    // Frame Sydney from the boundary outline (with padding) when arriving from a different context.
    if (mapContext !== 'sydney' && sydBoundaryLayer) map.fitBounds(sydBoundaryLayer.getBounds().pad(0.08));
    mapContext = 'sydney';
}

// --- Region-filtered national-network (NLTN) counts, self-healing --------------------------------------
// The Sydney / CV "Nationally Significant" by-group row needs the count of national-network routes inside
// each region. init.js precomputes these (NLTN_CAT_COUNTS_SYD / _CV) — the fast path — but if a live-reload
// re-ran the display code WITHOUT re-running init.js, those globals are unset. So we recompute here on
// demand from the NLTN layer + the region outline: no dependency on init.js having run. Cached per region.
const _natRegionCache = {};
function _pointInRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
    }
    return inside;
}
function _pointInPolys(x, y, polys) {                 // polys: [ [outerRing, hole1, ...], ... ]
    for (const poly of polys) {
        if (!_pointInRing(x, y, poly[0])) continue;   // outside outer ring
        let inHole = false;
        for (let h = 1; h < poly.length; h++) { if (_pointInRing(x, y, poly[h])) { inHole = true; break; } }
        if (!inHole) return true;
    }
    return false;
}
function _polysFromGeoJSON(gj) {
    const polys = [], feats = (gj && gj.type === 'FeatureCollection') ? gj.features : [gj];
    feats.forEach(function (f) {
        const g = f && (f.geometry || f); if (!g || !g.type) return;
        if (g.type === 'Polygon') polys.push(g.coordinates);
        else if (g.type === 'MultiPolygon') g.coordinates.forEach(function (p) { polys.push(p); });
    });
    return polys;
}
function nltnRegionCounts(which) {
    const pre = which === 'syd' ? window.NLTN_CAT_COUNTS_SYD : window.NLTN_CAT_COUNTS_CV;
    if (pre) return pre;                              // fast path — init.js already computed it this load
    if (_natRegionCache[which]) return _natRegionCache[which];
    const bl = which === 'syd' ? (typeof sydBoundaryLayer !== 'undefined' && sydBoundaryLayer)
                               : (typeof cvBoundaryLayer !== 'undefined' && cvBoundaryLayer);
    if (!bl || typeof nltnLayer === 'undefined' || !nltnLayer) return null;
    const polys = _polysFromGeoJSON(bl.toGeoJSON());
    if (!polys.length) return null;
    let bx0 = 180, by0 = 90, bx1 = -180, by1 = -90;   // region bbox for a quick reject
    polys.forEach(function (p) { p[0].forEach(function (pt) { if (pt[0] < bx0) bx0 = pt[0]; if (pt[0] > bx1) bx1 = pt[0]; if (pt[1] < by0) by0 = pt[1]; if (pt[1] > by1) by1 = pt[1]; }); });
    const coordsOf = function (g) { return g.type === 'LineString' ? g.coordinates : g.type === 'MultiLineString' ? [].concat.apply([], g.coordinates) : []; };
    const inReg = {}, cat = {};                       // a route (group) counts if ANY segment falls inside
    nltnLayer.eachLayer(function (l) {
        const f = l.feature; if (!f) return; const p = f.properties || {}; const grp = p._natGroup;
        cat[grp] = p._natCat;
        if (inReg[grp]) return;
        for (const pt of coordsOf(f.geometry)) {
            const x = pt[0], y = pt[1];
            if (x < bx0 || x > bx1 || y < by0 || y > by1) continue;
            if (_pointInPolys(x, y, polys)) { inReg[grp] = 1; break; }
        }
    });
    const c = { green: 0, orange: 0, red: 0, total: 0 };
    Object.keys(inReg).forEach(function (g) { const v = cat[g]; if (c[v] !== undefined) c[v]++; c.total++; });
    _natRegionCache[which] = c;
    return c;
}

// The Nat. Significant overlay as a "by road group" row — the NLTN national network (green = nationally
// significant; orange = on-network only), matching the Nat. Significant tab + its distribution bar. `counts`
// is the scope's NLTN counts: statewide (NLTN_CAT_COUNTS) on Overview, region-filtered on Sydney / CV.
// Returns null when the scope has no national-network road, so the row is simply omitted.
function natSigGroupRow(counts) {
    const nc = counts || {};
    if (!nc.total) return null;
    return ['Nationally Significant', { green: nc.green || 0, orange: nc.orange || 0, red: 0, total: nc.total }];
}

// Shared bar maths for the by-group breakdowns (Overview / Sydney / CV) and the NSW lens distribution
// bar — extracted verbatim from the previously-inlined copies, so the numbers are identical. hideRed
// (Nat. Significant only) folds the leftover into orange and forces red to 0; the group breakdowns
// always pass hideRed=false, so red fills the remainder after green + orange.
function barPercents(green, orange, total, hideRed) {
    const gp = total ? Math.round(green / total * 100) : 0;
    const op = hideRed ? (total ? Math.max(0, 100 - gp) : 0)
        : (total ? Math.round(orange / total * 100) : 0);
    const rp = hideRed ? 0 : (total ? Math.max(0, 100 - gp - op) : 0);
    return { gp: gp, op: op, rp: rp };
}

// Render the "by road group" breakdown rows shared by Overview / Sydney / CV. `rows` is an array of
// [name, {green, orange, red, total}]; red fills the remainder after green + orange.
function groupBreakdownHTML(rows) {
    let bh = '';
    for (const [name, d] of rows) {
        const p = barPercents(d.green, d.orange, d.total, false);
        bh += '<div class="category-row"><span class="cat-name">' + name + ' <span style="color:var(--faint)">(' + d.total + ')</span></span>' +
            '<div class="cat-bar"><div class="bar-bg"><div class="bar-fill green" style="width:' + p.gp + '%"></div>' +
            '<div class="bar-fill orange" style="width:' + p.op + '%"></div>' +
            '<div class="bar-fill red" style="width:' + p.rp + '%"></div></div><span class="cat-pct">' + p.gp + '%</span></div></div>';
    }
    return bh;
}

// The per-road verdict is fixed once data loads (NSW_AGG / NSW_CRIT are never mutated afterwards), so
// the whole-network / per-region count scans below are computed once per scope and cached. Tab switches
// then read O(1) instead of re-scanning every road each time. scope: 'all' (Overview) | 'cv' | 'syd'.
const _scopeCounts = {};
window._scopeCountsRef = _scopeCounts;
function scopeCounts(scope) {
    if (_scopeCounts[scope]) return _scopeCounts[scope];
    let g = 0, o = 0, r = 0, greenKm = 0, orangeKm = 0, redKm = 0;
    const grp = {
        'State Roads': { green: 0, orange: 0, red: 0, total: 0 },
        'Regional Roads': { green: 0, orange: 0, red: 0, total: 0 }
    };
    for (const k in NSW_AGG) {
        const a = NSW_AGG[k];
        if (a.admin_class !== 'S' && a.admin_class !== 'R') continue;
        if (scope === 'cv' && !a._inCV) continue;
        if (scope === 'syd' && !a._inSyd) continue;
        const v = window.NSW_CRIT[k].verdict;
        const group = a.admin_class === 'S' ? 'State Roads' : 'Regional Roads';
        const len = a._len || 0;
        if (v === 'green') { g++; greenKm += len; }
        else if (v === 'orange') { o++; orangeKm += len; }
        else { r++; redKm += len; }
        grp[group][v]++; grp[group].total++;
    }
    return (_scopeCounts[scope] = { g: g, o: o, r: r, greenKm: greenKm, orangeKm: orangeKm, redKm: redKm, grp: grp });
}

// CV / Sydney tab stats — the Overview breakdown filtered to one region (roads touching the Clarence
// Valley LGA via _inCV, or inside the Sydney SUA via _inSyd). Same shape; only the key differs ('cv' /
// 'syd'), which drives the scope, the region NLTN counts, and the DOM id prefix — so one function serves
// both. refreshCV / refreshSydney remain as named entry points (switchTab + init.js call them).
function refreshRegion(key) {
    if (typeof traceCode === 'function') traceCode(
        'Refresh region stats: ' + key,
        'Region tabs do not create a new assessment. They reuse the statewide road verdicts and count only roads tagged inside the selected boundary.',
        "function refreshRegion(key) {\n  const { g, o, r, grp } = scopeCounts(key);\n  set(key + '-green', g.toLocaleString());\n  set(key + '-orange', o.toLocaleString());\n  set(key + '-red', r.toLocaleString());\n}",
        key === 'cv' ? 'Clarence Valley roads tagged with _inCV' : 'Sydney roads tagged with _inSyd'
    );
    // Best fit uses four destination-category bins instead of the ordinary verdict cards. Its Area
    // totals combine boundary-tagged declared roads with pre-aggregated LocalRoad candidates.
    if (nswView === 'fresh') { refreshRegionFresh(key); return; }
    const verdictGrid = document.getElementById(key + '-verdict-grid');
    const freshGrid = document.getElementById(key + '-fresh-grid');
    if (verdictGrid) verdictGrid.style.display = '';
    if (freshGrid) freshGrid.style.display = 'none';
    const breakdownTitle = document.getElementById(key + '-breakdown-title');
    if (breakdownTitle) breakdownTitle.textContent = 'By road group';
    const totalSub = document.getElementById(key + '-total-sub');
    if (totalSub) totalSub.textContent = key === 'cv'
        ? 'State & Regional roads in the region, graded against their criteria'
        : 'State & Regional roads in the Sydney urban area, graded against their criteria';
    const note = document.querySelector('#tab-' + (key === 'syd' ? 'sydney' : 'cv') + ' .data-note p');
    if (note) note.textContent = key === 'cv'
        ? 'The Clarence Valley tab is the Overview map zoomed into the council, with the boundary drawn as an outline. Roads are graded against their own State / Regional criteria — the same as everywhere else. Click any road for its full assessment.'
        : 'The Sydney tab is the Overview map zoomed into the Sydney Significant Urban Area, with the boundary drawn as an outline. Roads are graded against their own State / Regional criteria — the same as everywhere else. Click any road for its full assessment.';
    // When a category lens is active (State/Regional), filter the region stats to only that class.
    const lensClass = (nswView === 'state') ? 'S' : (nswView === 'regional') ? 'R' : null;
    let g = 0, o = 0, r = 0, greenKm = 0, orangeKm = 0, redKm = 0;
    const grp = {
        'State Roads': { green: 0, orange: 0, red: 0, total: 0 },
        'Regional Roads': { green: 0, orange: 0, red: 0, total: 0 }
    };
    for (const k in NSW_AGG) {
        const a = NSW_AGG[k];
        if (a.admin_class !== 'S' && a.admin_class !== 'R') continue;
        if (key === 'cv' && !a._inCV) continue;
        if (key === 'syd' && !a._inSyd) continue;
        if (lensClass && a.admin_class !== lensClass) continue;
        const v = window.NSW_CRIT[k].verdict;
        const group = a.admin_class === 'S' ? 'State Roads' : 'Regional Roads';
        const len = a._len || 0;
        if (v === 'green') { g++; greenKm += len; }
        else if (v === 'orange') { o++; orangeKm += len; }
        else { r++; redKm += len; }
        grp[group][v]++; grp[group].total++;
    }
    const total = g + o + r;
    const pct = n => total ? (n / total * 100).toFixed(0) + '% of roads' : '';
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set(key + '-total', total.toLocaleString());
    set(key + '-green', g.toLocaleString()); set(key + '-green-pct', pct(g) + ' · ' + Math.round(greenKm).toLocaleString() + ' km');
    set(key + '-orange', o.toLocaleString()); set(key + '-orange-pct', pct(o) + ' · ' + Math.round(orangeKm).toLocaleString() + ' km');
    set(key + '-red', r.toLocaleString()); set(key + '-red-pct', pct(r) + ' · ' + Math.round(redKm).toLocaleString() + ' km');
    const grpRows = [natSigGroupRow(nltnRegionCounts(key)), ...Object.entries(grp)].filter(Boolean);
    const gb = document.getElementById(key + '-group-breakdown'); if (gb) gb.innerHTML = groupBreakdownHTML(grpRows);
}

function refreshRegionFresh(key) {
    const F = buildFresh();
    const counts = { fnat: 0, fstate: 0, freg: 0, flocal: 0 };
    const km = { fnat: 0, fstate: 0, freg: 0, flocal: 0 };
    let declared = 0, provisional = 0;
    for (const roadKey in NSW_AGG) {
        const a = NSW_AGG[roadKey];
        if (a.admin_class !== 'S' && a.admin_class !== 'R') continue;
        if (key === 'cv' && !a._inCV) continue;
        if (key === 'syd' && !a._inSyd) continue;
        const f = F[roadKey]; if (!f) continue;
        declared++;
        counts[f.cat]++;
        km[f.cat] += a._len || 0;
        if (f.tier === 'likely') provisional++;
    }

    const areaStats = window.LOCAL_ROAD_AREA_STATS && window.LOCAL_ROAD_AREA_STATS.areas
        ? window.LOCAL_ROAD_AREA_STATS.areas[key] : null;
    const statuses = areaStats ? (areaStats.status_counts || {}) : {};
    const statusKm = areaStats ? (areaStats.status_length_km || {}) : {};
    const localRoads = areaStats ? (+areaStats.road_count || 0) : 0;
    const localState = (+statuses.potential_state || 0) + (+statuses.likely_state || 0);
    const localRegional = (+statuses.potential_regional || 0) + (+statuses.likely_regional || 0);
    counts.fstate += localState;
    counts.freg += localRegional;
    counts.flocal += Math.max(0, localRoads - localState - localRegional);
    km.fstate += (+statusKm.potential_state || 0) + (+statusKm.likely_state || 0);
    km.freg += (+statusKm.potential_regional || 0) + (+statusKm.likely_regional || 0);
    km.flocal += Object.keys(statusKm).reduce((sum, status) =>
        ['potential_state', 'likely_state', 'potential_regional', 'likely_regional'].indexOf(status) === -1
            ? sum + (+statusKm[status] || 0) : sum, 0);
    provisional += (+statuses.likely_state || 0) + (+statuses.likely_regional || 0);

    const total = declared + localRoads;
    const totalKm = km.fnat + km.fstate + km.freg + km.flocal;
    const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    const sub = value => {
        if (!totalKm) return Math.round(value).toLocaleString() + ' km';
        const share = value / totalKm * 100;
        return share.toFixed(share < 0.1 ? 2 : 1) + '% of assessed road length · ' +
            Math.round(value).toLocaleString() + ' km';
    };
    const verdictGrid = document.getElementById(key + '-verdict-grid');
    const freshGrid = document.getElementById(key + '-fresh-grid');
    if (verdictGrid) verdictGrid.style.display = 'none';
    if (freshGrid) freshGrid.style.display = 'grid';
    set(key + '-total', total.toLocaleString());
    set(key + '-fresh-nat', counts.fnat.toLocaleString()); set(key + '-fresh-nat-sub', sub(km.fnat));
    set(key + '-fresh-state', counts.fstate.toLocaleString()); set(key + '-fresh-state-sub', sub(km.fstate));
    set(key + '-fresh-reg', counts.freg.toLocaleString()); set(key + '-fresh-reg-sub', sub(km.freg));
    set(key + '-fresh-local', counts.flocal.toLocaleString()); set(key + '-fresh-local-sub', sub(km.flocal));
    set(key + '-total-sub', 'Best-fit assessment units within the selected Area — current classification ignored');
    set(key + '-breakdown-title', 'Assessment coverage');
    const gb = document.getElementById(key + '-group-breakdown');
    if (gb) gb.innerHTML = '<div class="stat-sub" style="line-height:1.6">' +
        declared.toLocaleString() + ' sourced State/Regional roads · ' + localRoads.toLocaleString() +
        ' sourced LocalRoad candidates · ' + provisional.toLocaleString() + ' provisional outcomes</div>';
    const note = document.querySelector('#tab-' + (key === 'syd' ? 'sydney' : 'cv') + ' .data-note p');
    if (note) note.textContent = 'Best fit applies the same blank-slate category waterfall as the statewide view, then narrows the results to roads within this Area. State, Regional and sourced LocalRoad candidates are included; full road length is counted once when any part of a road falls inside the boundary.';
}
function refreshCV() { refreshRegion('cv'); }
function refreshSydney() { refreshRegion('syd'); }

// --- Local tab: council roads (green) drawn over the State + Regional network (context) ---
function showLocal() {
    if (typeof traceCode === 'function') traceCode(
        'Show Local roads',
        'The Local tab removes the State/Regional overlay and shows suburb-loaded council roads from OpenStreetMap/Overpass when available.',
        "function showLocal() {\n  applyLegend();\n  mapContext = 'local';\n}",
        'local roads are handled in local.js, not nsw_assessment.geojson'
    );
    if (cvLayer) map.removeLayer(cvLayer);
    applyLegend();   // removes the S/R overlay (Local shows only local roads) + kicks off updateLocalX
    // No refit — keep the current pan/zoom; local roads load once zoomed in past LOCALX_ZOOM.
    mapContext = 'local';
}

// Local tab panel: the count is filled by the Overpass fetch (setLocalTotal, local.js) and the
// loaded suburb PERSISTS across tab switches — restore its road count on re-entry (— when
// nothing is loaded yet).
function refreshLocal() {
    if (typeof setLocalTotal === 'function')
        setLocalTotal((typeof LOCAL_GROUPS !== 'undefined' && LOCAL_GROUPS.length) ? LOCAL_GROUPS.length : null);
    if (typeof updateLocalXtStatus === 'function') updateLocalXtStatus();
}

// Cross-criteria segmented control for the State / Regional lenses (folded in from the old
// Cross-test tab): re-grade the shown roads against ANOTHER category. mode: 'own' | false = own
// criteria, or one of XT_LENS_MODES[nswView] ('regional' / 'natsig' on the State lens, 'state' /
// 'natsig' on the Regional lens — see config.js). refreshNswView re-counts the cards and rebuilds it.
function setCrossTest(mode) {
    const m = (mode === 'own' || !mode) ? false : mode;
    if (typeof traceCode === 'function') traceCode(
        'Cross-classification test: ' + (m ? XT_MODES[m].short : 'off'),
        'This regrades the currently visible State or Regional roads against another category’s criteria. It is a scenario test, not a new official classification.',
        "function setCrossTest(mode) {\n  const m = (mode === 'own' || !mode) ? false : mode;\n  if (nswView === 'state') xLens.state = m;\n  else if (nswView === 'regional') xLens.regional = m;\n  refreshNswView();\n  nswLayer.setStyle(nswStyle);\n}",
        'active lens=' + nswView
    );
    if (nswView === 'state') xLens.state = m;
    else if (nswView === 'regional') xLens.regional = m;
    refreshNswView();
    // refreshNswView no longer restyles the map; the cross test has no showNSW/applyLegend follow-up,
    // so recolour the roads here to reflect the recategorisation grade (nswStyle reads xLens).
    if (nswLayer) nswLayer.setStyle(nswStyle);
    renderMapLegend();   // verdict-row labels follow the active mode (target category's tiers)
    // Brief top-centre pill while the vectors recolour (informative only).
    if (typeof showMapRefresh === 'function')
        showMapRefresh(m ? ('Re-grading as ' + XT_MODES[m].noun + '…') : 'Restoring own-criteria verdicts…', 1100);
}
// Back-compat entry point (the old checkbox's boolean semantics): ON = the lens's default
// other-category test, OFF = own criteria.
function toggleCrossLens(on) { setCrossTest(on ? (nswView === 'state' ? 'regional' : 'state') : false); }

// Counts for the active lens. Nat. Significant counts the NLTN network's national-criteria grades;
// the other lenses count roads by their category verdict (rolled-up aggregate + criteria).
const _lensCounts = {};   // non-cross per-lens counts are static after load — cache them (cf. scopeCounts)
window._lensCountsRef = _lensCounts;
function nswViewCounts() {
    if (nswView === 'nsr') {
        const n = window.NLTN_CAT_COUNTS || { green: 0, orange: 0, total: 0 };
        // Compute km for nationally significant roads from NSW_AGG
        let gKm = 0, oKm = 0, rKm = 0;
        const crit = window.NSW_CRIT || {};
        for (const k in NSW_AGG) {
            const a = NSW_AGG[k];
            if (!a._nsr) continue;
            const cr = crit[k];
            const nat = (cr && cr.nat) || 'orange';
            const len = a._len || 0;
            if (nat === 'green') gKm += len;
            else if (nat === 'orange') oKm += len;
            else rKm += len;
        }
        return { green: n.green, orange: n.orange, red: n.red || 0, total: n.total, greenKm: gKm, orangeKm: oKm, redKm: rKm };
    }
    // Cross-criteria test on: count each road by its verdict AGAINST the target category (the
    // lens's active mode — asReg / asNat on the State lens, asState / asNat on the Regional lens) so the
    // stat cards match the recoloured map.
    const mode = (nswView === 'state' && xLens.state) || (nswView === 'regional' && xLens.regional) || false;
    if (!mode && _lensCounts[nswView]) return _lensCounts[nswView];   // static verdict counts — O(1)
    const X = mode ? buildXtest() : null;
    const c = { green: 0, orange: 0, red: 0, total: 0, greenKm: 0, orangeKm: 0, redKm: 0 };
    for (const k in NSW_AGG) {
        const a = NSW_AGG[k];
        if (!nswInView(a)) continue;
        let v;
        if (mode) { const x = X[k]; v = x ? (mode === 'natsig' ? x.asNat : mode === 'regional' ? x.asReg : x.asState) : 'red'; }
        else { v = window.NSW_CRIT[k].verdict; }
        if (c[v] !== undefined) c[v]++;
        var len = a._len || 0;
        if (v === 'green') c.greenKm += len;
        else if (v === 'orange') c.orangeKm += len;
        else c.redKm += len;
        c.total++;
    }
    if (!mode) _lensCounts[nswView] = c;
    return c;
}

// Refresh the shared NSW panel (title, stats, legend, note) and restyle the map for the lens.
function refreshNswView() {
    if (typeof traceCode === 'function') traceCode(
        'Refresh NSW lens: ' + nswView,
        'This updates the left-panel cards for the active NSW lens. The map colours still come from each road verdict.',
        "function refreshNswView() {\n  const c = nswViewCounts();\n  document.getElementById('nsw-total').textContent = c.total.toLocaleString();\n  document.getElementById('nsw-green').textContent = c.green.toLocaleString();\n  document.getElementById('nsw-orange').textContent = c.orange.toLocaleString();\n  document.getElementById('nsw-red').textContent = c.red.toLocaleString();\n}",
        'lens=' + nswView
    );
    const m = NSW_VIEW_META[nswView]; if (!m) return;
    const c = nswViewCounts();
    // Nat. Significant is a 2-tier lens (green/pass, orange/likely pass) that hides the fail tier — but
    // ONLY while the data genuinely has no red route. If the national grading ever produces a red, surface
    // it instead of folding it into another tier: verdicts are earned from the data, not forced.
    const hideRed = m.hideRed && c.red === 0;
    const grid = document.querySelector('#tab-nsw .stat-grid');
    if (grid) { grid.style.display = ''; grid.style.gridTemplateColumns = hideRed ? 'repeat(2, 1fr)' : 'repeat(3, 1fr)'; }
    const redCard = document.getElementById('nsw-red').closest('.stat-card');
    if (redCard) redCard.style.display = hideRed ? 'none' : '';

    // Cross-criteria test — only on the State / Regional lenses. The segmented control offers "Own
    // criteria" + one button per cross-test the lens genuinely supports (XT_LENS_MODES, config.js);
    // when a mode is active the roads are re-graded against that category and the copy reflects it.
    const canCross = nswView === 'state' || nswView === 'regional';
    const mode = canCross ? ((nswView === 'state' ? xLens.state : xLens.regional) || false) : false;
    const xm = mode ? XT_MODES[mode] : null;         // { btn, short, noun } for the active mode
    const subject = nswView === 'state' ? 'State' : 'Regional';
    const xc = document.getElementById('nsw-xtest');
    if (xc) {
        xc.style.display = canCross ? '' : 'none';
        if (canCross) {
            const seg = document.getElementById('nsw-xt-seg');
            if (seg) {
                const xbtn = (mk, on, label) => '<button type="button" class="xt-btn' + (on ? ' on' : '') +
                    '" data-xt="' + mk + '" onclick="setCrossTest(\'' + mk + '\')">' + label + '</button>';
                let sh = xbtn('own', !mode, 'Own criteria');
                (XT_LENS_MODES[nswView] || []).forEach(mk => { sh += xbtn(mk, mode === mk, XT_MODES[mk].btn); });
                seg.innerHTML = sh;
            }
            const status = document.getElementById('nsw-xt-status');
            if (status) status.textContent = mode
                ? (c.total.toLocaleString() + ' ' + subject + ' roads re-graded against the ' + xm.noun + ' criteria.')
                : '';
            const fine = document.getElementById('nsw-xt-fine');
            if (fine && XT_LENS_FINE[nswView]) fine.textContent = XT_LENS_FINE[nswView];
        }
    }

    document.getElementById('nsw-hero-title').textContent = mode ? (m.title + ' — tested as ' + xm.short) : m.title;
    document.getElementById('nsw-total-sub').textContent = mode ? ('Re-graded against the ' + xm.noun + ' criteria — recategorisation test') : m.sub;
    document.getElementById('nsw-total').textContent = c.total.toLocaleString();
    const pct = n => c.total ? (n / c.total * 100).toFixed(0) + '% of these roads' : '';
    // The natsig test grades 3 national criteria (≥2 green / 1 orange), so a 1-of-2 label would lie.
    const oLbl = mode === 'natsig' ? 'Passes 1 criterion' : m.oLabel;
    document.getElementById('nsw-green-label').textContent = mode ? ('Passes ' + xm.short + ' criteria') : m.gLabel;
    document.getElementById('nsw-green').textContent = c.green.toLocaleString();
    document.getElementById('nsw-green-pct').textContent = pct(c.green) + (c.greenKm ? ' · ' + Math.round(c.greenKm).toLocaleString() + ' km' : '');
    document.getElementById('nsw-orange-label').textContent = oLbl;
    document.getElementById('nsw-orange').textContent = c.orange.toLocaleString();
    document.getElementById('nsw-orange-pct').textContent = pct(c.orange) + (c.orangeKm ? ' · ' + Math.round(c.orangeKm).toLocaleString() + ' km' : '');
    document.getElementById('nsw-red-label').textContent = mode ? ('Fails ' + xm.short + ' criteria') : (hideRed ? m.rLabel : (m.rLabel || 'Fails criteria'));
    document.getElementById('nsw-red').textContent = c.red.toLocaleString();
    document.getElementById('nsw-red-pct').textContent = pct(c.red) + (c.redKm ? ' · ' + Math.round(c.redKm).toLocaleString() + ' km' : '');
    // Verdict distribution bar — the green/orange(/red) split for this lens, mirroring the Overview's
    // "by road group" bars. Nat. Significant is 2-tier (green/orange, no red — orange takes the
    // remainder); State/Regional are 3-tier (red fills the remainder). Local has no such panel.
    const distBar = document.getElementById('nsw-dist-bar');
    if (distBar) {
        const { gp, op, rp } = barPercents(c.green, c.orange, c.total, hideRed);
        const seg = (w, col) => w > 0 ? '<span style="width:' + w + '%; background:' + col + '"></span>' : '';
        distBar.innerHTML = seg(gp, '#16a34a') + seg(op, '#f59e0b') + seg(rp, '#dc2626');
        const gLbl = mode ? ('Passes ' + xm.short + ' criteria') : m.gLabel;
        const rLbl = mode ? ('Fails ' + xm.short + ' criteria') : (m.rLabel || 'Fails criteria');
        const dk = (col, label, n) => label ? '<span class="dk"><i style="background:' + col + '"></i>' + label + ' <b>' + n.toLocaleString() + '</b></span>' : '';
        document.getElementById('nsw-dist-key').innerHTML =
            dk('#16a34a', gLbl, c.green) + dk('#f59e0b', oLbl, c.orange) + (hideRed ? '' : dk('#dc2626', rLbl, c.red));
    }
    // The map legend itself is the floating panel (renderMapLegend), rebuilt by switchTab.
    // Mode active → the note describes the TARGET category's criteria (XT_MODE_NOTES, config.js).
    const np = document.querySelector('#nsw-note p');
    if (np) np.innerHTML = mode ? (XT_MODE_NOTES[mode] || m.note) : m.note;
    // Map restyle is owned by switchTab's follow-up showNSW()->applyLegend() (which styles nswLayer and,
    // on the nsr lens, nltnLayer). toggleCrossLens is the only caller without that follow-up, so it
    // restyles explicitly. This removes the second full-layer setStyle per NSW tab switch.
}

// Best fit panel: complete State/Regional results plus the offline statewide LocalRoad catalogue.
// Local candidates use the same confirmed/provisional category waterfall as declared roads.
function refreshFresh() {
    if (typeof traceCode === 'function') traceCode(
        'Refresh Best fit bins',
        'State and Regional roads are re-binned through the full criteria waterfall. Every operational NSW LocalRoad candidate is included using measured PBS Level 1 and B-double gates plus available optional criteria.',
        "function refreshFresh() {\n  const F = buildFresh();\n  const localMeta = window.LOCAL_ROAD_MANIFEST;\n  // full S/R results + statewide LocalRoad available-evidence outcomes\n}",
        'sources: prepared State/Regional criteria + NSW Transport Theme LocalRoad catalogue'
    );
    const F = buildFresh();
    const RANK = { fnat: 3, fstate: 2, freg: 1, flocal: 0 };
    const counts = { fnat: 0, fstate: 0, freg: 0, flocal: 0 };
    const km = { fnat: 0, fstate: 0, freg: 0, flocal: 0 };
    let total = 0, keep = 0, up = 0, down = 0, likely = 0;
    for (const k in NSW_AGG) {
        const a = NSW_AGG[k];
        if (a.admin_class !== 'S' && a.admin_class !== 'R') continue;
        const f = F[k]; if (!f) continue;
        total++;
        counts[f.cat]++;
        km[f.cat] += a._len || 0;
        if (f.tier === 'likely') likely++;
        // Today's standing: Nat. Significant tab membership (_nsr), else the administrative class.
        const cur = a._nsr ? 'fnat' : (a.admin_class === 'S' ? 'fstate' : 'freg');
        const d = RANK[f.cat] - RANK[cur];
        if (d === 0) keep++; else if (d > 0) up++; else down++;
    }
    const localMeta = window.LOCAL_ROAD_MANIFEST;
    const localStatuses = localMeta ? (localMeta.status_counts || {}) : {};
    const localStatusKm = localMeta ? (localMeta.status_length_km || {}) : {};
    const sourcedLocal = localMeta ? (+localMeta.road_count || 0) : 0;
    const localAvailable = +localStatuses.local_available || 0;
    const localState = (+localStatuses.potential_state || 0) + (+localStatuses.likely_state || 0);
    const localRegional = (+localStatuses.potential_regional || 0) + (+localStatuses.likely_regional || 0);
    const uncategorisedLocal = Math.max(0, sourcedLocal - localAvailable - localState - localRegional);
    counts.fstate += localState;
    counts.freg += localRegional;
    counts.flocal += localAvailable + uncategorisedLocal;
    km.fstate += (+localStatusKm.potential_state || 0) + (+localStatusKm.likely_state || 0);
    km.freg += (+localStatusKm.potential_regional || 0) + (+localStatusKm.likely_regional || 0);
    km.flocal += (+localStatusKm.local_available || 0) +
        Object.keys(localStatusKm).reduce((sum, status) =>
            ['potential_state', 'likely_state', 'potential_regional', 'likely_regional', 'local_available'].indexOf(status) === -1
                ? sum + (+localStatusKm[status] || 0) : sum, 0);
    likely += (+localStatuses.likely_state || 0) + (+localStatuses.likely_regional || 0);
    total += sourcedLocal;
    const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    const totalKm = km.fnat + km.fstate + km.freg + km.flocal;
    const lengthPct = value => {
        if (!totalKm) return '';
        const share = value / totalKm * 100;
        const precision = share < 0.1 ? 2 : 1;
        return share.toFixed(precision) + '% of assessed road length';
    };
    set('fresh-total', total.toLocaleString());
    set('fresh-nat', counts.fnat.toLocaleString());   set('fresh-nat-sub', lengthPct(km.fnat) + ' · ' + Math.round(km.fnat).toLocaleString() + ' km');
    set('fresh-state', counts.fstate.toLocaleString()); set('fresh-state-sub', lengthPct(km.fstate) + ' · ' + Math.round(km.fstate).toLocaleString() + ' km');
    set('fresh-reg', counts.freg.toLocaleString());   set('fresh-reg-sub', lengthPct(km.freg) + ' · ' + Math.round(km.freg).toLocaleString() + ' km');
    set('fresh-local', counts.flocal.toLocaleString()); set('fresh-local-sub', lengthPct(km.flocal) + ' · ' + Math.round(km.flocal).toLocaleString() + ' km');
    set('fresh-move', keep.toLocaleString() + ' existing State/Regional roads keep their current tier · ' +
        up.toLocaleString() + ' would move up · ' + down.toLocaleString() + ' would move down · ' +
        likely.toLocaleString() + ' are provisional · ' + sourcedLocal.toLocaleString() +
        ' sourced LocalRoad candidates assessed with measured PBS Level 1 and B-double access');
}

// Overview panel: whole network graded by own-category criteria, plus a per-group breakdown.
function refreshOverview() {
    if (typeof traceCode === 'function') traceCode(
        'Refresh Overview stats',
        'The Overview counts every assessed State and Regional road by its prepared criteria verdict.',
        "function refreshOverview() {\n  const { g, o, r, grp } = scopeCounts('all');\n  document.getElementById('ov-total').textContent = (g + o + r).toLocaleString();\n  document.getElementById('ov-green').textContent = g.toLocaleString();\n  document.getElementById('ov-orange').textContent = o.toLocaleString();\n  document.getElementById('ov-red').textContent = r.toLocaleString();\n}",
        'source: NSW_AGG + NSW_CRIT'
    );
    // Two mutually exclusive groups (State / Regional) that sum to the network total, each graded by its
    // own category criteria. National significance lives on its own lens (the NLTN network), not here.
    // (The Overview's "By road group" card is retired — scopeCounts still computes grp for the
    // Sydney / CV region cards, but nothing on this panel renders it.)
    const { g, o, r } = scopeCounts('all');
    const total = g + o + r;
    // Compute total network length and per-verdict km
    var totalKm = 0, greenKm = 0, orangeKm = 0, redKm = 0;
    var agg = (typeof NSW_AGG !== 'undefined') ? NSW_AGG : {};
    var crit = window.NSW_CRIT || {};
    for (var k in agg) {
        var a = agg[k];
        if (a.admin_class !== 'S' && a.admin_class !== 'R') continue;
        var len = a._len || 0;
        totalKm += len;
        var v = crit[k].verdict;
        if (v === 'green') greenKm += len;
        else if (v === 'orange') orangeKm += len;
        else redKm += len;
    }
    const pct = n => total ? (n / total * 100).toFixed(0) + '% of roads' : '';
    document.getElementById('ov-total').textContent = total.toLocaleString();
    document.getElementById('ov-total-sub').textContent = 'State & Regional roads · ' + Math.round(totalKm).toLocaleString() + ' km · ' + NSW_SEG_TOTAL.toLocaleString() + ' segments';
    document.getElementById('ov-green').textContent = g.toLocaleString(); document.getElementById('ov-green-pct').textContent = pct(g) + ' · ' + Math.round(greenKm).toLocaleString() + ' km';
    document.getElementById('ov-orange').textContent = o.toLocaleString(); document.getElementById('ov-orange-pct').textContent = pct(o) + ' · ' + Math.round(orangeKm).toLocaleString() + ' km';
    document.getElementById('ov-red').textContent = r.toLocaleString(); document.getElementById('ov-red-pct').textContent = pct(r) + ' · ' + Math.round(redKm).toLocaleString() + ' km';
    // Map restyle is owned by the follow-up showNSW()->applyLegend() in switchTab/init (avoids styling
    // all ~17k paths twice per tab switch); this panel refresher only updates the stats.
}
