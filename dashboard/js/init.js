// init.js — data load (Promise.all), per-road aggregation, layer construction, and boot. LOADS LAST.

// Load all data. Cache-bust so edits to data/ always load fresh (no stale browser cache).
const _bust = '?v=' + Date.now();
const _f = u => fetch(u + _bust).then(r => r.json());
Promise.all([
    _f('data/nsw_assessment.geojson'),
    _f('data/nsw_towns.geojson'),
    _f('data/clarence_valley_assessment.geojson'),
    _f('data/summary_stats.json'),
    _f('data/clarence_valley_boundary.geojson'),
    _f('data/towns_cv.geojson').catch(() => null),
    _f('data/nsw_refs.json').catch(() => []),
    _f('data/cv_refs.json').catch(() => []),
    _f('data/ref_overrides.json').catch(() => ({})),
    _f('data/nsw_urbanity.json').catch(() => []),
    _f('data/nsw_nltn.json').catch(() => []),
    _f('data/nsw_recat.json').catch(() => []),
    _f('data/nsw_criteria.json').catch(() => ({})),
    _f('data/nltn_2020_road.geojson').catch(() => null),
    _f('data/nltn_meta.json').catch(() => [])
]).then(([nswRoads, nswTowns, cvRoads, cvStats, cvBoundary, cvTowns, nswRefs, cvRefs, refOv, nswUrb, nswNltn, nswRecat, nswCrit, nltn, nltnMeta]) => {
    window.NSW_CRIT = nswCrit || {};   // per-road computed criteria results (data/nsw_criteria.json)
    NSW_SEG_TOTAL = (nswRoads.features || []).length;   // total road segments (e.g. 17,691)
    // Manual overrides (data/ref_overrides.json) win over the auto OSM join.
    // Key by road_number: "B76" forces a shield, "" removes it. By road_name (UPPER) as fallback.
    const ov = refOv || {};
    const applyRef = (f, autoRef) => {
        const p = f.properties;
        let o = ov[p.road_number];
        if (o === undefined && p.road_name) o = ov[String(p.road_name).toUpperCase()];
        f.properties.ref = (o !== undefined) ? (o || null) : (autoRef || p.ref || null);
    };
    nswRoads.features.forEach((f, i) => applyRef(f, nswRefs[i]));
    cvRoads.features.forEach((f, i) => applyRef(f, cvRefs[i]));
    // ABS Section-of-State urban/rural classification per segment (data/nsw_urbanity.json).
    const nu = nswUrb || [];
    nswRoads.features.forEach((f, i) => { f.properties._urbanSeg = nu[i] || null; });
    // National Land Transport Network membership per segment (data/nsw_nltn.json),
    // spatial-joined from infrastructure.gov.au — the authoritative national freight network.
    const nl = nswNltn || [];
    nswRoads.features.forEach((f, i) => { f.properties._nltn = !!nl[i]; });

    // NSW per-lens stats (totals, green/orange/red, legend, note) are computed by refreshNswView()
    // once the per-road aggregate (NSW_AGG) and criteria (NSW_CRIT) are built below.

    // === CV Tab Stats ===
    document.getElementById('cv-pct').textContent = cvStats.accuracy_pct + '%';
    document.getElementById('cv-detail').textContent = `${cvStats.roads_meeting_criteria} of ${cvStats.total_roads} segments align`;
    document.getElementById('cv-pass').textContent = cvStats.roads_meeting_criteria;
    document.getElementById('cv-fail').textContent = cvStats.roads_not_meeting;
    document.getElementById('cv-total').textContent = cvStats.total_roads;

    const cvCatDiv = document.getElementById('cv-category-breakdown');
    for (const [cat, d] of Object.entries(cvStats.by_category)) {
        cvCatDiv.innerHTML += `
            <div class="category-row">
                <span class="cat-name">${cat}</span>
                <div class="cat-bar">
                    <div class="bar-bg"><div class="bar-fill green" style="width:${d.accuracy_pct}%"></div></div>
                    <span class="cat-pct">${d.accuracy_pct}%</span>
                </div>
            </div>`;
    }

    const covDiv = document.getElementById('cv-data-coverage');
    const cov = cvStats.criteria_breakdown;
    covDiv.innerHTML = `
        <div class="category-row"><span class="cat-name">ADT data</span><span class="cat-pct">${cov.with_adt_data}/${cvStats.total_roads}</span></div>
        <div class="category-row"><span class="cat-name">Heavy vehicle %</span><span class="cat-pct">${cov.with_hv_data}/${cvStats.total_roads}</span></div>
        <div class="category-row"><span class="cat-name">PBS Level 1</span><span class="cat-pct">${cov.with_pbs1}/${cvStats.total_roads}</span></div>
        <div class="category-row"><span class="cat-name">B-double access</span><span class="cat-pct">${cov.with_bdouble}/${cvStats.total_roads}</span></div>
        <div class="category-row"><span class="cat-name">Key freight route</span><span class="cat-pct">${cov.on_freight_network}/${cvStats.total_roads}</span></div>`;

    // === Build Map Layers ===

    // NSW Roads — aggregate per road so a click selects the whole road
    const NSW_BOOLS = ['has_pbs1', 'has_bdouble', 'is_key_freight_route', 'connects_major_town', 'connects_hospital'];
    const nswRoadAgg = {}, nswRoadLayers = {};
    nswRoads.features.forEach(f => {
        const k = roadKeyOf(f.properties); if (!k) return;
        const a = nswRoadAgg[k] || (nswRoadAgg[k] = Object.assign({}, f.properties, { status: 'red', _len: 0, _byStatus: { red: 0, orange: 0, green: 0 }, _urbanLen: 0, _ruralLen: 0, _nltnLen: 0 }));
        const len = roadLenKm(f.geometry);
        a._len += len;
        if (a._byStatus[f.properties.status] !== undefined) a._byStatus[f.properties.status] += len;
        if (f.properties._urbanSeg === 'urban') a._urbanLen += len; else if (f.properties._urbanSeg === 'rural') a._ruralLen += len;
        if (f.properties._nltn) a._nltnLen += len;
        NSW_BOOLS.forEach(b => { if (f.properties[b]) a[b] = 1; });
    });
    // Roll up each road to ONE verdict = the status covering most of its length
    // (majority by km; ties resolved conservatively red > orange > green).
    // Also roll up urban/rural by length, and flag Nationally Significant State Roads
    // = State road predominantly (>=50% of length) on the National Land Transport Network.
    Object.values(nswRoadAgg).forEach(a => {
        a.status = ['red', 'orange', 'green'].reduce((best, s) => (a._byStatus[s] > a._byStatus[best] ? s : best), 'red');
        a._urban = a._urbanLen > a._ruralLen;
        a._nsr = a.admin_class === 'S' && a._nltnLen >= 0.5 * a._len;
    });
    NSW_AGG = nswRoadAgg;   // expose per-road aggregate for the lens stats/counts
    const recat = nswRecat || [];
    nswRoads.features.forEach((f, i) => {
        const k = roadKeyOf(f.properties);
        const a = k && nswRoadAgg[k];
        f.properties._w = a ? weightForKm(a._len) : 1.6;
        // Re-categorised verdict (data/nsw_recat.json) computed from the full State/Regional
        // criteria table; falls back to the majority-by-length rollup if absent.
        f.properties._roadStatus = recat[i] || (a ? a.status : f.properties.status);
        f.properties._nsr = a ? a._nsr : false;   // State road predominantly on the NLTN (factual tag in detail)
        if (a && recat[i]) a.status = recat[i];   // detail panel reflects the re-categorised verdict
    });
    nswLayer = L.geoJSON(nswRoads, {
        style: nswStyle,
        smoothFactor: 1.5,
        filter: function(f) {
            const p = f.properties;
            if (isRamp(p)) return false;
            const ag = nswRoadAgg[roadKeyOf(p)];
            if (ag && ag._len < 0.35 && !(p.road_name && String(p.road_name).trim()) && !p.ref) return false;  // tiny unnamed/unnumbered junction stubs
            return true;
        },
        onEachFeature: function(feature, layer) {
            const k = roadKeyOf(feature.properties);
            if (k) (nswRoadLayers[k] || (nswRoadLayers[k] = [])).push(layer);
            const group = () => (k && nswRoadLayers[k]) ? nswRoadLayers[k] : [layer];
            layer.bindTooltip(roadLabel(feature.properties), { sticky: true, direction: 'top', offset: [0, -2], className: 'road-label' });
            layer.on('click', function(e) {
                if (!nswInView(feature.properties)) return;   // ignore roads hidden in the active lens
                L.DomEvent.stopPropagation(e);
                highlightRoad(group(), nswLayer);
                const agg = (k && nswRoadAgg[k]) ? Object.assign({}, nswRoadAgg[k], { ref: feature.properties.ref, road_name: feature.properties.road_name }) : feature.properties;
                showRoadDetail(agg, 'nsw');
            });
            layer.on('mouseover', function() { if (!nswInView(feature.properties)) return; if (!isSelected(layer)) group().forEach(l => l.setStyle({ weight: 5, opacity: 1 })); });
            layer.on('mouseout', function() { if (!isSelected(layer)) group().forEach(l => nswLayer.resetStyle(l)); });
        }
    });

    // NSW Towns
    nswTownsLayer = L.geoJSON(nswTowns, {
        pointToLayer: function(f, ll) {
            const pop = f.properties.population || 0;
            const size = pop >= 100000 ? 24 : pop >= 50000 ? 20 : pop >= 20000 ? 16 : pop >= 7000 ? 13 : 10;
            return L.marker(ll, { icon: townIcon(size, 'rgba(68,64,60,0.8)'), keyboard: false });
        },
        onEachFeature: function(f, layer) {
            layer.bindTooltip(f.properties.name, { permanent: true, direction: 'right', offset: [7, 0], className: 'town-label' });
            layer.bindPopup(townPopup(f.properties));   // click pin → name + population
        }
    });

    // NLTN 2020 network (data.gov.au "Key Freight Routes NLTN 2020 Road" = the NLTN Determination
    // 2020 road network) — the SUBJECT of the Nationally Significant lens. Each line is graded
    // green/orange by the national criteria of the road it runs along (precomputed in
    // data/nltn_natcat.json; see scratchpad/nltn_grade.py): green = on the network AND connects
    // ≥2 centres or a port/airport; orange = on the network only. Proposed corridors render
    // translucent. Shown only on the Nat. Significant lens.
    if (nltn && nltn.features) {
        // Each NLTN line carries its determination-route values (precomputed in data/nltn_meta.json):
        // _natGroup is the whole road it belongs to (the unit of selection), _natCat its grade,
        // _natName/_natRef the route label + shield, _natMetros/_natPortair the national criteria.
        nltn.features.forEach((f, i) => {
            const m = (nltnMeta && nltnMeta[i]) || {};
            f.properties._natCat = m.cat || 'green';
            f.properties._proposed = !!m.proposed;
            f.properties._natGroup = m.group || ('seg' + i);
            f.properties._natName = m.name || ((f.properties.street && titleCase(f.properties.street)) || 'National Network road');
            f.properties._natRef = m.ref || null;
            f.properties._natMetros = !!m.metros;
            f.properties._natPortair = !!m.portair;
        });
        // Count whole national ROADS (determination routes), not segments → Nat. Significant stat cards.
        const _seenG = {};
        window.NLTN_CAT_COUNTS = nltn.features.reduce((c, f) => {
            const g = f.properties._natGroup;
            if (!_seenG[g]) { _seenG[g] = 1; const v = f.properties._natCat; if (c[v] !== undefined) c[v]++; c.total++; }
            return c;
        }, { green: 0, orange: 0, red: 0, total: 0 });
        const nltnGroups = {};   // route key -> its segment layers, so a click selects the whole road in one piece
        nltnLayer = L.geoJSON(nltn, {
            renderer: nltnRenderer,
            pane: 'nltnPane',
            style: nltnFeatureStyle,
            onEachFeature: function(feature, layer) {
                const p = feature.properties || {};
                const gk = p._natGroup;
                (nltnGroups[gk] || (nltnGroups[gk] = [])).push(layer);
                const group = () => nltnGroups[gk] || [layer];
                layer.bindTooltip(nltnLabel(p) + (p._proposed ? ' · proposed' : ''), { sticky: true, direction: 'top', offset: [0, -2], className: 'road-label' });
                // Click selects the WHOLE road (all its segments) and opens the national-criteria detail.
                layer.on('click', function(e) {
                    L.DomEvent.stopPropagation(e);
                    highlightRoad(group(), nltnLayer);
                    showNltnDetail(p);
                });
                layer.on('mouseover', function() {
                    if (isSelected(layer)) return;
                    group().forEach(function(l) { const s = nltnFeatureStyle(l.feature); if (s.stroke === false) return; l.setStyle({ opacity: Math.min(1, s.opacity + 0.35), weight: s.weight + 3 }); });
                });
                layer.on('mouseout', function() {
                    group().forEach(function(l) { if (!isSelected(l)) l.setStyle(nltnFeatureStyle(l.feature)); });
                });
            }
        });
    }

    // CV Roads — group segments so a click selects the whole road
    const cvRoadLayers = {};
    // Roll up each CV road to ONE verdict = majority of its length meets criteria (tie -> fails).
    const cvRoadAgg = {};
    cvRoads.features.forEach(f => {
        const k = roadKeyOf(f.properties); if (!k) return;
        const a = cvRoadAgg[k] || (cvRoadAgg[k] = { yes: 0, no: 0 });
        const len = roadLenKm(f.geometry);
        if (f.properties.meets_criteria) a.yes += len; else a.no += len;
    });
    cvRoads.features.forEach(f => {
        const k = roadKeyOf(f.properties); const a = k && cvRoadAgg[k];
        if (a) f.properties._roadMeets = a.yes > a.no;
    });
    cvLayer = L.geoJSON(cvRoads, {
        style: cvStyle,
        smoothFactor: 1.5,
        filter: f => !isRamp(f.properties),
        onEachFeature: function(feature, layer) {
            const k = roadKeyOf(feature.properties);
            if (k) (cvRoadLayers[k] || (cvRoadLayers[k] = [])).push(layer);
            const group = () => (k && cvRoadLayers[k]) ? cvRoadLayers[k] : [layer];
            layer.bindTooltip(roadLabel(feature.properties), { sticky: true, direction: 'top', offset: [0, -2], className: 'road-label' });
            layer.on('click', function(e) {
                L.DomEvent.stopPropagation(e);
                highlightRoad(group(), cvLayer);
                showRoadDetail(feature.properties, 'cv');
            });
            layer.on('mouseover', function() { if (!isSelected(layer)) group().forEach(l => l.setStyle({ weight: 5, opacity: 1 })); });
            layer.on('mouseout', function() { if (!isSelected(layer)) group().forEach(l => cvLayer.resetStyle(l)); });
        }
    });

    // CV Boundary
    cvBoundaryLayer = L.geoJSON(cvBoundary, {
        style: {color: '#a8a29e', weight: 2, fillOpacity: 0, fillColor: 'transparent', dashArray: '5,5'}
    });

    // CV Towns
    if (cvTowns && cvTowns.features) {
        cvTownsLayer = L.geoJSON(cvTowns, {
            pointToLayer: function(f, ll) {
                return L.marker(ll, { icon: townIcon(14, 'rgba(68,64,60,0.8)'), keyboard: false });
            },
            onEachFeature: function(f, layer) {
                layer.bindTooltip(f.properties.name, { permanent: true, direction: 'right', offset: [7, 0], className: 'town-label' });
                layer.bindPopup(townPopup(f.properties));   // click pin → name + population
            }
        });
    }

    // Open on the Overview tab by default.
    nswView = 'all';
    refreshOverview();
    showNSW();
    updateTownLabels();
    hideLoader();
})
.catch(err => { console.error('Dashboard load failed:', err); hideLoader(); });
