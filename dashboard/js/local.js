// local.js — Local (council) roads.
//
// Two jobs:
//  1. Street NAMES on the normal road-map tabs, via the basemap: a CARTO "voyager_only_labels" overlay
//     switched on once zoomed in past LOCAL_ZOOM (instant, no queries).
//  2. The Local TAB: search a SUBURB → we load that suburb's council/local roads (OpenStreetMap / Overpass)
//     as GREEN vectors, CLIPPED to the suburb boundary so nothing leaks past the outline, with an optional
//     "grade as Regional" cross-test. A suburb is a small, bounded query, so it loads fast and reliably —
//     unlike a whole-viewport fetch (the state has too many local roads to draw at once).

const localLabelsLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 20, pane: 'localPane', opacity: 0.95, attribution: '&copy; OSM &copy; CARTO'
});

const LOCAL_TABS = ['overview', 'state', 'regional', 'sydney', 'cv', 'local'];   // road-map tabs (not Nat.Sig / Detail)

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
    L.popup().setLatLng(e.latlng).setContent('<strong>' + nm + '</strong><br><span style="color:#78716c; font-size:11px">Local road · council-managed</span>').openOn(map);
}
map.on('click', localRoadClickHandler);

function styleLocalX(f) {
    if (!xLens.local) return { color: '#16a34a', weight: 1.5, opacity: 0.9, lineCap: 'round' };
    const v = regionalTestOfLocal(f);
    return { color: ROAD_COLORS[v] || '#9a938c', weight: 1.5, opacity: v === 'red' ? 0.7 : 0.95, lineCap: 'round' };
}

// Simplified Regional test: count distinct town/urban centres within ~1.2km of the road — ≥2 → green
// (a Regional road connects ≥2 centres), 1 → orange, 0 → red. B-double access (the Regional mandatory
// gate) isn't available for local roads, so this is connectivity-only (flagged in the panel).
// Centre points = the 170 major towns PLUS the Significant Urban Area centroids. Built once.
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
function overpassToClippedGeojson(data, rings) {
    const feats = []; let roads = 0;
    ((data && data.elements) || []).forEach(function (el) {
        if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) return;
        const coords = el.geometry.map(function (pt) { return [pt.lon, pt.lat]; });
        const props = { name: (el.tags && el.tags.name) || '', hw: (el.tags && el.tags.highway) || '' };
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
function progDone() { clearInterval(_progTimer); progSet(100); setTimeout(function () { const el = document.getElementById('local-progress'); if (el) el.hidden = true; progSet(0); }, 400); }
function progFail() { clearInterval(_progTimer); const el = document.getElementById('local-progress'); if (el) el.hidden = true; progSet(0); }

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
    hideSuburbResults();
    const inp = document.getElementById('local-suburb-input'); if (inp) { inp.value = s.name; inp.blur(); }
    progStart();
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
            if (res.fc.features.length) {
                localRoadsXLayer.addData(res.fc);
                setLocalTotal(res.roads);
                setLocalXStatus(res.roads.toLocaleString() + ' local roads in ' + suburbLabel(g) + (xLens.local ? ' · graded as Regional' : ' · green'));
            } else { setLocalTotal(0); setLocalXStatus('No local roads found in ' + suburbLabel(g)); }
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
        style: { color: '#1c1917', weight: 2, opacity: 0.9, fill: false, dashArray: '4 4' } }).addTo(map);
}

// Local tab cross-test toggle: grade the loaded council roads by the Regional connectivity test.
function toggleLocalTest(on) {
    xLens.local = !!on;
    if (localRoadsXLayer) localRoadsXLayer.setStyle(styleLocalX);
    const nn = localRoadsXLayer ? localRoadsXLayer.getLayers().length : 0;
    if (nn) { const el = document.getElementById('local-status'); if (el && /local roads/.test(el.textContent)) el.textContent = el.textContent.replace(/· (green|graded as Regional)$/, xLens.local ? '· graded as Regional' : '· green'); }
}

// Close the suburb dropdown when clicking outside the search box.
document.addEventListener('click', function (e) {
    const wrap = document.querySelector('.local-search-wrap');
    if (wrap && !wrap.contains(e.target)) hideSuburbResults();
});
