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
    } else if (tab === 'cv') showCV();
    syncLegendVisuals();
}

// Road Detail is shown on a road click (it's not a tab) — return to the view that was open.
function backFromDetail() { switchTab(lastViewTab || 'overview'); }

// Apply the legend on/off toggles + per-lens NLTN style to the map for the CURRENT view.
function applyLegend() {
    const onNSW = currentTab !== 'cv';
    if (nswLayer) nswLayer.setStyle(nswStyle);   // re-filter verdict colours / dashed roads
    if (cvLayer) cvLayer.setStyle(cvStyle);
    // Green national network: NSW tabs only, when toggled on. Solid on Nat. Significant (and its pane
    // lifted above the road overlay so it's clickable); faint underlay on the other NSW tabs.
    if (nltnLayer) {
        if (onNSW && legendToggles.nltn) {
            map.addLayer(nltnLayer);
            nltnLayer.setStyle(nltnFeatureStyle);   // per-feature (handles proposed translucency)
            const np = map.getPane('nltnPane'); if (np) np.style.zIndex = (nswView === 'nsr') ? 450 : 350;
        } else map.removeLayer(nltnLayer);
    }
    // Town/City pins
    if (nswTownsLayer) map.removeLayer(nswTownsLayer);
    if (cvTownsLayer) map.removeLayer(cvTownsLayer);
    const towns = onNSW ? nswTownsLayer : cvTownsLayer;
    if (towns && legendToggles.towns) map.addLayer(towns);
    // CV LGA boundary (CV tab only)
    if (cvBoundaryLayer) { if (!onNSW && legendToggles.boundary) map.addLayer(cvBoundaryLayer); else map.removeLayer(cvBoundaryLayer); }
}

// Clicking a legend swatch toggles that category on/off across the map.
function toggleLegendItem(key) {
    legendToggles[key] = !legendToggles[key];
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
    // Nat. Significant lens: hide the criteria-graded State-road layer (the A/B/M route-shielded
    // roads) — there the nationally significant roads ARE the green NLTN lines.
    if (nswLayer) { if (nswView === 'nsr') map.removeLayer(nswLayer); else map.addLayer(nswLayer); }
    applyLegend();
    // Frame NSW only when arriving from a different context (or first load) — switching among the
    // NSW lens tabs preserves the user's current pan/zoom.
    if (mapContext !== 'nsw' && nswLayer) map.fitBounds(nswLayer.getBounds().pad(0.05));
    mapContext = 'nsw';
}

function showCV() {
    if (nswLayer) map.removeLayer(nswLayer);
    if (cvLayer) map.addLayer(cvLayer);
    applyLegend();
    if (mapContext !== 'cv' && cvLayer) map.fitBounds(cvLayer.getBounds().pad(0.05));
    mapContext = 'cv';
}

// Road-level counts for the active lens (uses the rolled-up per-road aggregate + criteria).
function nswViewCounts() {
    const c = { green: 0, orange: 0, red: 0, total: 0 };
    for (const k in NSW_AGG) {
        const a = NSW_AGG[k];
        if (!nswInView(a)) continue;
        const cr = window.NSW_CRIT ? window.NSW_CRIT[k] : null;
        const v = (nswView === 'nsr') ? natStatusOf(k, a._nsr) : ((cr && cr.verdict) || a.status);
        if (c[v] !== undefined) c[v]++;
        c.total++;
    }
    return c;
}

// Refresh the shared NSW panel (title, stats, legend, note) and restyle the map for the lens.
function refreshNswView() {
    const m = NSW_VIEW_META[nswView]; if (!m) return;
    const grid = document.querySelector('#tab-nsw .stat-grid');
    document.getElementById('nsw-hero-title').textContent = m.title;
    document.getElementById('nsw-total-sub').textContent = m.sub;
    if (nswView === 'nsr') {
        // Nationally significant = the official NLTN green network itself (no per-road grading,
        // no A-route shields), so show the network length and hide the green/orange/red grid.
        document.getElementById('nsw-total').textContent = window.NLTN_KM ? (window.NLTN_KM.toLocaleString() + ' km') : '–';
        if (grid) grid.style.display = 'none';
    } else {
        if (grid) grid.style.display = '';
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
    }
    // Clickable legend rows (data-legend-key) toggle that category on the map; static rows don't.
    const li = (key, swatch, label) => '<div class="legend-item" data-legend-key="' + key + '" onclick="toggleLegendItem(\'' + key + '\')">' + swatch + ' ' + label + '</div>';
    const vkeys = ['green', 'orange', 'red'];
    let lh = '<h3>Map legend</h3>';
    // State/Regional lenses grade roads (green/orange/red); the Nat. Significant lens is just the network.
    if (nswView !== 'nsr') m.legend.forEach(([col, lab], i) => { lh += li(vkeys[i], '<div class="legend-color" style="background:' + col + '"></div>', lab); });
    lh += li('nltn', '<div class="legend-color" style="background:#3cb043; opacity:0.55"></div>', 'National Network — Road · NLTN Determination 2020 (data.gov.au)');
    // Proposed corridors share the 'nltn' key — they toggle/dim together with the national network.
    lh += li('nltn', '<div class="legend-color" style="background:#3cb043; opacity:0.22"></div>', 'Proposed corridor (translucent, dashed)');
    lh += li('dashed', '<div class="legend-color legend-dash"></div>', 'Route-numbered road A / B / D / M (dashed)');
    lh += li('towns', '<div class="legend-color" style="background:#57534e; width:9px; height:9px; border-radius:50%"></div>', 'Town / City — pin size scales with population');
    document.getElementById('nsw-legend').innerHTML = lh;
    syncLegendVisuals();
    const np = document.querySelector('#nsw-note p'); if (np) np.textContent = m.note;
    if (nswLayer) nswLayer.setStyle(nswStyle);
}

// Overview panel: whole network graded by own-category criteria, plus a per-group breakdown.
function refreshOverview() {
    let g = 0, o = 0, r = 0;
    const grp = {
        'Nationally Significant': { green: 0, orange: 0, red: 0, total: 0 },
        'State Roads': { green: 0, orange: 0, red: 0, total: 0 },
        'Regional Roads': { green: 0, orange: 0, red: 0, total: 0 }
    };
    for (const k in NSW_AGG) {
        const a = NSW_AGG[k];
        if (a.admin_class !== 'S' && a.admin_class !== 'R') continue;
        const cr = window.NSW_CRIT ? window.NSW_CRIT[k] : null;
        // Mutually exclusive groups (sum to the network total), each by its own lens grade.
        let v, group;
        if (a.admin_class === 'S' && a._nsr) { v = natStatusOf(k, a._nsr); group = 'Nationally Significant'; }
        else if (a.admin_class === 'S') { v = (cr && cr.verdict) || a.status; group = 'State Roads'; }
        else { v = (cr && cr.verdict) || a.status; group = 'Regional Roads'; }
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
