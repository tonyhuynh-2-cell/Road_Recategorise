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
    renderMapLegend();   // rebuild the floating legend for this view (also re-syncs the toggle dimming)
}

// Road Detail is shown on a road click (it's not a tab) — return to the view that was open.
function backFromDetail() { switchTab(lastViewTab || 'overview'); }

// Apply the legend on/off toggles + per-lens NLTN style to the map for the CURRENT view.
function applyLegend() {
    const onNSW = currentTab !== 'cv';
    // CV tab + "Show only roads inside the LGA" → swap the full road overlay for the clipped copy.
    const cvClip = !onNSW && legendToggles.clip;
    if (nswLayer) { if (cvClip) map.removeLayer(nswLayer); else { map.addLayer(nswLayer); nswLayer.setStyle(nswStyle); } }
    if (cvClipLayer) { if (cvClip) { map.addLayer(cvClipLayer); cvClipLayer.setStyle(nswStyle); } else map.removeLayer(cvClipLayer); }
    if (cvLayer) cvLayer.setStyle(cvStyle);
    // NLTN national network: the SUBJECT of the Nat. Significant lens only — graded green/orange.
    // Hidden on every other tab, incl. CV (it is no longer a reference underlay).
    if (nltnLayer) {
        if (onNSW && nswView === 'nsr') {
            map.addLayer(nltnLayer);
            nltnLayer.setStyle(nltnFeatureStyle);   // per-feature grade + proposed translucency
        } else map.removeLayer(nltnLayer);
    }
    // Connectivity highlights honour their per-category toggles — re-render the current selection.
    refreshConnections();
    // Town/City pins
    if (nswTownsLayer) map.removeLayer(nswTownsLayer);
    if (cvTownsLayer) map.removeLayer(cvTownsLayer);
    const towns = onNSW ? nswTownsLayer : cvTownsLayer;
    if (towns && legendToggles.towns) map.addLayer(towns);
    // CV LGA boundary (CV tab only)
    if (cvBoundaryLayer) { if (!onNSW && legendToggles.boundary) map.addLayer(cvBoundaryLayer); else map.removeLayer(cvBoundaryLayer); }
    // HV bypass network highlight (statewide; off by default) — halo under the roads.
    if (bypassLayer) { if (legendToggles.bypass) map.addLayer(bypassLayer); else map.removeLayer(bypassLayer); }
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
    // HV bypass network highlight — a halo over roads on an NHVR heavy-vehicle bypass route.
    h += li('bypass', '<div class="legend-color" style="background:#0891b2; height:4px; opacity:0.7"></div>', 'HV bypass network (NHVR)');
    h += hiliteLegendHTML();
    el.innerHTML = h;
    syncLegendVisuals();
}

// Clicking a legend swatch toggles that category on/off across the map.
function toggleLegendItem(key) {
    legendToggles[key] = !legendToggles[key];
    if (key === 'clip') deselect();   // swapping the road layer — clear any stale selection/highlight
    syncLegendVisuals();
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

// CV tab stats = the Overview breakdown, filtered to roads that touch the Clarence Valley LGA (_inCV).
function refreshCV() {
    let g = 0, o = 0, r = 0;
    const grp = {
        'State Roads': { green: 0, orange: 0, red: 0, total: 0 },
        'Regional Roads': { green: 0, orange: 0, red: 0, total: 0 }
    };
    for (const k in NSW_AGG) {
        const a = NSW_AGG[k];
        if (!a._inCV || (a.admin_class !== 'S' && a.admin_class !== 'R')) continue;
        const cr = window.NSW_CRIT ? window.NSW_CRIT[k] : null;
        const v = (cr && cr.verdict) || a.status;
        const group = a.admin_class === 'S' ? 'State Roads' : 'Regional Roads';
        if (v === 'green') g++; else if (v === 'orange') o++; else r++;
        grp[group][v]++; grp[group].total++;
    }
    const total = g + o + r;
    const pct = n => total ? (n / total * 100).toFixed(0) + '% of roads' : '';
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('cv-total', total.toLocaleString());
    set('cv-green', g.toLocaleString()); set('cv-green-pct', pct(g));
    set('cv-orange', o.toLocaleString()); set('cv-orange-pct', pct(o));
    set('cv-red', r.toLocaleString()); set('cv-red-pct', pct(r));
    let bh = '';
    for (const [name, d] of Object.entries(grp)) {
        const gp = d.total ? (d.green / d.total * 100).toFixed(0) : 0;
        const op = d.total ? (d.orange / d.total * 100).toFixed(0) : 0;
        bh += '<div class="category-row"><span class="cat-name">' + name + ' <span style="color:var(--faint)">(' + d.total + ')</span></span>' +
            '<div class="cat-bar"><div class="bar-bg"><div class="bar-fill green" style="width:' + gp + '%"></div>' +
            '<div class="bar-fill orange" style="width:' + op + '%"></div></div><span class="cat-pct">' + gp + '%</span></div></div>';
    }
    const gb = document.getElementById('cv-group-breakdown'); if (gb) gb.innerHTML = bh;
}

// Counts for the active lens. Nat. Significant counts the NLTN network's national-criteria grades;
// the other lenses count roads by their category verdict (rolled-up aggregate + criteria).
function nswViewCounts() {
    if (nswView === 'nsr') {
        const n = window.NLTN_CAT_COUNTS || { green: 0, orange: 0, total: 0 };
        return { green: n.green, orange: n.orange, red: 0, total: n.total };
    }
    const c = { green: 0, orange: 0, red: 0, total: 0 };
    for (const k in NSW_AGG) {
        const a = NSW_AGG[k];
        if (!nswInView(a)) continue;
        const cr = window.NSW_CRIT ? window.NSW_CRIT[k] : null;
        const v = (cr && cr.verdict) || a.status;
        if (c[v] !== undefined) c[v]++;
        c.total++;
    }
    return c;
}

// Refresh the shared NSW panel (title, stats, legend, note) and restyle the map for the lens.
function refreshNswView() {
    const m = NSW_VIEW_META[nswView]; if (!m) return;
    const grid = document.querySelector('#tab-nsw .stat-grid');
    if (grid) { grid.style.display = ''; grid.style.gridTemplateColumns = m.hideRed ? 'repeat(2, 1fr)' : 'repeat(3, 1fr)'; }
    // Nat. Significant has no "does not meet" tier — everything on the network meets S-01 — so hide that card.
    const redCard = document.getElementById('nsw-red').closest('.stat-card');
    if (redCard) redCard.style.display = m.hideRed ? 'none' : '';
    document.getElementById('nsw-hero-title').textContent = m.title;
    document.getElementById('nsw-total-sub').textContent = m.sub;
    // Every lens (incl. Nat. Significant) is graded green/orange/red from the criteria.
    const c = nswViewCounts();
    document.getElementById('nsw-total').textContent = c.total.toLocaleString();
    const pct = n => c.total ? (n / c.total * 100).toFixed(0) + '% of these roads' : '';
    document.getElementById('nsw-green-label').textContent = m.gLabel;
    document.getElementById('nsw-green').textContent = c.green.toLocaleString();
    document.getElementById('nsw-green-pct').textContent = pct(c.green);
    document.getElementById('nsw-orange-label').textContent = m.oLabel;
    document.getElementById('nsw-orange').textContent = c.orange.toLocaleString();
    document.getElementById('nsw-orange-pct').textContent = pct(c.orange);
    document.getElementById('nsw-red-label').textContent = m.rLabel;
    document.getElementById('nsw-red').textContent = c.red.toLocaleString();
    document.getElementById('nsw-red-pct').textContent = pct(c.red);
    // The map legend itself is the floating panel (renderMapLegend), rebuilt by switchTab.
    const np = document.querySelector('#nsw-note p'); if (np) np.textContent = m.note;
    if (nswLayer) nswLayer.setStyle(nswStyle);
    if (nltnLayer && nswView === 'nsr') nltnLayer.setStyle(nltnFeatureStyle);
}

// Overview panel: whole network graded by own-category criteria, plus a per-group breakdown.
function refreshOverview() {
    let g = 0, o = 0, r = 0;
    const grp = {
        'State Roads': { green: 0, orange: 0, red: 0, total: 0 },
        'Regional Roads': { green: 0, orange: 0, red: 0, total: 0 }
    };
    for (const k in NSW_AGG) {
        const a = NSW_AGG[k];
        if (a.admin_class !== 'S' && a.admin_class !== 'R') continue;
        const cr = window.NSW_CRIT ? window.NSW_CRIT[k] : null;
        // Two mutually exclusive groups (sum to the network total), each by its own category grade.
        // National significance lives on its own lens (the NLTN network), not as a split of these roads.
        const v = (cr && cr.verdict) || a.status;
        const group = a.admin_class === 'S' ? 'State Roads' : 'Regional Roads';
        if (v === 'green') g++; else if (v === 'orange') o++; else r++;
        grp[group][v]++; grp[group].total++;
    }
    const total = g + o + r;
    const pct = n => total ? (n / total * 100).toFixed(0) + '% of roads' : '';
    document.getElementById('ov-total').textContent = total.toLocaleString();
    document.getElementById('ov-total-sub').textContent = 'State & Regional roads · ' + NSW_SEG_TOTAL.toLocaleString() + ' segments';
    document.getElementById('ov-green').textContent = g.toLocaleString(); document.getElementById('ov-green-pct').textContent = pct(g);
    document.getElementById('ov-orange').textContent = o.toLocaleString(); document.getElementById('ov-orange-pct').textContent = pct(o);
    document.getElementById('ov-red').textContent = r.toLocaleString(); document.getElementById('ov-red-pct').textContent = pct(r);
    let bh = '';
    for (const [name, d] of Object.entries(grp)) {
        const gp = d.total ? (d.green / d.total * 100).toFixed(0) : 0;
        const op = d.total ? (d.orange / d.total * 100).toFixed(0) : 0;
        bh += '<div class="category-row"><span class="cat-name">' + name + ' <span style="color:var(--faint)">(' + d.total + ')</span></span>' +
            '<div class="cat-bar"><div class="bar-bg"><div class="bar-fill green" style="width:' + gp + '%"></div>' +
            '<div class="bar-fill orange" style="width:' + op + '%"></div></div><span class="cat-pct">' + gp + '%</span></div></div>';
    }
    document.getElementById('ov-group-breakdown').innerHTML = bh;
    if (nswLayer) nswLayer.setStyle(nswStyle);
}
