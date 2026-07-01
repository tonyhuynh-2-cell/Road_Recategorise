// local.js — Local roads & street names via the basemap. The authoritative TfNSW RoadSegment service is
// far too slow (~20-30s per viewport, verified — its functionhi filter full-scans the whole state) for
// live loading. Instead we lean on the base map, which already draws local roads: a CARTO
// "voyager_only_labels" street-label overlay is switched ON only at/after LOCAL_ZOOM, so those local
// roads become NAMED once you zoom in — instant, no external queries, no lag.

const localLabelsLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 20, pane: 'localPane', opacity: 0.95, attribution: '&copy; OSM &copy; CARTO'
});

const LOCAL_TABS = ['overview', 'state', 'regional', 'sydney', 'cv'];   // road-map tabs (not Nat.Sig / Detail)

// Street labels show when: the toggle is on, we're on a road-map tab, AND zoomed in past LOCAL_ZOOM.
function localRoadsAllowed() {
    return legendToggles.local && LOCAL_TABS.indexOf(currentTab) !== -1 && map.getZoom() >= LOCAL_ZOOM;
}

// Add/remove the street-label overlay for the current view. Called by applyLegend and on move/zoom.
function updateLocalRoads() {
    if (localRoadsAllowed()) { if (!map.hasLayer(localLabelsLayer)) map.addLayer(localLabelsLayer); }
    else if (map.hasLayer(localLabelsLayer)) map.removeLayer(localLabelsLayer);
}

map.on('zoomend', updateLocalRoads);

// --- Cross-test tab: council Local roads as GREEN vectors, optionally graded as Regional ---
// Fetched live from TfNSW for the current viewport (zoom-gated, on-demand, ~20s — the service is slow).
// Green by default; the "Test for Regional" toggle grades them by a simplified connectivity proxy.
const LOCALX_ZOOM = 15;
const LOCAL_ROADS_URL = 'https://portal.data.nsw.gov.au/arcgis/rest/services/RoadSegment/MapServer/0';   // council roads (functionhi=6)

localRoadsXLayer = L.geoJSON(null, {
    renderer: localRenderer,
    style: styleLocalX,
    onEachFeature: function (f, layer) {
        layer.on('click', function (e) {
            L.DomEvent.stopPropagation(e);
            const nm = localRoadName(f.properties), v = regionalTestOfLocal(f);
            const verdict = v === 'green' ? 'Would meet Regional (≥2 centres nearby)' : v === 'orange' ? 'Marginal — 1 centre nearby' : 'No ≥2-centre link';
            L.popup().setLatLng(e.latlng).setContent('<strong>' + nm + '</strong><br><span style="color:#78716c; font-size:11px">Local road · council-managed<br>Regional test: ' + verdict + '</span>').openOn(map);
        });
    }
}).addTo(map);
map.removeLayer(localRoadsXLayer);   // shown only on the Cross-test tab, when toggled on

function styleLocalX(f) {
    if (!xtLocal.test) return { color: '#16a34a', weight: 1.5, opacity: 0.9, lineCap: 'round' };
    const v = regionalTestOfLocal(f);
    return { color: ROAD_COLORS[v] || '#9a938c', weight: 1.5, opacity: v === 'red' ? 0.7 : 0.95, lineCap: 'round' };
}

// Simplified Regional test: count distinct town/urban centres within ~1.2km of the road — ≥2 → green
// (a Regional road connects ≥2 centres), 1 → orange, 0 → red. B-double access (the Regional mandatory
// gate) isn't available for local roads, so this is connectivity-only (flagged in the panel).
// Centre points for the proximity test = the 170 major towns PLUS the Significant Urban Area centroids
// (so a local road in/near an urban area registers a centre too). Built once.
function xtCentrePts() {
    if (window._XT_CENTRES) return window._XT_CENTRES;
    const c = (window.NSW_TOWN_PTS || []).slice();
    (window.SUA_OUTLINES || []).forEach(function (s) { if (s && s.centroid) c.push(s.centroid); });
    window._XT_CENTRES = c;
    return c;
}

function regionalTestOfLocal(f) {
    const pts = xtCentrePts();
    if (!pts.length) return 'green';
    const g = f.geometry, lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    const near = {}, R = 1.2;
    for (const cs of lines) for (const v of cs) {
        const lon = v[0], lat = v[1], cosl = Math.cos(lat * Math.PI / 180);
        for (let i = 0; i < pts.length; i++) {
            if (near[i]) continue;
            const dLat = (pts[i][1] - lat) * 111.32, dLon = (pts[i][0] - lon) * 111.32 * cosl;
            if (dLat * dLat + dLon * dLon <= R * R) near[i] = 1;
        }
    }
    const n = Object.keys(near).length;
    return n >= 2 ? 'green' : n === 1 ? 'orange' : 'red';
}

let _lxTimer = null, _lxKey = null, _lxAbort = null, _lxLoading = false;
function updateLocalX() {
    if (currentTab !== 'xtest' || !xtLocal.show) { if (localRoadsXLayer) { localRoadsXLayer.clearLayers(); if (map.hasLayer(localRoadsXLayer)) map.removeLayer(localRoadsXLayer); } _lxKey = null; setLocalXStatus(''); return; }
    if (!map.hasLayer(localRoadsXLayer)) map.addLayer(localRoadsXLayer);
    if (map.getZoom() < LOCALX_ZOOM) { localRoadsXLayer.clearLayers(); _lxKey = null; setLocalXStatus('Zoom in to load local roads'); return; }
    clearTimeout(_lxTimer);
    _lxTimer = setTimeout(fetchLocalX, 300);
}

function fetchLocalX() {
    if (currentTab !== 'xtest' || !xtLocal.show || map.getZoom() < LOCALX_ZOOM) return;
    const b = map.getBounds(), key = Math.round(map.getZoom()) + ':' + b.toBBoxString();
    if (key === _lxKey && (_lxLoading || localRoadsXLayer.getLayers().length)) return;   // same view: loading or loaded
    _lxKey = key; _lxLoading = true;
    const bbox = b.getWest().toFixed(5) + ',' + b.getSouth().toFixed(5) + ',' + b.getEast().toFixed(5) + ',' + b.getNorth().toFixed(5);
    const url = LOCAL_ROADS_URL + '/query?where=' + encodeURIComponent("functionhi='6'") + '&geometry=' + bbox +
        '&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects' +
        '&outFields=roadnameba,roadnamety&returnGeometry=true&geometryPrecision=5&f=geojson';
    if (_lxAbort) { try { _lxAbort.abort(); } catch (e) {} }
    _lxAbort = ('AbortController' in window) ? new AbortController() : null;
    setLocalXStatus('Loading local roads… (TfNSW, ~20s)');
    fetch(url, _lxAbort ? { signal: _lxAbort.signal } : undefined)
        .then(function (r) { return r.json(); })
        .then(function (gj) {
            _lxLoading = false;
            if (currentTab !== 'xtest' || !xtLocal.show) return;
            localRoadsXLayer.clearLayers();
            if (gj && gj.features && gj.features.length) { localRoadsXLayer.addData(gj); setLocalXStatus(gj.features.length + ' local roads' + (xtLocal.test ? ' · graded' : ' · green')); }
            else setLocalXStatus('No local roads in view');
        })
        .catch(function () { _lxLoading = false; setLocalXStatus('Load failed — pan/zoom to retry'); });
}

function setLocalXStatus(msg) { const el = document.getElementById('xt-local-status'); if (el) el.textContent = msg; }

function toggleXtLocalShow(on) { xtLocal.show = !!on; updateLocalX(); }
function toggleXtLocalTest(on) {
    xtLocal.test = !!on;
    if (localRoadsXLayer) localRoadsXLayer.setStyle(styleLocalX);
    const n = localRoadsXLayer ? localRoadsXLayer.getLayers().length : 0;
    if (n) setLocalXStatus(n + ' local roads' + (xtLocal.test ? ' · graded' : ' · green'));
}

map.on('moveend zoomend', updateLocalX);
