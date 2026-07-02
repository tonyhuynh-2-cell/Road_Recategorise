// state.js — Leaflet map instance, shared mutable state, selection + loader + town-label control.

// Map setup. The map's default renderer is ONE shared canvas with a click tolerance, so the road
// hitbox is ~25% larger than the drawn line (a 1.5px buffer) without changing how thin roads look.
// Using the map default (not per-layer renderers) is deliberate: a per-layer canvas gets detached or
// stacked on tab switches, which silently kills road clicking until reload.
const map = L.map('map', { preferCanvas: true, renderer: L.canvas({ tolerance: 1.5 }) }).setView([-32.0, 149.5], 6);
// Drop the "Leaflet" branding watermark from the attribution box (keep the © OSM / © CARTO data
// credit — required by the basemap tile terms).
map.attributionControl.setPrefix(false);
// Move the zoom control off the top-left so it doesn't collide with the road search box.
map.zoomControl.setPosition('bottomleft');

// PDF-style basemap: CARTO Voyager (no labels) = warm/cream land, blue water, muted grey roads —
// close to the NLTN Determination 2020 map. A mild warm CSS filter (see .leaflet-tile-pane in the
// CSS) nudges the land further toward the PDF's cream. The dashboard draws its own town labels.
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OSM &copy; CARTO', maxZoom: 19
}).addTo(map);

let nswLayer, nswTownsLayer, cvLayer, cvClipLayer, cvBoundaryLayer, cvTownsLayer, sydBoundaryLayer, nltnLayer, bypassLayer, localRoadsXLayer;


// Dedicated pane for the NLTN 2020 reference network. It sits ABOVE the road overlay (z-index 400)
// and uses an SVG renderer so the green lines (incl. proposed corridors) stay hoverable/clickable,
// while clicks on empty areas pass THROUGH to the graded roads underneath (canvas would swallow them).
map.createPane('nltnPane');
map.getPane('nltnPane').style.zIndex = 450;
const nltnRenderer = L.svg({ pane: 'nltnPane' });

// CV LGA boundary outline — its own pane just above the road overlay (z 420 > 400) so the black
// outline always draws on top of the roads. MUST be SVG, not canvas: a second canvas pane stacks
// over the road canvas and swallows every click across the map (and lingers after leaving the CV
// tab), killing road selection. Leaflet sets SVG panes to pointer-events:none, so clicks pass through.
map.createPane('cvbPane');
map.getPane('cvbPane').style.zIndex = 420;
const cvbRenderer = L.svg({ pane: 'cvbPane' });

// Local roads & street names come from the basemap: a CARTO street-label overlay added only at high
// zoom (see local.js) — the authoritative TfNSW service is far too slow (~20-30s/request) for live use.
// Its tile pane sits just above the base map, below the graded road overlay (z 260 < 400) so the
// State/Regional grading always reads on top.
map.createPane('localPane');
map.getPane('localPane').style.zIndex = 260;
// Local road vectors get their OWN canvas renderer (NOT the shared default one that draws the graded
// roads). This isolation is deliberate: mixing the on-demand local roads into the default renderer and
// then swapping them out was found to break canvas hit-testing for the graded roads afterwards (State /
// Regional / Nat.Sig selection would silently stop working). Keeping local roads on a separate canvas
// leaves graded-road selection rock-solid across tab switches. Local roads are picked via a nearest-road
// map-click handler (see local.js), so they don't rely on this canvas's hit-testing. Labels: localPane too.
const localRenderer = L.canvas({ pane: 'localPane' });

// HV bypass highlight — roads on an NHVR heavy-vehicle bypass route (data/nhvr_networks.json ->
// bypass). Drawn as a solid cyan halo in a pane BELOW the road overlay (z 390 < 400) so the
// graded road + any selection still draw on top and the halo peeks around the line. SVG +
// non-interactive so clicks fall straight through to the road. Toggled by the 'bypass' legend item.
// (No dedicated bypass GeoPackage yet — surfaces the existing per-road flags; upload a bypass
//  network and rebuild_from_nhvr.py can populate it the same way as road train / B-double.)
map.createPane('bypassPane');
map.getPane('bypassPane').style.zIndex = 390;
const bypassRenderer = L.svg({ pane: 'bypassPane' });
const BYPASS_STYLE = { pane: 'bypassPane', renderer: bypassRenderer, color: '#0891b2', weight: 6,
    opacity: 1, lineCap: 'round', lineJoin: 'round', interactive: false };

// --- Connectivity highlights ---------------------------------------------------------------
// When a road is selected, ring + label every entity it connects (the evidence behind its
// criteria): town centres, major hospitals, ports / airports / intermodals. The ring is the
// ~connection radius (the "perimeter" the criteria test against). Lives in its own pane on top.
map.createPane('connPane');
map.getPane('connPane').style.zIndex = 660;   // above road/marker panes, below popups
const connRenderer = L.svg({ pane: 'connPane' });   // SVG so rings draw even with preferCanvas
const connLayer = L.layerGroup();
const CONN_STYLE = {
    town:  { color: '#1d4ed8', radius: 2200, glyph: '' },
    sua:   { color: '#1d4ed8', radius: 0,    glyph: '◍' },
    hosp:  { color: '#dc2626', radius: 1600, glyph: 'H' },
    dest:  { color: '#7c3aed', radius: 2200, glyph: '★' },
    employ:{ color: '#0f766e', radius: 1000, glyph: '⬢' }   // employment / commercial / industrial centre (smaller ring)
};
function destGlyph(ftype) {
    const t = String(ftype || '').toLowerCase();
    if (t.indexOf('airport') !== -1) return '✈';
    if (t.indexOf('port') !== -1) return '⚓';
    if (t.indexOf('intermodal') !== -1) return '▦';
    return '★';
}
function connMarker(e, kind) {
    const glyph = kind === 'dest' ? destGlyph(e.ftype) : CONN_STYLE[kind].glyph;
    const html = '<span class="conn-pin">' + (glyph ? '<span class="conn-glyph">' + glyph + '</span>' : '') +
        '<span class="conn-name">' + e.name + '</span></span>';
    return L.marker([e.lat, e.lon], { pane: 'connPane', keyboard: false,
        icon: L.divIcon({ className: 'conn-icon conn-' + kind, html: html, iconSize: null, iconAnchor: [0, 0] }) });
}
// Draw a Significant Urban Area boundary (the "town perimeter") from its decimated rings. No fill
// so the roads underneath stay visible; big metros (Sydney) render lighter so they don't dominate.
function drawSuaOutline(suaId) {
    const su = (window.SUA_OUTLINES || [])[suaId];
    if (!su || !su.rings) return;
    // Draw each ring as its own outline (multipart urban areas are separate islands, not holes).
    su.rings.forEach(function (ring) {
        const latlng = ring.map(function (pt) { return [pt[1], pt[0]]; });
        L.polygon(latlng, { pane: 'connPane', renderer: connRenderer, color: '#1d4ed8',
            weight: su.big ? 1.2 : 1.8, opacity: su.big ? 0.45 : 0.7, dashArray: '5 5',
            fill: true, fillColor: '#1d4ed8', fillOpacity: su.big ? 0.03 : 0.06, interactive: false }).addTo(connLayer);
    });
}
// The evidence for the currently-selected road, kept so the legend toggles can re-render the
// highlights without re-selecting the road (see refreshConnections / applyLegend).
let _lastConnEv = null;
function showConnections(ev) {
    clearConnections();
    _lastConnEv = ev || null;
    if (!ev) return;
    // Centres (blue): a mix of town points (ring + pin) and urban areas (boundary outline + pin).
    if (legendToggles.c_centre) (ev.centres || []).forEach(function (e) {
        if (e.kind === 'sua') {
            drawSuaOutline(e.suaId);
            connMarker(e, 'sua').addTo(connLayer);
        } else {
            const s = CONN_STYLE.town;
            L.circle([e.lat, e.lon], { pane: 'connPane', renderer: connRenderer, radius: s.radius, color: s.color, weight: 1.5,
                opacity: 0.65, fillColor: s.color, fillOpacity: 0.07, interactive: false }).addTo(connLayer);
            connMarker(e, 'town').addTo(connLayer);
        }
    });
    // Facility highlights — each category honours its own legend toggle (c_hosp / c_dest / c_employ).
    [['hosp', 'c_hosp'], ['dest', 'c_dest'], ['employ', 'c_employ']].forEach(function (pair) {
        const kind = pair[0];
        if (!legendToggles[pair[1]]) return;
        const items = kind === 'hosp' ? ev.hospitals : kind === 'dest' ? ev.dests : ev.employment;
        const s = CONN_STYLE[kind];
        (items || []).forEach(function (e) {
            L.circle([e.lat, e.lon], { pane: 'connPane', renderer: connRenderer, radius: s.radius, color: s.color, weight: 1.5,
                opacity: 0.65, fillColor: s.color, fillOpacity: 0.07, interactive: false }).addTo(connLayer);
            connMarker(e, kind).addTo(connLayer);
        });
    });
    if (!map.hasLayer(connLayer)) connLayer.addTo(map);
}
// Re-draw the current selection's highlights after a highlight legend toggle changes.
function refreshConnections() { if (_lastConnEv) showConnections(_lastConnEv); }
function clearConnections() { connLayer.clearLayers(); }
function panToConn(lon, lat) { map.panTo([lat, lon], { animate: true }); }
// Frame a Significant Urban Area: fit to its bounding box so the whole perimeter is in view.
function fitToSua(suaId) {
    const su = (window.SUA_OUTLINES || [])[suaId];
    if (!su) return;
    if (su.bbox) map.fitBounds([[su.bbox[1], su.bbox[0]], [su.bbox[3], su.bbox[2]]], { padding: [40, 40], maxZoom: 12 });
    else if (su.centroid) map.panTo([su.centroid[1], su.centroid[0]], { animate: true });
}

// Legend visibility toggles — clicking a legend item flips its key and re-applies to the map.
// green/orange/red = verdict colours; nltn = green national network; dashed = route-numbered roads;
// towns = town/city pins; boundary = CV LGA outline.
// verdict colours + dashed/towns/boundary, plus the "Highlights" group: c_centre/c_hosp/c_dest/
// c_employ = the on-select connection rings. clip = CV tab only, hide roads outside the LGA outline.
let legendToggles = { green: true, orange: true, red: true, nltn: true, dashed: true, towns: true, boundary: true, clip: false,
    bypass: false, local: true, c_centre: true, c_hosp: true, c_dest: true, c_employ: true };

// Cross-criteria (reclassification) test — folded into the State / Regional / Local tabs as a per-tab
// toggle (there is no separate Cross-test tab). On the State tab it re-grades roads AS Regional; on the
// Regional tab, AS State; on the Local tab it grades the council roads by the Regional connectivity test.
// The optional criteria are shared; only the mandatory gate swaps (State PBS-1 ↔ Regional 19m B-double).
let xLens = { state: false, regional: false, local: false };

let currentTab = 'overview';

let lastViewTab = 'overview';   // last view tab before opening Road Detail (for the Back button)

let nswView = 'all';        // active NSW lens: 'all' | 'nsr' | 'state' | 'regional'

let NSW_AGG = {};           // per-road rolled-up aggregate (set during load), used for lens counts

let NSW_SEG_TOTAL = 0;      // total assessed road segments (features) — shown alongside the road count

let mapContext = null;      // 'nsw' | 'cv' | 'sydney' | 'local' — only refit the map when this changes, not on every tab switch

let selectedLayers = [];

let selectedSource = null;

// Track load start so the constant-speed loading bar can finish before fade-out
const loadStart = performance.now();

function highlightRoad(layers, sourceLayer) {
    if (selectedSource) selectedLayers.forEach(l => selectedSource.resetStyle(l));
    selectedLayers = layers;
    selectedSource = sourceLayer;
    layers.forEach(l => l.setStyle({ weight: 6, opacity: 1, color: '#2563eb', dashArray: null }));
}

function isSelected(layer) { return selectedLayers.indexOf(layer) !== -1; }

function deselect() {
    clearConnections();
    _lastConnEv = null;
    if (!selectedLayers.length) return;
    if (selectedSource) selectedLayers.forEach(l => selectedSource.resetStyle(l));
    selectedLayers = [];
    selectedSource = null;
    hideRoadDistance();     // clear the selected-road distance readout
    const c = document.getElementById('detail-content'); if (c) c.style.display = 'none';
    const e = document.getElementById('detail-empty'); if (e) e.style.display = '';
}

map.on('click', deselect);  // clicking off any road clears the selection

// --- Bottom-right map widgets: a scale bar + the selected-road distance readout ---
// Scale bar: pick a "nice" round distance (1 / 2 / 5 × 10ⁿ) that fits in ~80 px at the map centre.
function updateScale() {
    const barEl = document.getElementById('mw-scale-bar');
    const labelEl = document.getElementById('mw-scale-label');
    if (!barEl || !labelEl) return;
    const y = map.getSize().y / 2, target = 130;
    const meters = map.distance(map.containerPointToLatLng([0, y]), map.containerPointToLatLng([target, y]));
    if (!isFinite(meters) || meters <= 0) return;
    const pow = Math.pow(10, Math.floor(Math.log10(meters)));
    const nice = ((meters / pow) >= 5 ? 5 : (meters / pow) >= 2 ? 2 : 1) * pow;
    barEl.style.width = Math.round(target * nice / meters) + 'px';
    labelEl.textContent = nice >= 1000 ? (nice / 1000) + ' km' : Math.round(nice) + ' m';
}
map.on('moveend zoomend', updateScale);
map.whenReady(function () { setTimeout(updateScale, 0); });

// The selected road's length (km) in a pill above the scale; hidden when nothing is selected.
function showRoadDistance(km) {
    const el = document.getElementById('mw-distance');
    if (!el) return;
    if (typeof km !== 'number' || !isFinite(km) || km <= 0) { el.hidden = true; return; }
    el.innerHTML = '<span class="mw-dist-cap">Length</span>' + (km >= 10 ? km.toFixed(0) : km.toFixed(1)) + ' km';
    el.hidden = false;
}
function hideRoadDistance() { const el = document.getElementById('mw-distance'); if (el) el.hidden = true; }

function updateTownLabels() {
    map.getContainer().classList.toggle('labels-on', map.getZoom() >= LABEL_ZOOM);
}

map.on('zoomend', updateTownLabels);

// --- Network reveal (UI revamp): the road WEB grows outward from Sydney -------------------------
// Not a geometric wipe: every road strand draws along its own length on a temporary overlay canvas.
// A strand starts once the growth has crawled to it THROUGH THE NETWORK (Dijkstra network distance
// from Sydney over the strand graph — see the web block in _revealStart), then grows away from
// Sydney along the web at its class draw speed — so a 200 km highway visibly streams for seconds
// while a 2 km street pops, tendrils branch at junctions, and the front is web-shaped, never a
// circle. Drawing is INCREMENTAL (each frame strokes only the new kilometres; the canvas
// accumulates), so per-frame cost stays tiny. The real Leaflet vector/marker panes are hidden via
// opacity (hit-testing still works) and restored when the growth completes — the final frame is the
// untouched map, byte-identical. Any pan/zoom mid-growth snaps straight to the finished map.
// Runs on boot (hideLoader) and on every map-tab switch except Local (see switchTab); skipped under
// prefers-reduced-motion. Note: speeds are cinematic km-per-SECOND (a literal 300 km/h would take
// ~4 hours to cross NSW); dashed route-numbered roads draw solid while growing.
const REVEAL_ORIGIN = L.latLng(-33.8688, 151.2093);   // Sydney CBD
// Phased by class, in strict order: Nationally Significant first, then State, then Regional — each
// phase starts when the previous one finishes, with its own speeds (km per SECOND of animation).
const REVEAL_CLASSES = ['nsr', 'state', 'regional'];
const REVEAL_SPEED = {
    nsr:      { spread: 640, draw: 320 },   // motorway streams: fast and sweeping
    state:    { spread: 320, draw: 140 },
    regional: { spread: 240, draw: 100 }    // the detailed fill-in
};
// Verdict-colour pacing on top of the class speeds: green (meets criteria) loads 35% faster,
// orange (meets 1 of 2) 20% faster, red (does not meet) at base speed — within each phase the
// passing roads visibly race ahead. Unknown colours run at base.
const REVEAL_COLOR_BOOST = { '#16a34a': 1.35, '#f59e0b': 1.2, '#dc2626': 1 };
// The REGIONAL lens gets its own pacing: green 50% faster, orange at base speed, and red 15%
// slower than base — the downgrade candidates crawl in last, sharpening the contrast.
const REVEAL_COLOR_BOOST_REGIONAL = { '#16a34a': 1.5, '#f59e0b': 1, '#dc2626': 0.85 };
// Phase overlap: the next class begins when the previous one is this fraction complete —
// 0.5 = State starts once Nat.Sig is halfway done, Regional once State is halfway done
// (1 would be strictly sequential).
const REVEAL_PHASE_START = 0.5;
const REVEAL_MAX_MS = 40000;      // hard safety cap on the whole animation
let _revealPanes = null, _revealPending = null, _revealGen = 0;
let _revealRaf = null, _revealCanvas = null;

function _revealCleanup() {
    if (_revealRaf) { cancelAnimationFrame(_revealRaf); _revealRaf = null; }
    map.off('movestart', _revealCleanup);
    map.off('zoomstart', _revealCleanup);
    if (_revealCanvas) { if (_revealCanvas.parentNode) _revealCanvas.parentNode.removeChild(_revealCanvas); _revealCanvas = null; }
    if (_revealPanes) { _revealPanes.forEach(function (el) { el.style.opacity = ''; }); _revealPanes = null; }
}

// Straight-line km between two LatLngs (equirectangular — plenty for animation timing).
function _kmBetween(a, b) {
    const dLat = (b.lat - a.lat) * 111.32;
    const dLon = (b.lng - a.lng) * 111.32 * Math.cos((a.lat + b.lat) * Math.PI / 360);
    return Math.sqrt(dLat * dLat + dLon * dLon);
}

// Collect drawable strands from a vector layer: one strand per polyline part, oriented so index 0
// is the Sydney-nearest end, with container-pixel points, cumulative km, and per-class timing.
// `clsOf(layer)` names the strand's phase ('nsr' | 'state' | 'regional'); rawDelay/dur use that
// class's own speeds. Phase offsets are added later in _revealStart (strict class sequencing).
function _revealStrands(group, clsOf, boostTable, out) {
    if (!group || !map.hasLayer(group)) return;
    group.eachLayer(function (l) {
        if (!l.getLatLngs || !l.options) return;
        const o = l.options;
        if (o.stroke === false || !o.weight || o.opacity === 0) return;   // hidden in this lens
        const cls = clsOf(l);
        const speed = REVEAL_SPEED[cls] || REVEAL_SPEED.regional;
        const parts = [];
        (function flat(lls) {
            if (!lls || !lls.length) return;
            if (lls[0] instanceof L.LatLng) parts.push(lls); else lls.forEach(flat);
        })(l.getLatLngs());
        parts.forEach(function (ll) {
            if (ll.length < 2) return;
            const pts = new Array(ll.length), cum = new Array(ll.length);
            let km = 0;
            for (let i = 0; i < ll.length; i++) {
                const cp = map.latLngToContainerPoint(ll[i]);
                pts[i] = cp;
                if (i) km += _kmBetween(ll[i - 1], ll[i]);
                cum[i] = km;
            }
            if (km < 0.01) return;
            const boost = boostTable[String(o.color || '').toLowerCase()] || 1;
            // Orientation + rawDelay are assigned in _revealStart once NETWORK distances are known
            // (Dijkstra over the strand graph) — the web grows along connections, not as a disc.
            out.push({
                pts: pts, cum: cum, len: km, idx: 0, drawn: 0, done: false, cls: cls,
                la: ll[0], lb: ll[ll.length - 1],
                spreadV: speed.spread * boost, rawDelay: 0,
                dur: (km / (speed.draw * boost)) * 1000, delay: 0,
                color: o.color || '#888', weight: o.weight, alpha: (o.opacity == null ? 1 : o.opacity)
            });
        });
    });
}

// Interpolated container point at `km` along a strand (idx already positioned at/before km).
function _ptAtKm(s, km) {
    let i = s.idx;
    while (i < s.cum.length - 1 && s.cum[i + 1] < km) i++;
    s.idx = i;
    if (i >= s.pts.length - 1) return s.pts[s.pts.length - 1];
    const a = s.pts[i], b = s.pts[i + 1];
    const span = s.cum[i + 1] - s.cum[i];
    const f = span > 0 ? (km - s.cum[i]) / span : 0;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

function _revealStart() {
    _revealCleanup();   // cancel any in-flight growth first
    const container = map.getContainer();
    const mapPane = map.getPane('mapPane'); if (!mapPane) return;
    const strands = [];
    const roadCls = function (l) { return (l.feature && l.feature.properties && l.feature.properties.admin_class === 'S') ? 'state' : 'regional'; };
    const nsrCls = function () { return 'nsr'; };
    // The Regional lens uses its own verdict-colour pacing; every other view uses the global table.
    const boostTable = (typeof currentTab !== 'undefined' && currentTab === 'regional') ? REVEAL_COLOR_BOOST_REGIONAL : REVEAL_COLOR_BOOST;
    _revealStrands(typeof nswLayer !== 'undefined' ? nswLayer : null, roadCls, boostTable, strands);
    _revealStrands(typeof cvClipLayer !== 'undefined' ? cvClipLayer : null, roadCls, boostTable, strands);
    _revealStrands(typeof nltnLayer !== 'undefined' ? nltnLayer : null, nsrCls, boostTable, strands);
    if (!strands.length) return;
    // --- WEB propagation: growth travels ALONG the network, not as an expanding disc. -----------
    // Build a graph from strand endpoints (snapped to ~220m so touching roads connect), then run
    // Dijkstra from Sydney: a strand's start time uses its NETWORK distance — it can only begin
    // once the web has crawled to it through connected roads, and it grows away from Sydney along
    // that web. Disconnected islands fall back to penalised straight-line distance so they still
    // appear (slightly late) rather than never.
    const nodeKey = function (ll) { return Math.round(ll.lat * 500) + ',' + Math.round(ll.lng * 500); };
    const adj = new Map();
    const addEdge = function (a, b, w) { let e = adj.get(a); if (!e) { e = []; adj.set(a, e); } e.push([b, w]); };
    strands.forEach(function (s) {
        s.na = nodeKey(s.la); s.nb = nodeKey(s.lb);
        addEdge(s.na, s.nb, s.len); addEdge(s.nb, s.na, s.len);
    });
    const dist = new Map(), heap = [];
    const hPush = function (d, k) {
        heap.push([d, k]); let i = heap.length - 1;
        while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; const t = heap[p]; heap[p] = heap[i]; heap[i] = t; i = p; }
    };
    const hPop = function () {
        const top = heap[0], last = heap.pop();
        if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; const t = heap[m]; heap[m] = heap[i]; heap[i] = t; i = m; } }
        return top;
    };
    const seeded = new Set();
    strands.forEach(function (s) {
        [[s.na, s.la], [s.nb, s.lb]].forEach(function (nk) {
            if (seeded.has(nk[0])) return; seeded.add(nk[0]);
            const d0 = _kmBetween(nk[1], REVEAL_ORIGIN);
            if (d0 <= 30) { dist.set(nk[0], d0); hPush(d0, nk[0]); }   // web entry points around Sydney
        });
    });
    while (heap.length) {
        const top = hPop(), d = top[0], k = top[1];
        if (d > dist.get(k)) continue;
        const es = adj.get(k); if (!es) continue;
        for (let i = 0; i < es.length; i++) {
            const k2 = es[i][0], nd = d + es[i][1];
            if (nd < (dist.has(k2) ? dist.get(k2) : Infinity)) { dist.set(k2, nd); hPush(nd, k2); }
        }
    }
    strands.forEach(function (s) {
        let dA = dist.has(s.na) ? dist.get(s.na) : Infinity;
        let dB = dist.has(s.nb) ? dist.get(s.nb) : Infinity;
        if (dA === Infinity && dB === Infinity) {   // island: penalised straight-line fallback
            dA = _kmBetween(s.la, REVEAL_ORIGIN) * 1.3; dB = _kmBetween(s.lb, REVEAL_ORIGIN) * 1.3;
        }
        if (dB < dA) {   // flip so index 0 is the web-nearer end — the strand grows away from Sydney
            s.pts.reverse();
            const n = s.cum.length, L = s.len, c = new Array(n);
            for (let i = 0; i < n; i++) c[i] = L - s.cum[n - 1 - i];
            s.cum = c; const t = dA; dA = dB; dB = t;
        }
        s.rawDelay = (dA / s.spreadV) * 1000;
    });
    // Overlapped class sequencing: each class starts once the previous one is REVEAL_PHASE_START
    // complete (Nat.Sig halfway → State begins; State halfway → Regional begins). Classes absent
    // from this lens cost nothing.
    let phaseOffset = 0;
    REVEAL_CLASSES.forEach(function (cls) {
        let clsEnd = 0;
        strands.forEach(function (s) { if (s.cls === cls) { s.delay = phaseOffset + s.rawDelay; clsEnd = Math.max(clsEnd, s.rawDelay + s.dur); } });
        phaseOffset += clsEnd * REVEAL_PHASE_START;
    });
    // Hide the real vector/marker panes (opacity keeps hit-testing alive) and draw over the tiles.
    _revealPanes = Array.prototype.filter.call(mapPane.children, function (el) {
        return el.classList.contains('leaflet-pane') && !el.classList.contains('leaflet-tile-pane');
    });
    _revealPanes.forEach(function (el) { el.style.opacity = '0'; });
    const size = map.getSize(), dpr = window.devicePixelRatio || 1;
    const cv = document.createElement('canvas');
    cv.className = 'reveal-canvas';
    cv.width = Math.round(size.x * dpr); cv.height = Math.round(size.y * dpr);
    cv.style.cssText = 'position:absolute;inset:0;z-index:450;pointer-events:none;width:' + size.x + 'px;height:' + size.y + 'px;';
    container.appendChild(cv);
    _revealCanvas = cv;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const t0 = performance.now();
    let live = strands.length;
    function frame(now) {
        const t = now - t0;
        for (let i = 0; i < strands.length; i++) {
            const s = strands[i];
            if (s.done || t <= s.delay) continue;
            const target = Math.min(s.len, ((t - s.delay) / s.dur) * s.len);
            if (target <= s.drawn) continue;
            const from = _ptAtKm(s, s.drawn);
            ctx.beginPath();
            ctx.moveTo(from.x, from.y);
            let i2 = s.idx + 1;
            while (i2 < s.pts.length && s.cum[i2] <= target) { ctx.lineTo(s.pts[i2].x, s.pts[i2].y); i2++; }
            if (i2 < s.pts.length) { const end = _ptAtKm(s, target); ctx.lineTo(end.x, end.y); }
            ctx.strokeStyle = s.color; ctx.lineWidth = s.weight; ctx.globalAlpha = s.alpha;
            ctx.stroke();
            s.drawn = target;
            if (target >= s.len) { s.done = true; live--; }
        }
        if (live > 0 && t < REVEAL_MAX_MS) _revealRaf = requestAnimationFrame(frame);
        else _revealCleanup();   // growth complete (or capped) — restore the real, untouched map
    }
    _revealRaf = requestAnimationFrame(frame);
    map.on('movestart', _revealCleanup);
    map.on('zoomstart', _revealCleanup);
}

function revealFromSydney() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const gen = ++_revealGen;   // a newer call supersedes any pending start from an older one
    let started = false;
    const start = function () { if (started || gen !== _revealGen) return; started = true; _revealStart(); };
    // A context switch may have kicked off an animated refit (fitBounds) — wait for the view to
    // settle so the wave is computed against the final geometry; otherwise begin on the next frame.
    const busy = function () {
        return map.getContainer().classList.contains('leaflet-zoom-anim') ||
            mapPaneHasClass('leaflet-pan-anim');
    };
    function mapPaneHasClass(c) { const mp = map.getPane('mapPane'); return !!(mp && mp.classList.contains(c)); }
    const deferToSettle = function () {
        map.once('moveend', function () { setTimeout(start, 30); });
        clearTimeout(_revealPending);
        _revealPending = setTimeout(start, 1600);   // safety: never wait forever for a moveend
    };
    if (busy()) deferToSettle();
    else requestAnimationFrame(function () { if (busy()) deferToSettle(); else start(); });
}

// Data-refresh pill (top-centre of the map): shown while road vectors reload — the suburb
// local-roads fetch and the HV bypass isolate. Pass holdMs to auto-hide after that long;
// otherwise call hideMapRefresh() when the work completes.
let _mrTimer = null;
function showMapRefresh(msg, holdMs) {
    const el = document.getElementById('map-refresh');
    if (!el) return;
    const t = document.getElementById('map-refresh-text');
    if (t && msg) t.textContent = msg;
    el.classList.add('mr-on');
    clearTimeout(_mrTimer);
    if (holdMs) _mrTimer = setTimeout(hideMapRefresh, holdMs);
}
function hideMapRefresh() {
    clearTimeout(_mrTimer);
    const el = document.getElementById('map-refresh');
    if (el) el.classList.remove('mr-on');
}

// Count the visible tab's stat values up from 0 on first reveal (skipped under reduced motion).
// Final frame lands on the exact original number — display-only, the data is never touched.
function _countUpStats() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    document.querySelectorAll('.tab-content.active .stat-value').forEach(function (el) {
        const raw = el.textContent.trim();
        if (!/^[\d,]+$/.test(raw)) return;   // skip placeholders ('–') and anything non-numeric
        const target = parseInt(raw.replace(/,/g, ''), 10);
        const useComma = raw.indexOf(',') !== -1;
        const t0 = performance.now(), dur = 700;
        let raf = 0;
        (function frame(t) {
            const p = Math.min(1, (t - t0) / dur);
            const eased = 1 - Math.pow(1 - p, 3);
            const v = Math.round(target * eased);
            el.textContent = useComma ? v.toLocaleString() : String(v);
            if (p < 1) raf = requestAnimationFrame(frame);
        })(t0);
        // Guarantee the EXACT original string lands even if the rAF chain is throttled or
        // killed (background tab, headless) — the displayed count must never stay wrong.
        setTimeout(function () { if (raf) cancelAnimationFrame(raf); el.textContent = raw; }, dur + 100);
    });
}

// Hide the loading screen once boot completes: finish the progress bar, fade the overlay, then
// release the entrance choreography (body.is-ready — see the revamp CSS) and count the stats up.
function hideLoader() {
    const l = document.getElementById('loader');
    if (!l) return;
    const minShow = 1200;
    const elapsed = performance.now() - loadStart;
    const fade = () => {
        const bf = document.getElementById('loader-bar-fill'); if (bf) bf.style.width = '100%';
        const st = document.getElementById('loader-status'); if (st) st.textContent = 'Ready';
        l.classList.add('loaded');
        document.body.classList.add('is-ready');
        _countUpStats();
        // Revamp: as the loader fades, the network blooms outward from Sydney.
        if (typeof revealFromSydney === 'function') revealFromSydney();
    };
    if (elapsed < minShow) setTimeout(fade, minShow - elapsed);
    else fade();
}
