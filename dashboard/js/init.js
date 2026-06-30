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
    _f('data/nltn_meta.json').catch(() => []),
    _f('data/nsw_evidence.json').catch(() => ({})),
    _f('data/cv_evidence.json').catch(() => ({})),
    _f('data/nltn_evidence.json').catch(() => ({})),
    _f('data/sua_outlines.json').catch(() => []),
    _f('data/nhvr_networks.json').catch(() => ({})),
    _f('data/nsw_road_ext.json').catch(() => ({}))
]).then(([nswRoads, nswTowns, cvRoads, cvStats, cvBoundary, cvTowns, nswRefs, cvRefs, refOv, nswUrb, nswNltn, nswRecat, nswCrit, nltn, nltnMeta, nswEvid, cvEvid, nltnEvid, suaOutlines, nhvr, roadExt]) => {
    // Real heavy-vehicle network membership per road (NHVR spatial intersect): road train (R-03),
    // 19m B-double (R-04) and HV bypass — data/nhvr_networks.json. Plus geometry-derived topology
    // (connects two State Roads; parallels a State Road within 20km) — data/nsw_road_ext.json.
    window.NHVR = nhvr || {};
    window.ROAD_EXT = roadExt || {};
    window.NSW_CRIT = nswCrit || {};   // per-road computed criteria results (data/nsw_criteria.json)
    // Per-road connectivity evidence (which centres / hospitals / ports / airports / intermodals each
    // road connects, with names + qualifying attributes + coords) — data/*_evidence.json.
    // Centres include both town points and Significant Urban Areas (kind:'sua', suaId -> SUA_OUTLINES).
    window.NSW_EVID = nswEvid || {};
    window.CV_EVID = cvEvid || {};
    window.NLTN_EVID = nltnEvid || {};
    // Significant Urban Area boundary outlines (drawn as the "town perimeter" highlight on selection),
    // indexed by suaId — data/sua_outlines.json.
    window.SUA_OUTLINES = suaOutlines || [];
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

    // CV tab stats are computed by refreshCV() (Overview breakdown filtered to the LGA) — see panels.js.

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
    // Clarence Valley LGA boundary polygon(s) + a point-in-polygon test, hoisted so they can both tag
    // roads inside the LGA AND clip road geometry to the LGA outline (for the "inside only" toggle).
    let cvPolys = [];
    let cvInside = function () { return false; };
    (function buildCV() {
        const gb = cvBoundary && cvBoundary.features && cvBoundary.features[0] && cvBoundary.features[0].geometry;
        if (!gb) return;
        cvPolys = gb.type === 'Polygon' ? [gb.coordinates] : gb.type === 'MultiPolygon' ? gb.coordinates : [];
        let bx0 = 180, by0 = 90, bx1 = -180, by1 = -90;
        cvPolys.forEach(poly => poly[0].forEach(p => { if (p[0] < bx0) bx0 = p[0]; if (p[0] > bx1) bx1 = p[0]; if (p[1] < by0) by0 = p[1]; if (p[1] > by1) by1 = p[1]; }));
        cvInside = function (x, y) {
            if (x < bx0 || x > bx1 || y < by0 || y > by1) return false;
            for (const poly of cvPolys) {
                let inP = false;
                for (const ring of poly) {
                    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                        const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
                        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi)) inP = !inP;
                    }
                }
                if (inP) return true;
            }
            return false;
        };
        const coords = g => g.type === 'LineString' ? g.coordinates : g.type === 'MultiLineString' ? [].concat.apply([], g.coordinates) : [];
        nswRoads.features.forEach(f => {
            f.properties._inCV = false;
            for (const pt of coords(f.geometry)) {
                if (cvInside(pt[0], pt[1])) { f.properties._inCV = true; break; }
            }
        });
        // Roll the flag up to the per-road aggregate so the CV tab stats can count roads in the LGA.
        nswRoads.features.forEach(f => { if (f.properties._inCV) { const k = roadKeyOf(f.properties); if (k && nswRoadAgg[k]) nswRoadAgg[k]._inCV = true; } });
    })();
    nswLayer = L.geoJSON(nswRoads, {
        style: nswStyle,
        smoothFactor: 2.5,        // ~17.7k segments — simplify more aggressively so zoom redraws stay smooth
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

    // Clipped CV-inside roads — the same criteria-graded roads, but with their geometry trimmed to the
    // LGA polygon so the "Show only roads inside the LGA" toggle leaves nothing leaking past the black
    // outline. Built once here; shown in place of nswLayer when the clip toggle is on (see applyLegend).
    (function buildCvClip() {
        if (!cvPolys.length) return;
        // t-values where segment a→b crosses any boundary edge (with a bbox cull so this stays fast).
        const cross = function (a, b) {
            const ts = [], ax = a[0], ay = a[1], rx = b[0] - a[0], ry = b[1] - a[1];
            const sx0 = Math.min(ax, b[0]), sx1 = Math.max(ax, b[0]), sy0 = Math.min(ay, b[1]), sy1 = Math.max(ay, b[1]);
            for (const poly of cvPolys) for (const ring of poly) {
                for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                    const c = ring[j], d = ring[i];
                    if (Math.max(c[0], d[0]) < sx0 || Math.min(c[0], d[0]) > sx1 || Math.max(c[1], d[1]) < sy0 || Math.min(c[1], d[1]) > sy1) continue;
                    const ex = d[0] - c[0], ey = d[1] - c[1];
                    const den = rx * ey - ry * ex;
                    if (den === 0) continue;
                    const t = ((c[0] - ax) * ey - (c[1] - ay) * ex) / den;
                    const u = ((c[0] - ax) * ry - (c[1] - ay) * rx) / den;
                    if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
                }
            }
            ts.sort((m, n) => m - n);
            return ts;
        };
        // Return the inside-the-polygon runs of a polyline as an array of coordinate arrays.
        const clipLine = function (cs) {
            const out = []; let cur = null;
            for (let i = 0; i < cs.length - 1; i++) {
                const a = cs[i], b = cs[i + 1], dx = b[0] - a[0], dy = b[1] - a[1];
                const pts = [0].concat(cross(a, b), [1]);
                for (let k = 0; k < pts.length - 1; k++) {
                    const t0 = pts[k], t1 = pts[k + 1];
                    if (t1 - t0 < 1e-12) continue;
                    const mt = (t0 + t1) / 2;
                    const p1 = [a[0] + dx * t1, a[1] + dy * t1];
                    if (cvInside(a[0] + dx * mt, a[1] + dy * mt)) {
                        if (!cur) cur = [[a[0] + dx * t0, a[1] + dy * t0]];
                        cur.push(p1);
                    } else if (cur) { out.push(cur); cur = null; }
                }
            }
            if (cur) out.push(cur);
            return out;
        };
        const feats = [];
        nswRoads.features.forEach(function (f) {
            const p = f.properties;
            if (!p._inCV || isRamp(p)) return;
            const g = f.geometry;
            const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
            const parts = [];
            lines.forEach(cs => clipLine(cs).forEach(s => { if (s.length >= 2) parts.push(s); }));
            if (parts.length) feats.push({ type: 'Feature', properties: p, geometry: { type: 'MultiLineString', coordinates: parts } });
        });
        const cvClipLayers = {};
        cvClipLayer = L.geoJSON({ type: 'FeatureCollection', features: feats }, {
            style: nswStyle,
            smoothFactor: 2.5,
            onEachFeature: function (feature, layer) {
                const k = roadKeyOf(feature.properties);
                if (k) (cvClipLayers[k] || (cvClipLayers[k] = [])).push(layer);
                const group = () => (k && cvClipLayers[k]) ? cvClipLayers[k] : [layer];
                layer.bindTooltip(roadLabel(feature.properties), { sticky: true, direction: 'top', offset: [0, -2], className: 'road-label' });
                layer.on('click', function (e) {
                    L.DomEvent.stopPropagation(e);
                    highlightRoad(group(), cvClipLayer);
                    const agg = (k && nswRoadAgg[k]) ? Object.assign({}, nswRoadAgg[k], { ref: feature.properties.ref, road_name: feature.properties.road_name }) : feature.properties;
                    showRoadDetail(agg, 'nsw');
                });
                layer.on('mouseover', function () { if (!isSelected(layer)) group().forEach(l => l.setStyle({ weight: 5, opacity: 1 })); });
                layer.on('mouseout', function () { if (!isSelected(layer)) group().forEach(l => cvClipLayer.resetStyle(l)); });
            }
        });
    })();

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
            f.properties._natPbs2b = m.pbs2b;      // S-06: true = NHVR PBS 2B Approved Route, false = not, null = unknown
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
        if (a) { f.properties._roadMeets = a.yes > a.no; f.properties._w = weightForKm(a.yes + a.no); }
    });
    cvLayer = L.geoJSON(cvRoads, {
        style: cvStyle,
        smoothFactor: 2.5,   // match the NSW road overlay so the same road renders identically across tabs
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

    // CV Boundary — decorative LGA outline. Must be non-interactive with NO fill, otherwise the
    // canvas renderer (preferCanvas) hit-tests its transparent interior and swallows every road
    // click inside the LGA (the roads sit underneath it in the same canvas).
    cvBoundaryLayer = L.geoJSON(cvBoundary, {
        interactive: false,
        pane: 'cvbPane',
        renderer: cvbRenderer,
        smoothFactor: 2,   // 25k-vertex outline — simplify on render so the SVG stays smooth on pan/zoom
        style: {color: '#000000', weight: 2.5, fill: false, opacity: 0.9, lineJoin: 'round'}
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

    // Fill the static "Highlights" legend blocks (connection-ring toggles).
    const ovh = document.getElementById('ov-hilite-legend'); if (ovh) ovh.innerHTML = hiliteLegendHTML();
    const cvh = document.getElementById('cv-hilite-legend'); if (cvh) cvh.innerHTML = hiliteLegendHTML();
    const dlg = document.getElementById('detail-legend'); if (dlg) dlg.innerHTML = detailLegendHTML();   // legend at the foot of Road Detail

    // Open on the Overview tab by default.
    nswView = 'all';
    refreshOverview();
    refreshCV();   // pre-fill the CV region stats (Overview breakdown within the LGA)
    showNSW();
    updateTownLabels();
    syncLegendVisuals();   // reflect default toggle states across every legend
    hideLoader();
})
.catch(err => { console.error('Dashboard load failed:', err); hideLoader(); });
