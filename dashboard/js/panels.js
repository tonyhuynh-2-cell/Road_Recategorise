// panels.js — tab switching, NSW/CV map show, and the lens + overview stat panels.

function switchTab(tab) {
    if (tab === 'detail' && currentTab !== 'detail') lastViewTab = currentTab;   // remember where to return
    currentTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    const btn = document.querySelector(`.tab-btn[onclick*="'${tab}'"]`);
    if (btn) btn.classList.add('active');
    // Overview has its own panel; the three lenses share #tab-nsw; CV and Detail have their own.
    const contentId = (tab === 'overview') ? 'overview' : NSW_LENSES.includes(tab) ? 'nsw' : tab;
    document.getElementById(`tab-${contentId}`).classList.add('active');

    if (NSW_MAP_TABS.includes(tab)) {
        nswView = (tab === 'overview') ? 'all' : tab;
        if (tab === 'overview') refreshOverview(); else refreshNswView();
        showNSW();
    } else if (tab === 'cv') { refreshCV(); showCV(); }
    else if (tab === 'sydney') { refreshSydney(); showSydney(); }
    else if (tab === 'local') { refreshLocal(); showLocal(); }
    renderMapLegend();   // rebuild the floating legend for this view (also re-syncs the toggle dimming)
}

// Road Detail is shown on a road click (it's not a tab) — return to the view that was open.
function backFromDetail() { switchTab(lastViewTab || 'overview'); }

// Tab colour group (matches the tab-btn tinting + the floating legend accent):
// g1 = Overview · g2 = Nat.Significant / State / Regional / Local · g3 = Sydney / Clarence Valley.
function tabGroup(tab) {
    if (tab === 'nsr' || tab === 'state' || tab === 'regional' || tab === 'local') return 'g2';
    if (tab === 'sydney' || tab === 'cv') return 'g3';
    return 'g1';   // overview + detail
}

// Apply the legend on/off toggles + per-lens NLTN style to the map for the CURRENT view.
function applyLegend() {
    // CV tab + "Show only roads inside the LGA" → swap the full road overlay for the clipped copy.
    // Local tab → hide the State/Regional overlay entirely, so only the green local roads show.
    const cvClip = currentTab === 'cv' && legendToggles.clip;
    const hideNsw = cvClip || currentTab === 'local';
    if (nswLayer) { if (hideNsw) map.removeLayer(nswLayer); else { map.addLayer(nswLayer); nswLayer.setStyle(nswStyle); } }
    if (cvClipLayer) { if (cvClip) { map.addLayer(cvClipLayer); cvClipLayer.setStyle(nswStyle); } else map.removeLayer(cvClipLayer); }
    if (cvLayer) cvLayer.setStyle(cvStyle);
    // NLTN national network: the SUBJECT of the Nat. Significant lens only — graded green/orange.
    // Hidden on every other tab, incl. CV (it is no longer a reference underlay).
    if (nltnLayer) {
        // Shown on the Nat. Significant lens, the Overview AND the Sydney tab (which IS the Overview,
        // just framed on Sydney): the green/orange national network drawn alongside the road overlays.
        if ((currentTab === 'nsr' || currentTab === 'overview' || currentTab === 'sydney') && legendToggles.nltn) {
            map.addLayer(nltnLayer);
            nltnLayer.setStyle(nltnFeatureStyle);   // per-feature grade + proposed translucency
        } else map.removeLayer(nltnLayer);
    }
    // Connectivity highlights honour their per-category toggles — re-render the current selection.
    refreshConnections();
    // Town/City pins
    if (nswTownsLayer) map.removeLayer(nswTownsLayer);
    if (cvTownsLayer) map.removeLayer(cvTownsLayer);
    const towns = (currentTab === 'cv') ? cvTownsLayer : nswTownsLayer;   // Sydney reuses the statewide town pins
    if (towns && legendToggles.towns) map.addLayer(towns);
    // Region boundary outlines — CV LGA on the CV tab, Sydney SUA on the Sydney tab (one at a time).
    if (cvBoundaryLayer) { if (currentTab === 'cv' && legendToggles.boundary) map.addLayer(cvBoundaryLayer); else map.removeLayer(cvBoundaryLayer); }
    if (sydBoundaryLayer) { if (currentTab === 'sydney' && legendToggles.boundary) map.addLayer(sydBoundaryLayer); else map.removeLayer(sydBoundaryLayer); }
    // HV bypass network highlight (statewide; off by default) — halo under the roads.
    if (bypassLayer) { if (legendToggles.bypass) map.addLayer(bypassLayer); else map.removeLayer(bypassLayer); }
    // Local roads (council) — lazy-loaded live, zoom-gated (see local.js). Refresh for the current view.
    if (typeof updateLocalRoads === 'function') updateLocalRoads();
    if (typeof updateLocalX === 'function') updateLocalX();   // Cross-test tab: green local-road vectors
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
    const townSw = '<div class="legend-color" style="background:#57534e; width:9px; height:9px; border-radius:50%"></div>';
    const vkeys = ['green', 'orange', 'red'];
    let h = '<h3>Map legend</h3>';
    if (currentTab === 'cv') {
        h += li('green', sw('#16a34a'), 'Meets its criteria (≥2 optional)');
        h += li('orange', sw('#f59e0b'), 'Meets 1 of 2 — may pass with ADT');
        h += li('red', sw('#dc2626'), 'Does not meet (→ downgrade)');
        h += li('dashed', dashSw, 'Route-numbered road A / B / D / M (dashed)');
        h += li('towns', townSw, 'Town centres / POIs');
        h += li('boundary', '<div class="legend-color" style="background:#000000; height:2.5px"></div>', 'LGA boundary (outline)');
        h += li('clip', '<div class="legend-color" style="background:transparent; border:1.5px solid #1c1917; height:11px; border-radius:2px"></div>', 'Show only roads inside the LGA');
    } else if (currentTab === 'sydney') {
        h += li('green', sw('#16a34a'), 'Meets its criteria (≥2 optional)');
        h += li('orange', sw('#f59e0b'), 'Meets 1 of 2 — may pass with ADT');
        h += li('red', sw('#dc2626'), 'Does not meet (→ downgrade)');
        h += li('dashed', dashSw, 'Route-numbered road A / B / D / M (dashed)');
        h += li('towns', townSw, 'Town / City — pin size scales with population');
        h += li('boundary', '<div class="legend-color" style="background:#000000; height:2.5px"></div>', 'Sydney outline');
    } else if (currentTab === 'local') {
        h += liStatic('<div class="legend-color" style="background:#16a34a; height:2px"></div>', 'Local road (council) — green');
        h += li('green', sw('#16a34a'), 'Tested: meets Regional (≥2 centres)');
        h += li('orange', sw('#f59e0b'), 'Tested: 1 centre nearby');
        h += li('red', sw('#dc2626'), 'Tested: no ≥2-centre link');
        h += li('towns', townSw, 'Town / City — pin size scales with population');
    } else if (NSW_LENSES.includes(currentTab) && NSW_VIEW_META[nswView]) {
        const m = NSW_VIEW_META[nswView];
        m.legend.forEach(([col, lab], i) => { h += li(vkeys[i], sw(col), lab); });
        if (nswView === 'nsr') h += liStatic('<div class="legend-color" style="background:#16a34a; opacity:0.45"></div>', 'Proposed corridor — not yet built (translucent)');
        else h += li('dashed', dashSw, 'Route-numbered road A / B / D / M (dashed)');
        h += li('towns', townSw, 'Town / City — pin size scales with population');
    } else {   // overview + detail
        h += li('green', sw('#16a34a'), 'Meets its criteria (≥2 optional)');
        h += li('orange', sw('#f59e0b'), 'Meets 1 of 2 — may pass with ADT');
        h += li('red', sw('#dc2626'), 'Does not meet (→ downgrade)');
        h += li('dashed', dashSw, 'Route-numbered road A / B / D / M (dashed)');
        h += li('towns', townSw, 'Town / City — pin size scales with population');
    }
    // Local roads & street names (basemap label overlay) — a toggle on the road-map tabs; the labels
    // switch on once zoomed in (LOCAL_ZOOM), naming the local roads already drawn on the base map.
    if (['overview', 'state', 'regional', 'sydney', 'cv', 'local'].indexOf(currentTab) !== -1)
        h += li('local', '<div class="legend-color" style="background:#9a938c; height:2px"></div>', 'Local roads & street names · zoom in');
    h += hiliteLegendHTML();
    el.innerHTML = h;
    el.classList.remove('legend-g1', 'legend-g2', 'legend-g3');
    el.classList.add('legend-' + tabGroup(currentTab));   // accent the legend to match the active tab group
    syncLegendVisuals();
}

// HV bypass isolate (bottom-left checkbox): ON hides every other legend layer + highlight and shows
// ONLY the NHVR heavy-vehicle bypass overlay; OFF restores the exact previous toggle state.
let _bypassSaved = null;
function toggleBypassIsolate(on) {
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
}

// Clicking a legend swatch toggles that category on/off across the map.
function toggleLegendItem(key) {
    legendToggles[key] = !legendToggles[key];
    if (key === 'clip') deselect();   // swapping the road layer — clear any stale selection/highlight
    // Only the clicked key's row changed state — update just its row(s) rather than re-sweeping every
    // legend row (syncLegendVisuals, still used on full rebuilds + the multi-toggle bypass isolate).
    document.querySelectorAll('.legend-item[data-legend-key="' + key + '"]').forEach(function (el) {
        el.classList.toggle('legend-off', !legendToggles[key]);
    });
    applyLegend();
}

// Dim the disabled rows on every legend so all tabs stay in sync with the toggle state.
function syncLegendVisuals() {
    document.querySelectorAll('.legend-item[data-legend-key]').forEach(function (el) {
        el.classList.toggle('legend-off', !legendToggles[el.getAttribute('data-legend-key')]);
    });
}

function showNSW() {
    if (cvLayer) map.removeLayer(cvLayer);
    // Every NSW lens (incl. Nat. Significant) shows the criteria-graded roads; the green NLTN
    // network is only a faint reference underneath.
    if (nswLayer) map.addLayer(nswLayer);
    applyLegend();
    // Frame NSW only when arriving from a different context (or first load) — switching among the
    // NSW lens tabs preserves the user's current pan/zoom.
    if (mapContext !== 'nsw' && nswLayer) map.fitBounds(nswLayer.getBounds().pad(0.05));
    mapContext = 'nsw';
}

function showCV() {
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
function scopeCounts(scope) {
    if (_scopeCounts[scope]) return _scopeCounts[scope];
    let g = 0, o = 0, r = 0;
    const grp = {
        'State Roads': { green: 0, orange: 0, red: 0, total: 0 },
        'Regional Roads': { green: 0, orange: 0, red: 0, total: 0 }
    };
    for (const k in NSW_AGG) {
        const a = NSW_AGG[k];
        if (a.admin_class !== 'S' && a.admin_class !== 'R') continue;
        if (scope === 'cv' && !a._inCV) continue;
        if (scope === 'syd' && !a._inSyd) continue;
        const cr = window.NSW_CRIT ? window.NSW_CRIT[k] : null;
        const v = (cr && cr.verdict) || a.status;
        const group = a.admin_class === 'S' ? 'State Roads' : 'Regional Roads';
        if (v === 'green') g++; else if (v === 'orange') o++; else r++;
        grp[group][v]++; grp[group].total++;
    }
    return (_scopeCounts[scope] = { g: g, o: o, r: r, grp: grp });
}

// CV / Sydney tab stats — the Overview breakdown filtered to one region (roads touching the Clarence
// Valley LGA via _inCV, or inside the Sydney SUA via _inSyd). Same shape; only the key differs ('cv' /
// 'syd'), which drives the scope, the region NLTN counts, and the DOM id prefix — so one function serves
// both. refreshCV / refreshSydney remain as named entry points (switchTab + init.js call them).
function refreshRegion(key) {
    const { g, o, r, grp } = scopeCounts(key);
    const total = g + o + r;
    const pct = n => total ? (n / total * 100).toFixed(0) + '% of roads' : '';
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set(key + '-total', total.toLocaleString());
    set(key + '-green', g.toLocaleString()); set(key + '-green-pct', pct(g));
    set(key + '-orange', o.toLocaleString()); set(key + '-orange-pct', pct(o));
    set(key + '-red', r.toLocaleString()); set(key + '-red-pct', pct(r));
    const grpRows = [natSigGroupRow(nltnRegionCounts(key)), ...Object.entries(grp)].filter(Boolean);
    const gb = document.getElementById(key + '-group-breakdown'); if (gb) gb.innerHTML = groupBreakdownHTML(grpRows);
}
function refreshCV() { refreshRegion('cv'); }
function refreshSydney() { refreshRegion('syd'); }

// --- Local tab: council roads (green) drawn over the State + Regional network (context) ---
function showLocal() {
    if (cvLayer) map.removeLayer(cvLayer);
    applyLegend();   // removes the S/R overlay (Local shows only local roads) + kicks off updateLocalX
    // No refit — keep the current pan/zoom; local roads load once zoomed in past LOCALX_ZOOM.
    mapContext = 'local';
}

// Local tab panel: the in-view count is filled by the Overpass fetch (setLocalTotal, local.js). Reset it
// on (re)entering so a stale number doesn't linger before the fetch runs.
function refreshLocal() {
    if (typeof setLocalTotal === 'function') setLocalTotal(null);
}

// Cross-criteria toggle for the State / Regional lenses (folded in from the old Cross-test tab): re-grade
// the shown roads against the OTHER category. refreshNswView recolours the map and re-counts the cards.
function toggleCrossLens(on) {
    if (nswView === 'state') xLens.state = !!on;
    else if (nswView === 'regional') xLens.regional = !!on;
    refreshNswView();
    // refreshNswView no longer restyles the map; the cross toggle has no showNSW/applyLegend follow-up,
    // so recolour the roads here to reflect the reclassification grade (nswStyle reads xLens).
    if (nswLayer) nswLayer.setStyle(nswStyle);
}

// Counts for the active lens. Nat. Significant counts the NLTN network's national-criteria grades;
// the other lenses count roads by their category verdict (rolled-up aggregate + criteria).
const _lensCounts = {};   // non-cross per-lens counts are static after load — cache them (cf. scopeCounts)
function nswViewCounts() {
    if (nswView === 'nsr') {
        const n = window.NLTN_CAT_COUNTS || { green: 0, orange: 0, total: 0 };
        return { green: n.green, orange: n.orange, red: n.red || 0, total: n.total };   // carry red, don't force 0
    }
    // Cross-criteria toggle on: count each road by its verdict AGAINST the other category (asReg on the
    // State lens, asState on the Regional lens) so the stat cards match the recoloured map.
    const cross = (nswView === 'state' && xLens.state) || (nswView === 'regional' && xLens.regional);
    if (!cross && _lensCounts[nswView]) return _lensCounts[nswView];   // static verdict counts — O(1)
    const X = cross ? buildXtest() : null;
    const c = { green: 0, orange: 0, red: 0, total: 0 };
    for (const k in NSW_AGG) {
        const a = NSW_AGG[k];
        if (!nswInView(a)) continue;
        let v;
        if (cross) { const x = X[k]; v = x ? (nswView === 'state' ? x.asReg : x.asState) : 'red'; }
        else { const cr = window.NSW_CRIT ? window.NSW_CRIT[k] : null; v = (cr && cr.verdict) || a.status; }
        if (c[v] !== undefined) c[v]++;
        c.total++;
    }
    if (!cross) _lensCounts[nswView] = c;
    return c;
}

// Refresh the shared NSW panel (title, stats, legend, note) and restyle the map for the lens.
function refreshNswView() {
    const m = NSW_VIEW_META[nswView]; if (!m) return;
    const c = nswViewCounts();
    // Nat. Significant is a 2-tier lens (green / "would meet") that hides the "does not meet" tier — but
    // ONLY while the data genuinely has no red route. If the national grading ever produces a red, surface
    // it instead of folding it into "would meet": verdicts are earned from the data, not forced.
    const hideRed = m.hideRed && c.red === 0;
    const grid = document.querySelector('#tab-nsw .stat-grid');
    if (grid) { grid.style.display = ''; grid.style.gridTemplateColumns = hideRed ? 'repeat(2, 1fr)' : 'repeat(3, 1fr)'; }
    const redCard = document.getElementById('nsw-red').closest('.stat-card');
    if (redCard) redCard.style.display = hideRed ? 'none' : '';

    // Cross-criteria toggle — only on the State / Regional lenses. When ON, the roads are re-graded
    // against the OTHER category (State→Regional, Regional→State) and the panel copy reflects that.
    const canCross = nswView === 'state' || nswView === 'regional';
    const cross = canCross && (nswView === 'state' ? xLens.state : xLens.regional);
    const other = nswView === 'state' ? 'Regional' : 'State';
    const xc = document.getElementById('nsw-xtest');
    if (xc) {
        xc.style.display = canCross ? '' : 'none';
        if (canCross) {
            const lbl = document.getElementById('nsw-xtest-label');
            if (lbl) lbl.innerHTML = 'Grade these ' + (nswView === 'state' ? 'State' : 'Regional') + ' roads as <strong>' + other + '</strong> (reclassification test)';
            const cb = document.getElementById('nsw-xtest-cb'); if (cb) cb.checked = !!cross;
        }
    }

    document.getElementById('nsw-hero-title').textContent = cross ? (m.title + ' — tested as ' + other) : m.title;
    document.getElementById('nsw-total-sub').textContent = cross ? ('Re-graded against the ' + other + ' Road criteria — reclassification test') : m.sub;
    document.getElementById('nsw-total').textContent = c.total.toLocaleString();
    const pct = n => c.total ? (n / c.total * 100).toFixed(0) + '% of these roads' : '';
    document.getElementById('nsw-green-label').textContent = cross ? ('Would meet ' + other) : m.gLabel;
    document.getElementById('nsw-green').textContent = c.green.toLocaleString();
    document.getElementById('nsw-green-pct').textContent = pct(c.green);
    document.getElementById('nsw-orange-label').textContent = m.oLabel;
    document.getElementById('nsw-orange').textContent = c.orange.toLocaleString();
    document.getElementById('nsw-orange-pct').textContent = pct(c.orange);
    document.getElementById('nsw-red-label').textContent = cross ? ('Would not meet ' + other) : (hideRed ? m.rLabel : (m.rLabel || 'Does not meet'));
    document.getElementById('nsw-red').textContent = c.red.toLocaleString();
    document.getElementById('nsw-red-pct').textContent = pct(c.red);
    // Verdict distribution bar — the green/orange(/red) split for this lens, mirroring the Overview's
    // "by road group" bars. Nat. Significant is 2-tier (green/orange, no red — orange takes the
    // remainder); State/Regional are 3-tier (red fills the remainder). Local has no such panel.
    const distBar = document.getElementById('nsw-dist-bar');
    if (distBar) {
        const { gp, op, rp } = barPercents(c.green, c.orange, c.total, hideRed);
        const seg = (w, col) => w > 0 ? '<span style="width:' + w + '%; background:' + col + '"></span>' : '';
        distBar.innerHTML = seg(gp, '#16a34a') + seg(op, '#f59e0b') + seg(rp, '#dc2626');
        const gLbl = cross ? ('Would meet ' + other) : m.gLabel;
        const rLbl = cross ? ('Would not meet ' + other) : (m.rLabel || 'Does not meet');
        const dk = (col, label, n) => label ? '<span class="dk"><i style="background:' + col + '"></i>' + label + ' <b>' + n.toLocaleString() + '</b></span>' : '';
        document.getElementById('nsw-dist-key').innerHTML =
            dk('#16a34a', gLbl, c.green) + dk('#f59e0b', m.oLabel, c.orange) + (hideRed ? '' : dk('#dc2626', rLbl, c.red));
    }
    // The map legend itself is the floating panel (renderMapLegend), rebuilt by switchTab.
    const np = document.querySelector('#nsw-note p');
    if (np) np.textContent = cross
        ? ('Reclassification test — each road re-graded against the ' + other + ' Road criteria. The optional connectivity criteria are shared; only the mandatory gate swaps (State needs PBS-1 access, Regional needs 19m B-double access). Green = would meet ≥2 optional. Verdicts are earned from the data, not forced.')
        : m.note;
    // Map restyle is owned by switchTab's follow-up showNSW()->applyLegend() (which styles nswLayer and,
    // on the nsr lens, nltnLayer). toggleCrossLens is the only caller without that follow-up, so it
    // restyles explicitly. This removes the second full-layer setStyle per NSW tab switch.
}

// Overview panel: whole network graded by own-category criteria, plus a per-group breakdown.
function refreshOverview() {
    // Two mutually exclusive groups (State / Regional) that sum to the network total, each graded by its
    // own category criteria. National significance lives on its own lens (the NLTN network), not here.
    const { g, o, r, grp } = scopeCounts('all');
    const total = g + o + r;
    const pct = n => total ? (n / total * 100).toFixed(0) + '% of roads' : '';
    document.getElementById('ov-total').textContent = total.toLocaleString();
    document.getElementById('ov-total-sub').textContent = 'State & Regional roads · ' + NSW_SEG_TOTAL.toLocaleString() + ' segments';
    document.getElementById('ov-green').textContent = g.toLocaleString(); document.getElementById('ov-green-pct').textContent = pct(g);
    document.getElementById('ov-orange').textContent = o.toLocaleString(); document.getElementById('ov-orange-pct').textContent = pct(o);
    document.getElementById('ov-red').textContent = r.toLocaleString(); document.getElementById('ov-red-pct').textContent = pct(r);
    // Prepend the Nat. Significant national network (statewide) above the two road groups.
    const grpRows = [natSigGroupRow(window.NLTN_CAT_COUNTS), ...Object.entries(grp)].filter(Boolean);
    document.getElementById('ov-group-breakdown').innerHTML = groupBreakdownHTML(grpRows);
    // Map restyle is owned by the follow-up showNSW()->applyLegend() in switchTab/init (avoids styling
    // all ~17k paths twice per tab switch); this panel refresher only updates the stats.
}
