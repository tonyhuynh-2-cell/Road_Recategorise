// local.js — Local (council) roads.
//
// Two jobs:
//  1. Street NAMES on the normal road-map tabs, via the basemap: a CARTO "voyager_only_labels" overlay
//     switched on once the displayed ruler reads 2 km or closer (instant, no queries).
//  2. The Local TAB: search a SUBURB → we load that suburb's council/local roads (OpenStreetMap / Overpass)
//     as GREEN vectors, CLIPPED to the suburb boundary so nothing leaks past the outline, with an optional
//     "grade as Regional" cross-test. A suburb is a small, bounded query, so it loads fast and reliably —
//     unlike a whole-viewport fetch (the state has too many local roads to draw at once).

const localLabelsLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 20, pane: 'localPane', opacity: 0.95, attribution: '&copy; OSM &copy; CARTO'
});

const LOCAL_TABS = ['overview', 'state', 'regional', 'sydney', 'cv', 'local'];   // road-map tabs (not Nat.Sig / Detail)

// Street labels show when: the toggle is on, we're on a road-map tab, AND the displayed scale is 2 km or closer.
function localRoadsAllowed() {
    const scaleMetres = typeof displayedScaleMetres === 'function' ? displayedScaleMetres() : null;
    return legendToggles.local && LOCAL_TABS.indexOf(currentTab) !== -1 &&
        scaleMetres !== null && scaleMetres <= TOWN_LABEL_SCALE_METRES;
}

// Add/remove the street-label overlay for the current view. Called by applyLegend and on move/zoom.
function updateLocalRoads() {
    if (localRoadsAllowed()) { if (!map.hasLayer(localLabelsLayer)) map.addLayer(localLabelsLayer); }
    else if (map.hasLayer(localLabelsLayer)) map.removeLayer(localLabelsLayer);
}

map.on('moveend zoomend', updateLocalRoads);

// --- Local tab: a searched SUBURB's council roads as GREEN vectors, clipped to its perimeter ---
// Overpass endpoints are tried in order: the canonical server, then a verified full-data mirror as fallback.
const OVERPASS_URLS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
// Local / council road classes in OSM (residential streets, unclassified, tertiary connectors). We omit
// `service` (driveways / parking aisles) so the count stays meaningful and the query stays fast.
const LOCAL_HW = '^(residential|unclassified|living_street|tertiary|tertiary_link|road)$';
let suburbOutlineLayer = null;             // the searched suburb's perimeter outline
let _subResults = [], _subActive = -1, _subTimer = null, _subAbort = null, _subLoadAbort = null, _subTabStarted = false;

localRoadsXLayer = L.geoJSON(null, { renderer: localRenderer, style: styleLocalX }).addTo(map);
map.removeLayer(localRoadsXLayer);   // shown only on the Local tab

// --- Offline statewide LocalRoad catalogue ----------------------------------------------------
// Best fit includes every operational functionhierarchy=LocalRoad segment from the NSW Transport
// Theme. Geometry is split into 0.25-degree files and fetched only for the current close-scale view;
// the small manifest supplies statewide counts without loading half a million lines into Leaflet.
const STATEWIDE_LOCAL_COLORS = {
    potential_state: '#1d4ed8',
    likely_state: '#1d4ed8',
    potential_regional: '#eab308',
    likely_regional: '#eab308',
    local_available: '#57534e'
};
const STATEWIDE_LOCAL_CHUNKS = {};

function statewideLocalRoadsAtVisibleScale() {
    const scaleMetres = typeof displayedScaleMetres === 'function'
        ? displayedScaleMetres()
        : null;
    return scaleMetres !== null && scaleMetres <= TOWN_LABEL_SCALE_METRES;
}

function statewideLocalStyle(feature) {
    const status = feature && feature.properties ? feature.properties.status : 'local_available';
    const toggle = (status === 'potential_state' || status === 'likely_state') ? 'fstate'
        : (status === 'potential_regional' || status === 'likely_regional') ? 'freg'
        : status === 'local_available' ? 'flocal' : null;
    if (toggle && typeof legendToggles !== 'undefined' && !legendToggles[toggle])
        return { stroke: false, opacity: 0, weight: 0 };
    const provisional = status === 'likely_state' || status === 'likely_regional';
    return { color: STATEWIDE_LOCAL_COLORS[status] || '#57534e', weight: 1.5,
        opacity: status === 'local_available' ? 0.72 : 0.92, lineCap: 'round',
        dashArray: provisional ? '6 5' : null };
}

function statewideLocalPopupHtml(feature) {
    const p = (feature && feature.properties) || {};
    const esc = typeof localEsc === 'function' ? localEsc : String;
    const evidence = [];
    if (p.regional_centres && p.regional_centres.length)
        evidence.push('Regional centres: ' + p.regional_centres.join('; '));
    if (p.state_centres && p.state_centres.length)
        evidence.push('State-tier centres: ' + p.state_centres.join('; '));
    if (p.regional_facilities && p.regional_facilities.length)
        evidence.push('Regional-test facilities: ' + p.regional_facilities.join('; '));
    if (p.state_facilities && p.state_facilities.length)
        evidence.push('State-test facilities: ' + p.state_facilities.join('; '));
    const bdCoverage = typeof p.bdouble_coverage === 'number'
        ? Math.round(p.bdouble_coverage * 100) + '% route coverage'
        : 'coverage unavailable';
    const pbsCoverage = typeof p.pbs1_coverage === 'number'
        ? Math.round(p.pbs1_coverage * 100) + '% route coverage'
        : 'coverage unavailable';
    const bdText = p.bdouble === true ? 'passes' : 'does not pass';
    const pbsText = p.pbs1 === true ? 'passes' : 'does not pass';
    const verdictLabel = function(value) {
        return value === 'green' ? 'meets'
            : value === 'orange' ? 'meets one optional criterion'
            : value === 'insufficient' ? 'insufficient evidence'
            : 'fails criteria';
    };
    return (
        '<strong>' + esc(p.name || 'Unnamed local-road segment') + '</strong>' +
        '<div style="margin-top:4px">' + esc(p.label || 'Local Road on available evidence') + '</div>' +
        '<div style="margin-top:4px;color:#6b625d">' + (+p.length_km || 0).toFixed(2) +
        ' km · official NSW functional hierarchy: LocalRoad</div>' +
        (evidence.length ? '<div style="margin-top:6px">' + esc(evidence.join(' · ')) + '</div>' : '') +
        '<div style="margin-top:6px;color:#6b625d">19 m B-double gate: ' + bdText +
        ' (' + bdCoverage + '). PBS Level 1 gate: ' + pbsText + ' (' + pbsCoverage +
        '). B-double requires at least 80%; PBS Level 1 requires more than 80%. ' +
        'Centre and facility links are tested at separate road terminals.</div>' +
        (p.regional_verdict || p.state_verdict
            ? '<div style="margin-top:6px">Test as Regional: <strong>' +
              verdictLabel(p.regional_verdict) + '</strong> · Test as State: <strong>' +
              verdictLabel(p.state_verdict) + '</strong></div>'
            : '')
    );
}

function statewideLocalRoadClick(e) {
    if (!statewideLocalBestFitActive() || !statewideLocalRoadsAtVisibleScale()) return;
    const point = map.latLngToLayerPoint(e.latlng);
    const clickBox = L.latLngBounds(
        map.layerPointToLatLng(point.subtract([35, 35])),
        map.layerPointToLatLng(point.add([35, 35]))
    );
    let bestLayer = null, bestDistance = Infinity;
    Object.keys(STATEWIDE_LOCAL_CHUNKS).forEach(function (key) {
        const group = STATEWIDE_LOCAL_CHUNKS[key].layer;
        if (!group || !map.hasLayer(group)) return;
        group.eachLayer(function (layer) {
            if (layer.getBounds && !clickBox.intersects(layer.getBounds())) return;
            const latlngs = layer.getLatLngs ? layer.getLatLngs() : [];
            const lines = latlngs.length && Array.isArray(latlngs[0]) ? latlngs : [latlngs];
            lines.forEach(function (line) {
                let previous = line.length ? map.latLngToLayerPoint(line[0]) : null;
                for (let i = 1; i < line.length; i++) {
                    const current = map.latLngToLayerPoint(line[i]);
                    const distance = L.LineUtil.pointToSegmentDistance(point, previous, current);
                    if (distance < bestDistance) { bestDistance = distance; bestLayer = layer; }
                    previous = current;
                }
            });
        });
    });
    if (!bestLayer || bestDistance > 10) return;
    L.popup({ autoPanPaddingTopLeft: [24, 110], autoPanPaddingBottomRight: [24, 24] })
        .setLatLng(e.latlng).setContent(statewideLocalPopupHtml(bestLayer.feature)).openOn(map);
}
map.on('click', statewideLocalRoadClick);

function statewideLocalWantedKeys() {
    const meta = window.LOCAL_ROAD_MANIFEST;
    if (!meta || !meta.geometry || !statewideLocalRoadsAtVisibleScale()) return [];
    const step = +meta.geometry.chunk_degrees || 0.25;
    const allowed = window._STATEWIDE_LOCAL_KEYSET ||
        (window._STATEWIDE_LOCAL_KEYSET = new Set(meta.geometry.chunks || []));
    const bounds = map.getBounds().pad(0.2);
    const keys = [];
    const x0 = Math.floor(bounds.getWest() / step), x1 = Math.floor(bounds.getEast() / step);
    const y0 = Math.floor(bounds.getSouth() / step), y1 = Math.floor(bounds.getNorth() / step);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const key = x + '_' + y;
        if (allowed.has(key)) keys.push(key);
    }
    return keys;
}

function removeStatewideLocalChunks(except) {
    const keep = new Set(except || []);
    Object.keys(STATEWIDE_LOCAL_CHUNKS).forEach(function (key) {
        const entry = STATEWIDE_LOCAL_CHUNKS[key];
        if (!keep.has(key) && entry.layer && map.hasLayer(entry.layer)) map.removeLayer(entry.layer);
    });
}

function fetchGzipJson(url) {
    return fetch(url).then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        if (typeof DecompressionStream === 'undefined')
            throw new Error('This browser cannot decompress the local-road map chunks');
        return response.body.pipeThrough(new DecompressionStream('gzip'));
    }).then(function (stream) {
        return new Response(stream).json();
    });
}

function updateStatewideLocalRoads() {
    const active = statewideLocalBestFitActive() && !!window.LOCAL_ROAD_MANIFEST;
    const keys = active ? statewideLocalWantedKeys() : [];
    removeStatewideLocalChunks(keys);
    if (!active || !keys.length) return;
    const directory = window.LOCAL_ROAD_MANIFEST.geometry.directory || 'data/local_road_chunks';
    keys.forEach(function (key) {
        const cached = STATEWIDE_LOCAL_CHUNKS[key];
        if (cached && cached.layer) {
            cached.layer.setStyle(statewideLocalStyle);
            if (!map.hasLayer(cached.layer)) map.addLayer(cached.layer);
            return;
        }
        if (cached && cached.loading) return;
        STATEWIDE_LOCAL_CHUNKS[key] = { loading: true, layer: null };
        fetchGzipJson(directory + '/' + key + '.geojson.gz?v=' + Date.now())
            .then(function (geojson) {
                const layer = L.geoJSON(geojson, {
                    renderer: localRenderer,
                    style: statewideLocalStyle,
                    interactive: true,
                    onEachFeature: function (feature, roadLayer) {
                        roadLayer.bindPopup(statewideLocalPopupHtml(feature), {
                            autoPanPaddingTopLeft: [24, 110],
                            autoPanPaddingBottomRight: [24, 24]
                        });
                    }
                });
                STATEWIDE_LOCAL_CHUNKS[key] = { loading: false, layer: layer };
                if (statewideLocalBestFitActive() && statewideLocalWantedKeys().indexOf(key) !== -1)
                    map.addLayer(layer);
            })
            .catch(function () { delete STATEWIDE_LOCAL_CHUNKS[key]; });
    });
}

// Best fit can be opened statewide or through an Area focus. In both cases its sourced LocalRoad
// candidates are part of the assessment and should be drawn at the normal zoom-gated scale.
function statewideLocalBestFitActive() {
    return currentTab === 'fresh' ||
        ((currentTab === 'cv' || currentTab === 'sydney') && nswView === 'fresh');
}
map.on('moveend zoomend resize', updateStatewideLocalRoads);

// Local road selection. Per-feature canvas hit-testing on these thin lines is unreliable when the graded
// road layer is swapped off the shared canvas, so we find the nearest local road to the click ourselves
// and open its popup. Only active on the Local tab; on any other tab it returns immediately.
function localRoadClickHandler(e) {
    if (currentTab !== 'local' || !localRoadsXLayer) return;
    const layers = localRoadsXLayer.getLayers(); if (!layers.length) return;
    const p = map.latLngToLayerPoint(e.latlng);
    // Cull to roads whose (cached) bounds fall near the click before projecting their vertices — a dense
    // suburb can hold thousands of segments, and projecting every vertex of every road on each click is the
    // cost. The 40px margin is well beyond the 10px hit threshold below, so a road that could be selected
    // (some point within 10px) always has bounds inside this box and is never culled — same result, less work.
    const clickBox = L.latLngBounds(map.layerPointToLatLng(p.subtract([40, 40])), map.layerPointToLatLng(p.add([40, 40])));
    let bestFeat = null, bestD = Infinity;
    for (let n = 0; n < layers.length; n++) {
        const lyr = layers[n];
        if (lyr.getBounds && !clickBox.intersects(lyr.getBounds())) continue;   // whole road is far from the click
        const lls0 = lyr.getLatLngs(); if (!lls0 || !lls0.length) continue;
        const segs = Array.isArray(lls0[0]) ? lls0 : [lls0];   // LineString → wrap; MultiLineString → as-is
        for (let s = 0; s < segs.length; s++) {
            const seg = segs[s];
            let prev = seg.length ? map.latLngToLayerPoint(seg[0]) : null;   // project each vertex once, reuse
            for (let i = 1; i < seg.length; i++) {
                const cur = map.latLngToLayerPoint(seg[i]);
                const d = L.LineUtil.pointToSegmentDistance(p, prev, cur);
                if (d < bestD) { bestD = d; bestFeat = lyr.feature; }
                prev = cur;
            }
        }
    }
    if (!bestFeat || bestD > 10) return;   // clicked empty space — leave it for the map's deselect
    const nm = (bestFeat.properties && bestFeat.properties.name) || 'Local road';
    if (typeof traceCode === 'function') traceCode(
        'Local road clicked: ' + nm,
        'Local road lines use a custom nearest-road click test. The app finds the closest loaded local road to the click and opens its per-road assessment.',
        "function localRoadClickHandler(e) {\n  const p = map.latLngToLayerPoint(e.latlng);\n  // scan loaded local-road segments near the click\n  if (bestFeat && bestD <= 10) {\n    openLocalRoad(bestFeat.properties._lgid);\n  }\n}",
        'nearest distance=' + bestD.toFixed(1) + 'px'
    );
    // Open the SAME per-road assessment the list rows open (one shared path) — the map's deselect
    // has already run (it was registered first), so the highlight set here sticks.
    const gid = bestFeat.properties ? bestFeat.properties._lgid : null;
    if (gid != null && LOCAL_GROUPS[gid]) openLocalRoad(gid);
}
map.on('click', localRoadClickHandler);

// Colour a local-road feature by its ROAD's verdict under the active cross-test mode (false =
// own criteria = plain green). Verdicts are graded per road group (gradeLocalGroup) so the map,
// the list chips and the per-road detail can never disagree about one road.
function styleLocalX(f) {
    const mode = xLens.local;
    if (!mode) return { color: '#16a34a', weight: 1.5, opacity: 0.9, lineCap: 'round' };
    const g = f.properties ? LOCAL_GROUPS[f.properties._lgid] : null;
    const v = g ? gradeLocalGroup(g, mode).v : 'red';
    return { color: ROAD_COLORS[v] || '#9a938c', weight: 1.5, opacity: v === 'red' ? 0.7 : 0.95, lineCap: 'round' };
}

// --- Local cross-tests (Regional / State), connectivity-only and INDICATIVE -------------------
// Neither mandatory gate (19m B-double for Regional, PBS-1 for State) is published for council
// roads, so both tests grade the connectivity criteria alone — flagged as indicative in the panel.
// BOTH tests use the standard "must meet ≥2 optional" rule (the same rule the real criteria
// engine applies to every State/Regional road):
//   (a) connects ≥2 DISTINCT named town/urban centres within ~1.2 km (R-01/R-05 for the Regional
//       test; S-07/S-10 with State-tier centres only for the State test). Centres are the towns
//       dataset PLUS the SUA centroids, de-duplicated by name tokens — 'Grafton' the town and
//       'Grafton' the Significant Urban Area are ONE centre, and a compound SUA ('Albury -
//       Wodonga') never re-counts a town it already contains;
//   (b) connects ≥1 major facility — hospital / port / airport / intermodal / an employment
//       centre meeting the client-approved Urban ≥40 ha size-only rule TO a qualifying centre
//       (R-02/R-06 / S-08/S-11). A nearby facility by itself is not a connection criterion.
// ≥2 met → green, 1 → orange, 0 → red. Verdicts are earned from the data, never forced.

// NAMED centre points for the Regional test = every town PLUS the SUA centroids. Built once.
function xtCentrePts() {
    if (window._XT_CENTRES) return window._XT_CENTRES;
    const pts = [], names = [];
    (window.NSW_TOWNS_NAMED || []).forEach(function (t) { pts.push(t.pt); names.push(t.name); });
    (window.SUA_OUTLINES || []).forEach(function (s) { if (s && s.centroid) { pts.push(s.centroid); names.push(s.name || 'Urban area'); } });
    window._XT_CENTRES = { pts: pts, names: names };
    return window._XT_CENTRES;
}
// State-tier centre points: Regional Cities + Major Towns only, plus the Significant Urban Area
// centroids (major urban centres) — S-07/S-10's centre classes.
function xtStateCentrePts() {
    if (window._XT_CENTRES_STATE) return window._XT_CENTRES_STATE;
    const pts = [], names = [];
    (window.NSW_TOWNS_NAMED || []).forEach(function (t) {
        if (t.type === 'Regional City' || t.type === 'Major Town') { pts.push(t.pt); names.push(t.name); }
    });
    (window.SUA_OUTLINES || []).forEach(function (s) { if (s && s.centroid) { pts.push(s.centroid); names.push(s.name || 'Urban area'); } });
    window._XT_CENTRES_STATE = { pts: pts, names: names };
    return window._XT_CENTRES_STATE;
}
// Major facilities for the State test: the union of every named hospital / port / airport /
// intermodal / employment centre meeting the client-approved Urban ≥40 ha size-only rule in the
// statewide assessment evidence
// (data/nsw_evidence.json — the same evidence the road criteria grade against). Built once.
function xtFacilityPts() {
    if (window._XT_FACILITIES) return window._XT_FACILITIES;
    const pts = [], names = [], seen = {};
    const add = function (e, label) {
        if (!e || e.lon == null || e.lat == null) return;
        const id = (e.name || '?') + '|' + (+e.lat).toFixed(3) + '|' + (+e.lon).toFixed(3);
        if (seen[id]) return;
        seen[id] = 1;
        pts.push([+e.lon, +e.lat]);
        names.push((e.name || 'Facility') + (label ? ' (' + label + ')' : ''));
    };
    const ev = window.NSW_EVID || {};
    for (const k in ev) {
        const e = ev[k];
        (e.hospitals || []).forEach(function (x) { add(x, 'hospital'); });
        (e.dests || []).forEach(function (x) { add(x, x.ftype || 'port/airport'); });
        (e.employment || []).forEach(function (x) { if ((+x.ha || 0) >= 40) add(x, 'employment ≥40 ha'); });
    }
    window._XT_FACILITIES = { pts: pts, names: names };
    return window._XT_FACILITIES;
}

// Indices of `pts` ([lon,lat]) within R km of any vertex of any geometry in `geoms`
// (equirectangular — the same maths the original Regional test used).
function _nearPtIdx(geoms, pts, R) {
    const near = {};
    if (!pts.length) return [];
    for (const g of geoms) {
        const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
        for (const cs of lines) for (const v of cs) {
            const lon = v[0], lat = v[1], cosl = Math.cos(lat * Math.PI / 180);
            for (let i = 0; i < pts.length; i++) {
                if (near[i]) continue;
                const dLat = (pts[i][1] - lat) * 111.32, dLon = (pts[i][0] - lon) * 111.32 * cosl;
                if (dLat * dLat + dLon * dLon <= R * R) near[i] = 1;
            }
        }
    }
    return Object.keys(near);
}

// Grade one local ROAD (group of ways/parts) against a cross-test mode; cached per mode on the
// group, cleared whenever a new suburb loads (buildLocalGroups resets the objects).
// Both modes grade the SAME two-criteria ≥2-optional rule; only the centre tier differs.
function gradeLocalGroup(g, mode) {
    if (g.v[mode]) return g.v[mode];
    const geoms = g.feats.map(function (f) { return f.geometry; });
    const cen = mode === 'state' ? xtStateCentrePts() : xtCentrePts();
    const cIdx = _nearPtIdx(geoms, cen.pts, 1.2);
    // DISTINCT centres by name tokens: 'Grafton' the town + 'Grafton' the SUA centroid is one
    // centre, and a compound SUA ('Albury - Wodonga') never re-counts a town it contains.
    const seen = {}, centreNames = [];
    cIdx.forEach(function (i) {
        const toks = String(cen.names[i]).toLowerCase().split(/\s+[-–]\s+/);
        if (toks.some(function (t) { return seen[t]; })) return;
        toks.forEach(function (t) { seen[t] = 1; });
        centreNames.push(cen.names[i]);
    });
    const fac = xtFacilityPts();
    const fIdx = _nearPtIdx(geoms, fac.pts, 1.2);
    // The published facility criteria require a facility/employment destination to be connected
    // TO a qualifying centre. Do not award this criterion merely because a facility is nearby.
    // This indicative browser test uses both endpoint types being near the grouped road as the
    // available connection evidence; the statewide pipeline uses physical-network connectivity.
    const facilityConnection = fIdx.length > 0 && centreNames.length > 0;
    const met = (centreNames.length >= 2 ? 1 : 0) + (facilityConnection ? 1 : 0);
    const res = { v: met >= 2 ? 'green' : met === 1 ? 'orange' : 'red',
                  centres: centreNames.length, centreNames: centreNames.slice(0, 4),
                  nFac: fIdx.length, facNames: fIdx.slice(0, 4).map(function (i) { return fac.names[i]; }),
                  facilityConnection: facilityConnection };
    g.v[mode] = res;
    return res;
}

// --- Clip roads to the suburb polygon so they don't leak past the perimeter ---
// Extract all linear rings from a GeoJSON Polygon / MultiPolygon (outer + holes, flattened).
function geojsonRings(gj) {
    if (!gj) return [];
    if (gj.type === 'Polygon') return gj.coordinates;
    if (gj.type === 'MultiPolygon') { const r = []; gj.coordinates.forEach(function (poly) { poly.forEach(function (ring) { r.push(ring); }); }); return r; }
    return [];
}
// Ray-cast point-in-polygon (even-odd across all rings — suburb multipolygons are disjoint islands + holes).
function ringsContain(rings, lon, lat) {
    let inside = false;
    for (let r = 0; r < rings.length; r++) {
        const ring = rings[r];
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
            if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
        }
    }
    return inside;
}
// Split a way's coordinates into the runs that are INSIDE the polygon (each ≥2 pts). Crossing segments are
// cut at the last inside vertex — roads stop just inside the boundary rather than leaking past it.
function clipCoordsToRings(coords, rings) {
    const out = []; let cur = [];
    for (let i = 0; i < coords.length; i++) {
        if (ringsContain(rings, coords[i][0], coords[i][1])) cur.push(coords[i]);
        else { if (cur.length >= 2) out.push(cur); cur = []; }
    }
    if (cur.length >= 2) out.push(cur);
    return out;
}

// Overpass `out geom` → GeoJSON FeatureCollection, clipped to `rings` (if given). Returns the collection
// plus the count of source ways that kept at least one segment (so the tally isn't inflated by splitting).
// Every part of one way SHARES its props object (`_way` identifies the way), so buildLocalGroups can
// re-assemble ways — and same-named ways — into whole roads afterwards.
function overpassToClippedGeojson(data, rings) {
    const feats = []; let roads = 0;
    ((data && data.elements) || []).forEach(function (el, idx) {
        if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) return;
        const coords = el.geometry.map(function (pt) { return [pt.lon, pt.lat]; });
        const props = { name: (el.tags && el.tags.name) || '', hw: (el.tags && el.tags.highway) || '', _way: idx };
        const parts = (rings && rings.length) ? clipCoordsToRings(coords, rings) : [coords];
        if (parts.length) roads++;
        parts.forEach(function (p) { feats.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: p } }); });
    });
    return { fc: { type: 'FeatureCollection', features: feats }, roads: roads };
}

// Tab sync (called by applyLegend): show the loaded suburb roads on the Local tab, hide them elsewhere.
// Loading is search-driven — panning does NOT fetch — and the last result persists across tab switches.
function updateLocalX() {
    if (currentTab !== 'local') {
        if (localRoadsXLayer && map.hasLayer(localRoadsXLayer)) map.removeLayer(localRoadsXLayer);
        if (suburbOutlineLayer && map.hasLayer(suburbOutlineLayer)) map.removeLayer(suburbOutlineLayer);
        hideSuburbResults();
        return;
    }
    if (localRoadsXLayer && !map.hasLayer(localRoadsXLayer)) map.addLayer(localRoadsXLayer);
    if (suburbOutlineLayer && !map.hasLayer(suburbOutlineLayer)) map.addLayer(suburbOutlineLayer);
    if (!localRoadsXLayer.getLayers().length) setLocalXStatus('Search a suburb to load its local roads');
}

// POST an Overpass query to the endpoints in turn, resolving with the first JSON that parses. A 200 that
// isn't JSON (e.g. a rate-limit HTML page) throws and falls through to the next endpoint too.
function overpassFetch(q, signal) {
    const body = 'data=' + encodeURIComponent(q);
    let i = 0;
    function attempt() {
        const url = OVERPASS_URLS[i++];
        const opts = { method: 'POST', body: body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } };
        if (signal) opts.signal = signal;
        // Cap each endpoint at 18s so a hung/slow primary doesn't block the fallback (the leaked fetch is harmless).
        const race = Promise.race([
            fetch(url, opts).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
            new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, 18000); })
        ]);
        return race.catch(function (err) {
            if (err && err.name === 'AbortError') throw err;    // user moved on — stop, don't try the next one
            if (i < OVERPASS_URLS.length) return attempt();     // primary busy/failed/slow — try the mirror
            throw err;
        });
    }
    return attempt();
}

function setLocalXStatus(msg) { const el = document.getElementById('local-status'); if (el) el.textContent = msg; }
function setLocalTotal(n) { const el = document.getElementById('local-total'); if (el) el.textContent = (n === null || n === undefined) ? '—' : n.toLocaleString(); }

// --- Determinate loading bar: a constant-speed linear fill 0→100%, like the page-load bar (ipwea-fill).
// Overpass gives no progress events, so the bar ramps at a steady rate toward ~92% over the estimated load
// time (so it reads as real progression, not a stalled "loading"), then snaps to 100% on completion. ---
let _progVal = 0, _progTimer = null;
const PROG_EST_MS = 12000;   // estimated load time the steady ramp is paced against
function progSet(v) { _progVal = Math.max(0, Math.min(100, v)); const b = document.getElementById('local-progress-bar'); if (b) b.style.width = _progVal + '%'; }
function progStart() {
    clearInterval(_progTimer);
    const el = document.getElementById('local-progress'); if (el) el.hidden = false;
    progSet(0);
    const tick = 120, step = 92 / (PROG_EST_MS / tick);   // steady, constant-speed fill toward ~92%
    _progTimer = setInterval(function () { progSet(_progVal < 92 ? _progVal + step : 92); }, tick);
}
function progDone() { clearInterval(_progTimer); progSet(100); if (typeof hideMapRefresh === 'function') hideMapRefresh(); setTimeout(function () { const el = document.getElementById('local-progress'); if (el) el.hidden = true; progSet(0); }, 400); }
function progFail() { clearInterval(_progTimer); const el = document.getElementById('local-progress'); if (el) el.hidden = true; progSet(0); if (typeof hideMapRefresh === 'function') hideMapRefresh(); }

// --- Suburb search with a typeahead dropdown (Nominatim). Autocomplete is kept LIGHT (no geometry); the
// boundary polygon is fetched only when a suggestion is picked (one lookup), then used to clip the roads. ---
function suburbLabel(g) { return (g && (g.name || (g.display_name || '').split(',')[0])) || 'the suburb'; }
function subEsc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// Keep the Local-tab search STRICTLY to residential suburbs. The bundled list is a postcode dataset, so it
// also carries non-suburb localities: postal delivery / business centres (a "<Suburb> Dc / Bc / Po / Msc"
// suffix), airports, universities, hospitals, military bases (Hmas… / …Raaf), the Sydney CBD/region name and
// a stray shopping centre. isNonSuburb() drops those. The suffix patterns are END-ANCHORED so they never hit
// real suburbs (Purfleet, Depot Beach, Cams/Nords Wharf, Port Kembla, Len Waters Estate, Megan, Megalong,
// Shellharbour City Centre, Sydney Olympic Park, North Sydney… all kept).
const NON_SUBURB_SUFFIX = / (dc|bc|po|msc|raaf)$/;                     // postal delivery / business-centre suffix
const NON_SUBURB_WORD = /\b(airport|universit(?:y|ies)|hospital)\b/;   // named facilities, never a suburb
const NON_SUBURB_EXACT = { 'sydney': 1, 'sydney south': 1, 'macquarie centre': 1 };
function isNonSuburb(name) {
    const n = String(name || '').toLowerCase();
    return !!NON_SUBURB_EXACT[n] || n.indexOf('hmas ') === 0 || NON_SUBURB_SUFFIX.test(n) || NON_SUBURB_WORD.test(n);
}

// Sydney CBD access. The core CBD is a real ~2.4 x 2.6 km suburb (OSM relation 5729534) — but a text search
// for "Sydney" geocodes to the 100 km Greater Sydney region and postcode 2000 is only a point, so we resolve
// the CBD by its exact OSM id (pickSuburb uses the /lookup endpoint for entries with an osmId). Town Hall /
// Wynyard / Martin Place / Circular Quay are train STATIONS (points) inside this suburb — not areas of their
// own — so they all map here; searching any of them, or "CBD" / "City" / "Sydney", offers the CBD to load.
const CBD_ENTRY = { name: 'Sydney CBD', postcode: '2000', osmId: 'R5729534', meta: 'Town Hall · Wynyard · Martin Place · CBD' };
const CBD_TERMS = ['sydney cbd', 'sydney city', 'cbd', 'city', 'town hall', 'townhall', 'wynyard', 'martin place', 'circular quay', 'chinatown'];

function onSuburbInput(val) {
    const q = String(val || '').trim().toLowerCase();
    if (q.length < 2) { hideSuburbResults(); return; }
    const scored = [];
    // Sydney CBD alias — surfaced first when the query matches the CBD, one of its precinct names, or "CBD".
    let cbd = -1;
    for (let t = 0; t < CBD_TERMS.length; t++) {
        const term = CBD_TERMS[t];
        if (term === q) { cbd = 106; break; }
        else if (term.indexOf(q) === 0) cbd = Math.max(cbd, 96);
        else if (term.indexOf(q) !== -1) cbd = Math.max(cbd, 66);
    }
    if (cbd >= 0) scored.push([cbd, Object.assign({}, CBD_ENTRY)]);
    // Instant prefix / substring match over the bundled NSW suburb list (Cabra → Cabramatta, Cabramatta West…).
    const list = window.NSW_SUBURBS || [];
    for (let i = 0; i < list.length; i++) {
        const nml = list[i][0].toLowerCase();
        if (isNonSuburb(nml)) continue;   // STRICTLY suburbs — drop DCs, airports, universities, bases, etc.
        let s = -1;
        if (nml === q) s = 100;
        else if (nml.indexOf(q) === 0) s = 90;          // starts with the query
        else if (nml.indexOf(' ' + q) !== -1) s = 70;   // a later word starts with it
        else if (nml.indexOf(q) !== -1) s = 55;         // substring
        if (s >= 0) scored.push([s, { name: list[i][0], postcode: list[i][1] }]);
    }
    scored.sort(function (a, b) { return b[0] - a[0] || String(a[1].name).localeCompare(String(b[1].name)); });
    _subResults = scored.slice(0, 40).map(function (x) { return x[1]; });
    renderSuburbResults(_subResults);
}

// Keep only suburb / locality places in the dropdown — drop streets (class=highway), POIs, buildings, etc.
function isSuburbResult(g) {
    if (!g) return false;
    const PLACE = ['suburb', 'neighbourhood', 'quarter', 'town', 'village', 'hamlet', 'locality', 'city'];
    if (g.class === 'place' && PLACE.indexOf(g.type) !== -1) return true;
    if (PLACE.indexOf(g.addresstype) !== -1) return true;   // e.g. a suburb held as an admin boundary
    return false;
}

function renderSuburbResults(arr) {
    _subActive = arr.length ? 0 : -1;
    _subTabStarted = false;   // new result list — Tab restarts from the top option
    const box = document.getElementById('sub-results');
    if (!box) return;
    if (!arr.length) { box.innerHTML = '<div class="sub-empty">No matching suburb in NSW</div>'; box.classList.add('sub-open'); return; }
    box.innerHTML = arr.map(function (s, i) {
        return '<div class="sub-item' + (i === 0 ? ' sub-on' : '') + '" data-i="' + i + '"' +
            ' onmousedown="event.preventDefault(); pickSuburb(' + i + ')" onmouseenter="subSetActive(' + i + ')">' +
            '<div class="sub-name">' + subEsc(s.name) + '</div><div class="sub-meta">' + subEsc(s.meta || ((s.postcode || '') + ' · NSW')) + '</div></div>';
    }).join('');
    box.classList.add('sub-open');
}

function subSetActive(i) {
    _subActive = i;
    const items = document.querySelectorAll('#sub-results .sub-item');
    items.forEach(function (el, k) { el.classList.toggle('sub-on', k === i); });
    if (items[i]) items[i].scrollIntoView({ block: 'nearest' });
}
function hideSuburbResults() { const b = document.getElementById('sub-results'); if (b) b.classList.remove('sub-open'); }

function onSuburbKey(ev) {
    const n = _subResults.length;
    if (ev.key === 'Escape') { hideSuburbResults(); return; }
    if (!n) return;
    const box = document.getElementById('sub-results');
    const open = !!(box && box.classList.contains('sub-open'));
    if (ev.key === 'ArrowDown') { ev.preventDefault(); subSetActive((_subActive + 1) % n); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); subSetActive((_subActive - 1 + n) % n); }
    else if (ev.key === 'Tab' && open) {
        // Tab cycles the highlighted suburb (1st, 2nd, 3rd… wrapping) and previews it in the input; Shift+Tab
        // steps back. First Tab commits to the currently-highlighted (top) option; Enter / Load then loads it.
        ev.preventDefault();
        let idx;
        if (ev.shiftKey) idx = (_subActive - 1 + n) % n;
        else if (_subTabStarted) idx = (_subActive + 1) % n;
        else idx = (_subActive < 0 ? 0 : _subActive);
        _subTabStarted = true;
        subSetActive(idx);
        const inp = document.getElementById('local-suburb-input');
        if (inp && _subResults[idx]) inp.value = _subResults[idx].name;
    }
    else if (ev.key === 'Enter') { ev.preventDefault(); if (_subActive >= 0) pickSuburb(_subActive); }
}
function onSuburbSubmit() {
    if (_subActive >= 0 && _subResults[_subActive]) pickSuburb(_subActive);
    else if (_subResults.length) pickSuburb(0);
    return false;
}

// Pick a suburb → geocode it (Nominatim, exact name + postcode) for the boundary polygon → load + clip roads.
function pickSuburb(i) {
    const s = _subResults[i]; if (!s) return;
    if (typeof traceCode === 'function') traceCode(
        'Suburb selected: ' + s.name,
        'The Local tab first resolves the suburb boundary, then loads OpenStreetMap local roads inside that boundary.',
        "function pickSuburb(i) {\n  const s = _subResults[i];\n  fetch(Nominatim boundary for s.name)\n    .then(loadSuburbResult);\n}",
        'postcode=' + (s.postcode || 'n/a')
    );
    hideSuburbResults();
    const inp = document.getElementById('local-suburb-input'); if (inp) { inp.value = s.name; inp.blur(); }
    progStart();
    // Revamp: top-centre pill for the whole geocode + Overpass load; progDone/progFail clear it.
    if (typeof showMapRefresh === 'function') showMapRefresh('Loading local roads — ' + s.name + '…');
    setLocalXStatus('Finding ' + s.name + '…');
    // Sydney CBD (osmId) resolves to that exact OSM boundary via /lookup — a text search for "Sydney" returns
    // the 100 km Greater Sydney region, not the CBD suburb, so we pin the id instead.
    if (s.osmId) {
        fetch('https://nominatim.openstreetmap.org/lookup?format=jsonv2&polygon_geojson=1&osm_ids=' + encodeURIComponent(s.osmId))
            .then(function (r) { return r.json(); })
            .then(function (arr) {
                arr = Array.isArray(arr) ? arr : [];
                const g = arr.find(hasPolygon) || arr[0];
                if (!g) { progFail(); setLocalXStatus('Could not locate ' + s.name); return; }
                loadSuburbResult(g);
            })
            .catch(function () { progFail(); setLocalXStatus('Search failed — try again'); });
        return;
    }
    // Only ever accept a suburb / locality result — NEVER a POI. Some bundled postcodes are PO-box codes that
    // don't map to the suburb (e.g. North Sydney is listed under 2055, not 2060); a search with the wrong
    // postcode then fuzzy-matches to random commercial/industrial polygons (Honda Rider Training…). So we keep
    // only place results, and if the postcode query finds no suburb we retry name-only (which resolves cleanly).
    const base = 'https://nominatim.openstreetmap.org/search?format=jsonv2&polygon_geojson=1&limit=8&countrycodes=au&q=';
    const pickSub = function (arr) {
        arr = Array.isArray(arr) ? arr : [];
        return arr.filter(isSuburbResult).find(hasPolygon) || arr.filter(isSuburbResult)[0] || null;
    };
    fetch(base + encodeURIComponent(s.name + ', New South Wales ' + (s.postcode || '') + ', Australia'))
        .then(function (r) { return r.json(); })
        .then(function (arr) {
            const g = pickSub(arr);
            if (g) { loadSuburbResult(g); return null; }
            // No suburb match with the (possibly PO-box) postcode — retry without it.
            return fetch(base + encodeURIComponent(s.name + ', New South Wales, Australia'))
                .then(function (r) { return r.json(); })
                .then(function (arr2) {
                    const g2 = pickSub(arr2);
                    if (g2) loadSuburbResult(g2);
                    else { progFail(); setLocalXStatus('Could not locate ' + s.name); }
                });
        })
        .catch(function () { progFail(); setLocalXStatus('Search failed — try again'); });
}
function hasPolygon(g) { return g && g.geojson && (g.geojson.type === 'Polygon' || g.geojson.type === 'MultiPolygon'); }

// Load a suburb: frame it (zoom IN), outline its perimeter, fetch its local roads, clip to the polygon, draw.
function loadSuburbResult(g) {
    if (typeof traceCode === 'function') traceCode(
        'Load local roads: ' + suburbLabel(g),
        'After the suburb boundary is found, the app builds an Overpass query, fetches local-road ways, clips them to the suburb polygon, then draws them.',
        "function loadSuburbResult(g) {\n  const rings = geojsonRings(g.geojson);\n  const q = '[out:json];way[\"highway\"~LOCAL_HW](bbox);out geom;';\n  overpassFetch(q).then(data => {\n    const res = overpassToClippedGeojson(data, rings);\n    localRoadsXLayer.clearLayers();\n    localRoadsXLayer.addData(res.fc);\n  });\n}",
        'boundary source: Nominatim, road source: Overpass/OpenStreetMap'
    );
    const bb = g.boundingbox;   // [south, north, west, east] (strings)
    if (!bb) { progFail(); setLocalXStatus('That place has no area — try another'); return; }
    const rings = geojsonRings(g.geojson);
    drawSuburbOutline(g.geojson);
    setLocalXStatus('Loading local roads in ' + suburbLabel(g) + '…');
    // Frame the suburb — zoom IN (maxZoom caps it; never zooms further out than the suburb itself).
    try { map.fitBounds([[+bb[0], +bb[2]], [+bb[1], +bb[3]]], { maxZoom: 16, padding: [15, 15] }); } catch (e) {}
    const q = '[out:json][timeout:60];way["highway"~"' + LOCAL_HW + '"](' +
        (+bb[0]).toFixed(5) + ',' + (+bb[2]).toFixed(5) + ',' + (+bb[1]).toFixed(5) + ',' + (+bb[3]).toFixed(5) + ');out geom;';
    if (_subLoadAbort) { try { _subLoadAbort.abort(); } catch (e) {} }
    _subLoadAbort = ('AbortController' in window) ? new AbortController() : null;
    overpassFetch(q, _subLoadAbort ? _subLoadAbort.signal : null)
        .then(function (data) {
            if (currentTab !== 'local') { progFail(); return; }
            const res = overpassToClippedGeojson(data, rings);
            localRoadsXLayer.clearLayers();
            if (!map.hasLayer(localRoadsXLayer)) map.addLayer(localRoadsXLayer);
            closeLocalRoad();   // a previous suburb's open per-road detail would now be stale
            if (res.fc.features.length) {
                localRoadsXLayer.addData(res.fc);
                buildLocalGroups(suburbLabel(g));
                setLocalTotal(LOCAL_GROUPS.length);
                const sub = document.getElementById('local-total-sub');
                if (sub) sub.textContent = 'Council-managed local roads in ' + suburbLabel(g) + ' (OpenStreetMap)';
                setLocalXStatus(LOCAL_GROUPS.length.toLocaleString() + ' local roads in ' + suburbLabel(g));
                if (xLens.local) localRoadsXLayer.setStyle(styleLocalX);   // fresh groups → fresh verdict colours
            } else {
                buildLocalGroups(suburbLabel(g));
                setLocalTotal(0);
                setLocalXStatus('No local roads found in ' + suburbLabel(g));
            }
            renderLocalList();
            updateLocalXtStatus();
            progDone();
        })
        .catch(function (err) {
            if (err && err.name === 'AbortError') return;
            progFail();
            setLocalXStatus('Load failed — try again');
        });
}

// Draw the searched suburb's boundary as a dashed outline (its perimeter). Polygon geometry only — if
// Nominatim has no polygon for the place, we skip the outline (and load unclipped by bbox).
function drawSuburbOutline(gj) {
    if (suburbOutlineLayer) { map.removeLayer(suburbOutlineLayer); suburbOutlineLayer = null; }
    if (!gj || (gj.type !== 'Polygon' && gj.type !== 'MultiPolygon')) return;
    // renderer: cvbRenderer is REQUIRED — without it, `pane: 'cvbPane'` makes Leaflet spin up a CANVAS in
    // that pane that spans the map and swallows clicks to the graded roads below (breaking State/Regional/
    // Overview selection). The SVG cvbRenderer (same as the Sydney/CV outlines) lets clicks pass through.
    suburbOutlineLayer = L.geoJSON(gj, { pane: 'cvbPane', renderer: cvbRenderer, interactive: false,
        style: { color: '#000000', weight: 5.25, opacity: 1, fill: false, dashArray: '4 4' } }).addTo(map);
}

// --- Per-road list + detail (Local tab) --------------------------------------------------------
// The loaded ways are re-assembled into ROADS: parts of one way share a props object (_way), and
// same-named ways merge into one road — so 'Kent Street' is one row/verdict, not ten segments.
// Unnamed ways stay individual. LOCAL_GROUPS is the single source the list, the map colours, the
// per-road detail, the xt status line and the Excel export all read from.
let LOCAL_GROUPS = [];      // [{ id, name, hw, lenKm, feats, layers, v: {regional, state} }]
let LOCAL_SUBURB = '';      // display name of the loaded suburb
let _localOpenId = null;    // group id of the open per-road detail (null = list view)

function buildLocalGroups(suburbName) {
    LOCAL_GROUPS = [];
    LOCAL_SUBURB = suburbName || '';
    _localOpenId = null;
    const byKey = {};
    localRoadsXLayer.eachLayer(function (lyr) {
        const f = lyr.feature; if (!f || !f.properties) return;
        const pr = f.properties;
        const key = pr.name ? 'n:' + pr.name.toLowerCase() : 'w:' + pr._way;
        let g = byKey[key];
        if (!g) {
            g = { id: LOCAL_GROUPS.length, name: pr.name || '', hw: pr.hw || '', lenKm: 0, feats: [], layers: [], v: {} };
            byKey[key] = g;
            LOCAL_GROUPS.push(g);
        }
        g.feats.push(f);
        g.lenKm += roadLenKm(f.geometry);
        g.layers.push(lyr);
        pr._lgid = g.id;
    });
}

const LOCAL_HW_LABEL = { residential: 'Residential street', unclassified: 'Unclassified road', living_street: 'Living street', tertiary: 'Tertiary road', tertiary_link: 'Tertiary link', road: 'Road' };
function localHwLabel(hw) { return LOCAL_HW_LABEL[hw] || 'Local road'; }
function localFmtKm(km) { return km >= 10 ? km.toFixed(0) : km.toFixed(1); }
function localEsc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// The scrollable per-road list ("click a road for its assessment"). Chips follow the active
// cross-test mode; under own criteria local roads carry no verdict, so the chip is neutral.
function renderLocalList() {
    const card = document.getElementById('local-list-card');
    const list = document.getElementById('local-road-list');
    if (!card || !list) return;
    if (!LOCAL_GROUPS.length) { card.style.display = 'none'; list.innerHTML = ''; return; }
    card.style.display = '';
    const mode = xLens.local;
    const CHIP = { green: 'Passes criteria', orange: 'Passes 1 of 2 criteria', red: 'Fails criteria' };
    const order = LOCAL_GROUPS.slice().sort(function (a, b) {
        if (!a.name !== !b.name) return a.name ? -1 : 1;   // named roads first, unnamed ways last
        return (a.name || '').localeCompare(b.name || '') || a.id - b.id;
    });
    list.innerHTML = order.map(function (g) {
        const label = g.name || 'Unnamed local road';
        const v = mode ? gradeLocalGroup(g, mode).v : null;
        const chip = mode
            ? '<span class="flag-chip fc-' + v + '">' + CHIP[v] + '</span>'
            : '<span class="flag-chip fc-neutral">Local</span>';
        const dot = mode ? ' style="background:' + (ROAD_COLORS[v] || '#16a34a') + '"' : '';
        return '<div class="lr-row" data-lg="' + g.id + '" role="button" tabindex="0" aria-label="Assess ' + localEsc(label) + '"' +
            ' onclick="openLocalRoad(+this.dataset.lg)"' +
            ' onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();openLocalRoad(+this.dataset.lg)}">' +
            '<span class="lr-dot"' + dot + '></span>' +
            '<span class="lr-info"><span class="lr-name">' + localEsc(label) + '</span>' +
            '<span class="lr-meta">' + localFmtKm(g.lenKm) + ' km · ' + localHwLabel(g.hw) + '</span></span>' +
            chip + '</div>';
    }).join('');
}

// Open one local road's assessment — the SHARED path for list rows and map clicks: swap the
// panel to the detail view, highlight the whole road on the map (the existing selection
// mechanism), frame it, and show its length in the distance pill.
function openLocalRoad(id) {
    const g = LOCAL_GROUPS[id];
    if (!g || currentTab !== 'local') return;
    _localOpenId = id;
    const lv = document.getElementById('local-list-view');
    const dv = document.getElementById('local-road-detail');
    if (lv) lv.hidden = true;
    if (dv) dv.hidden = false;
    renderLocalRoadDetail(g);
    highlightRoad(g.layers, localRoadsXLayer);
    try { map.fitBounds(L.featureGroup(g.layers).getBounds().pad(0.3), { maxZoom: 17 }); } catch (e) { /* no bounds */ }
    if (typeof showRoadDistance === 'function') showRoadDistance(g.lenKm);
}

// Back to the list view (also called when a new suburb load makes an open detail stale).
function closeLocalRoad() {
    _localOpenId = null;
    const lv = document.getElementById('local-list-view');
    const dv = document.getElementById('local-road-detail');
    if (dv) dv.hidden = true;
    if (lv) lv.hidden = false;
    deselect();
}

// The per-road criteria view — MODE-AWARE (cross-mode criteria display): it shows the criteria
// of whatever the segmented control is testing (own = no S/R criteria apply; as Regional / as
// State = that target's criteria populated with the road's real connectivity counts). Unknowns
// (the unpublished mandatory gates, traffic counts) are explicit "not assessed" rows — never
// fabricated passes or fails.
function renderLocalRoadDetail(g) {
    const mode = xLens.local;
    const set = function (id, txt) { const el = document.getElementById(id); if (el) el.textContent = txt; };
    set('lrd-name', g.name || 'Unnamed local road');
    set('lrd-meta', (LOCAL_SUBURB ? LOCAL_SUBURB + ' · ' : '') + localFmtKm(g.lenKm) + ' km · ' + localHwLabel(g.hw) + ' · council-managed (OpenStreetMap)');
    const vEl = document.getElementById('lrd-verdict');
    const rEl = document.getElementById('lrd-reason');
    const cEl = document.getElementById('lrd-criteria');
    if (!vEl || !rEl || !cEl) return;
    const line = function (icon, color, txt) { return '<span class="result-line">' + icon + '<span style="color:' + color + '">' + txt + '</span></span>'; };
    if (!mode) {
        set('lrd-verdict-title', 'Assessment');
        set('lrd-criteria-title', 'Criteria — Local road');
        vEl.innerHTML = line(ICON.warn, '#57534e', 'NOT GRADED — LOCAL ROAD');
        rEl.textContent = 'Local roads carry no State / Regional criteria of their own. Switch the cross-criteria test to "Test as Regional" or "Test as State" for an indicative re-grade.';
        cEl.innerHTML =
            critItem(null, 'Category: Local (council-managed)', 'OpenStreetMap class: ' + localHwLabel(g.hw)) +
            critItem(null, 'Mandatory vehicle-access gates', 'PBS-1 / 19m B-double access is not published for council roads — not assessed') +
            critItem(null, 'Traffic volume thresholds', 'No TfNSW count data for local roads — not assessed');
    } else if (mode === 'regional') {
        const res = gradeLocalGroup(g, 'regional');
        set('lrd-verdict-title', 'Assessment — tested as Regional (indicative)');
        set('lrd-criteria-title', 'Criteria — Regional Road test');
        vEl.innerHTML = res.v === 'green' ? line(ICON.pass, '#16a34a', 'PASSES REGIONAL CRITERIA')
            : res.v === 'orange' ? line(ICON.maybe, '#d97706', 'LIKELY PASSES REGIONAL CRITERIA')
            : line(ICON.fail, '#dc2626', 'FAILS REGIONAL CRITERIA');
        rEl.textContent = res.centres + ' distinct town / urban centre' + (res.centres === 1 ? '' : 's') + ' and ' + res.nFac + ' major facilit' + (res.nFac === 1 ? 'y' : 'ies') + ' within ~1.2 km — a Regional road needs ≥2 optional criteria met. Indicative: the mandatory 19m B-double gate is not published for council roads.';
        cEl.innerHTML =
            critItem(res.centres >= 2, 'R-01·R-05: Connects ≥2 distinct town / urban centres', res.centres ? (res.centres + ' centre' + (res.centres === 1 ? '' : 's') + ' within ~1.2 km — ' + res.centreNames.join('; ')) : 'None within ~1.2 km') +
            critItem(res.facilityConnection, 'R-02: Connects a qualifying facility / employment centre to a Town or Urban Centre · R-06: connects it to a Major Urban Centre or Major Town',
                res.nFac
                    ? (res.nFac + ' facilit' + (res.nFac === 1 ? 'y' : 'ies') + ' within ~1.2 km — ' + res.facNames.join('; ') +
                       (res.centres ? '; centre evidence: ' + res.centreNames.join('; ') : '; no qualifying centre at the other end of the connection'))
                    : 'No qualifying facility / employment centre within ~1.2 km') +
            critItem(null, 'R-04: 19m B-double access (mandatory gate)', 'Not published for council-managed roads — not assessed') +
            critItem(null, 'Traffic volume thresholds', 'No TfNSW count data for local roads — not assessed');
    } else {
        const res = gradeLocalGroup(g, 'state');
        set('lrd-verdict-title', 'Assessment — tested as State (indicative)');
        set('lrd-criteria-title', 'Criteria — State Road test');
        vEl.innerHTML = res.v === 'green' ? line(ICON.pass, '#16a34a', 'PASSES STATE CRITERIA')
            : res.v === 'orange' ? line(ICON.maybe, '#d97706', 'LIKELY PASSES STATE CRITERIA')
            : line(ICON.fail, '#dc2626', 'FAILS STATE CRITERIA');
        rEl.textContent = res.centres + ' State-tier centre' + (res.centres === 1 ? '' : 's') + ' and ' + res.nFac + ' major facilit' + (res.nFac === 1 ? 'y' : 'ies') + ' within ~1.2 km — a State road needs ≥2 optional criteria. Indicative: the mandatory PBS Level 1 gate is not published for council roads.';
        cEl.innerHTML =
            critItem(res.centres >= 2, 'S-07·S-10: Connects ≥2 State-tier centres (Regional Cities / Major Towns / urban areas)', res.centres ? (res.centres + ' State-tier centre' + (res.centres === 1 ? '' : 's') + ' within ~1.2 km — ' + res.centreNames.join('; ')) : 'None within ~1.2 km') +
            critItem(res.facilityConnection, 'S-08·S-11: Connects a qualifying facility / employment centre to another qualifying centre type',
                res.nFac
                    ? (res.nFac + ' facilit' + (res.nFac === 1 ? 'y' : 'ies') + ' within ~1.2 km — ' + res.facNames.join('; ') +
                       (res.centres ? '; centre evidence: ' + res.centreNames.join('; ') : '; no qualifying centre at the other end of the connection'))
                    : 'No qualifying facility / employment centre within ~1.2 km') +
            critItem(null, 'S-09: PBS Level 1 access (mandatory gate)', 'Not published for council-managed roads — not assessed') +
            critItem(null, 'Traffic volume thresholds', 'No TfNSW count data for local roads — not assessed');
    }
}

// --- Local cross-criteria segmented control: Own criteria / Test as Regional / Test as State ---
// The three cards and distribution line use the same per-road grades as the map and list chips.
// Own criteria deliberately shows "not assessed": the guide publishes no Local-road verdict rule.
function updateLocalVerdictCards() {
    const ids = ['green', 'orange', 'red'];
    const set = function(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    };
    const mode = xLens.local;
    if (!mode) {
        ids.forEach(function(v) {
            set('local-' + v, '—');
            set('local-' + v + '-pct', 'Not assessed under own Local category');
        });
        return;
    }
    if (!LOCAL_GROUPS.length) {
        ids.forEach(function(v) {
            set('local-' + v, '—');
            set('local-' + v + '-pct', 'Load a suburb to run the test');
        });
        return;
    }
    const c = { green: 0, orange: 0, red: 0 };
    const km = { green: 0, orange: 0, red: 0 };
    LOCAL_GROUPS.forEach(function(g) {
        const v = gradeLocalGroup(g, mode).v;
        c[v]++;
        km[v] += g.lenKm || 0;
    });
    const total = LOCAL_GROUPS.length;
    ids.forEach(function(v) {
        set('local-' + v, c[v].toLocaleString());
        set('local-' + v + '-pct', Math.round(c[v] / total * 100) + '% of loaded roads · ' +
            Math.round(km[v]).toLocaleString() + ' km');
    });
}

// The distribution line under the control — real verdict counts over the loaded roads.
function updateLocalXtStatus() {
    const el = document.getElementById('local-xt-status');
    updateLocalVerdictCards();
    if (!el) return;
    const m = xLens.local;
    if (!m) { el.textContent = ''; return; }
    if (!LOCAL_GROUPS.length) { el.textContent = 'Load a suburb to run the test'; return; }
    const c = { green: 0, orange: 0, red: 0 };
    LOCAL_GROUPS.forEach(function (g) { c[gradeLocalGroup(g, m).v]++; });
    el.textContent = LOCAL_GROUPS.length.toLocaleString() + ' local roads re-graded against the ' +
        (m === 'state' ? 'State Road' : 'Regional Road') + ' criteria — ' +
        c.green.toLocaleString() + ' pass · ' + c.orange.toLocaleString() + ' likely pass · ' +
        c.red.toLocaleString() + ' fail (indicative).';
}

// mode: 'own' | false = plain green local roads, 'regional' | 'state' = indicative re-grade.
// Mirrors setCrossTest (panels.js) for the State/Regional lenses.
function setLocalCrossTest(mode) {
    const m = (mode === 'own' || !mode) ? false : mode;
    if (typeof traceCode === 'function') traceCode(
        'Local cross-test: ' + (m ? (m === 'state' ? 'State' : 'Regional') : 'off'),
        'This recolours loaded local roads with a simplified connectivity test against the chosen category. It is indicative because the mandatory heavy-vehicle gates are not published for local roads.',
        "function setLocalCrossTest(mode) {\n  const m = (mode === 'own' || !mode) ? false : mode;\n  xLens.local = m;\n  localRoadsXLayer.setStyle(styleLocalX);\n}\n\nfunction gradeLocalGroup(g, mode) {\n  // >=2 criteria met -> green, 1 -> orange, 0 -> red\n}",
        'loaded local features=' + (localRoadsXLayer ? localRoadsXLayer.getLayers().length : 0)
    );
    xLens.local = m;
    document.querySelectorAll('#local-xt .xt-btn').forEach(function (b) {
        b.classList.toggle('on', (m || 'own') === b.getAttribute('data-xt'));
    });
    if (localRoadsXLayer) localRoadsXLayer.setStyle(styleLocalX);
    renderLocalList();
    updateLocalXtStatus();
    renderMapLegend();   // the Local legend's verdict rows follow the mode
    // An open per-road detail re-renders coherently under the new mode (same road, new criteria).
    if (_localOpenId != null && LOCAL_GROUPS[_localOpenId]) renderLocalRoadDetail(LOCAL_GROUPS[_localOpenId]);
    if (typeof showMapRefresh === 'function' && LOCAL_GROUPS.length)
        showMapRefresh(m ? ('Re-grading local roads as ' + (m === 'state' ? 'State' : 'Regional') + '…') : 'Restoring plain local roads…', 1100);
}
// Back-compat entry point (the old checkbox's boolean semantics).
function toggleLocalTest(on) { setLocalCrossTest(on ? 'regional' : false); }

// --- Excel export hooks (the export menu's "Local roads (loaded suburb)" scope, export.js) ---
function localLoadedInfo() { return { count: LOCAL_GROUPS.length, suburb: LOCAL_SUBURB }; }
function localExportRows() {
    const m = xLens.local;
    const noun = m === 'state' ? 'State' : 'Regional';
    return LOCAL_GROUPS.map(function (g) {
        const res = m ? gradeLocalGroup(g, m) : null;
        const v = res ? res.v : null;
        return {
            'Road Name': g.name || 'Unnamed local road',
            'Connects To': res ? (((res.centreNames || []).concat(res.facNames || [])).join('; ') || '—') : '—',
            'Categorisation': !m ? 'Local road (not graded)'
                : v === 'green' ? ('Passes ' + noun + ' criteria') : v === 'orange' ? ('Likely passes ' + noun + ' criteria') : ('Fails ' + noun + ' criteria'),
            'Why': !m ? 'Own criteria — local roads carry no State/Regional grading'
                : m === 'state'
                    ? ('S-07·S-10  ' + (res.centres >= 2 ? 'met' : 'not met') + ' (' + res.centres + ' State-tier centres)\nS-08·S-11  ' + (res.nFac ? 'met (' + res.nFac + ' facilities)' : 'not met') + '\nS-09  not assessed (gate unpublished)')
                    : ('R-01·R-05  ' + (res.centres >= 2 ? 'met' : 'not met') + ' (' + res.centres + ' distinct centres)\nR-02·R-06  ' + (res.nFac ? 'met (' + res.nFac + ' facilities)' : 'not met') + '\nR-04  not assessed (gate unpublished)'),
            'What (criteria tested)': m
                ? (m === 'state' ? 'Connectivity to State-tier centres + major facilities (indicative cross-test)' : 'Connectivity to town / urban centres + major facilities (indicative cross-test)')
                : 'None — local (council) road',
            'HV Networks (NHVR)': 'Not published for council roads',
            'AADT (TfNSW)': '—',
            'Zone': '—',
            'Road ID': '—',
            'LGA(s) Touched': LOCAL_SUBURB || '—',
            'Length (km)': Math.round(g.lenKm * 10) / 10,
            _v: v || undefined
        };
    });
}

// Close the suburb dropdown when clicking outside the search box.
document.addEventListener('click', function (e) {
    const wrap = document.querySelector('.local-search-wrap');
    if (wrap && !wrap.contains(e.target)) hideSuburbResults();
});
