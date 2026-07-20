// state.js — Leaflet map instance, shared mutable state, selection + loader + town-label control.

// Map setup. The map's default renderer is ONE shared canvas with a click tolerance, so the road
// hitbox is ~25% larger than the drawn line (a 1.5px buffer) without changing how thin roads look.
// Using the map default (not per-layer renderers) is deliberate: a per-layer canvas gets detached or
// stacked on tab switches, which silently kills road clicking until reload.
// Keep the map centred on NSW and stop it drifting off to the blank world: maxBounds walls panning
// to an NSW-centred box (firm edges, no elastic drag past them) whose east edge grazes New Zealand,
// and minZoom stops zoom-out at roughly eastern-Australia scale. Box centre = the default view centre.
const VIEW_BOUNDS = L.latLngBounds([[-48, 128], [-16, 171]]);   // centred on ~(-32, 149.5) = NSW
const map = L.map('map', {
    preferCanvas: true, renderer: L.canvas({ tolerance: 1.5 }),
    maxBounds: VIEW_BOUNDS, maxBoundsViscosity: 1.0, minZoom: 5
}).setView([-32.0, 149.5], 6);
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

// --- Town/city labelled pins: dedicated pane + one-shot boot fade-in ------------------------------
// The town pins (teardrop markers — townIcon, drawn by nswTownsLayer / cvTownsLayer in init.js) and
// their permanent name labels share THIS pane, so one opacity write covers exactly the labelled
// town/city pins and nothing else. Without it the markers land in the shared markerPane and the
// labels in tooltipPane — right next to the road hover labels, which must not fade. z 620: above
// the road overlay (400) and markerPane (600), below the road hover tooltips (650), connection
// highlights (660) and popups (700).
// The pane is born fully transparent: the pins stay invisible through boot — including all of the
// network reveal — and fade 0 → full opacity ONCE, the moment the reveal finishes drawing the
// regional roads (startTownFade, wired to the reveal's natural end / early cancel, with
// reduced-motion and no-reveal fallbacks). That resting opacity (TOWN_FADE_TARGET) is then their
// STEADY-STATE multiplier for the rest of the session: zoom-driven label swaps, tab switches and
// legend re-toggles all re-add layers into this same pane, so they simply present at it — the fade
// is a boot moment, never repeated.
map.createPane('townPane');
map.getPane('townPane').style.zIndex = 620;
map.getPane('townPane').style.opacity = '0';
const TOWN_FADE_MS = 1200;
const TOWN_FADE_TARGET = '1';   // steady-state pane opacity — the pins settle fully opaque once the boot fade completes
let _townFadeDone = false;        // one-shot latch — later calls (cleanups, fallbacks) are no-ops
function startTownFade() {
    if (_townFadeDone) return;
    _townFadeDone = true;
    // Every reveal-less boot path funnels through here — make sure the outside-NSW wash is shown too
    // (no-op on the normal path, where startMaskFade has already begun the ramp).
    if (typeof ensureMaskShown === 'function') ensureMaskShown();
    const pane = map.getPane('townPane');
    if (!pane) return;
    // Reduced motion: no ramp — the pins simply appear at their resting opacity.
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        pane.style.opacity = TOWN_FADE_TARGET;
        return;
    }
    pane.style.transition = 'none';
    pane.style.opacity = '0';
    // Force the 0 frame to COMMIT before retargeting — without this synchronous reflow the
    // browser can coalesce 0 → full into one style flush and paint the pins visible on frame one.
    void pane.getBoundingClientRect();
    pane.style.transition = 'opacity ' + TOWN_FADE_MS + 'ms cubic-bezier(0.45, 0, 0.55, 1)';   // ease-in-out: gentle start, smooth landing
    pane.style.opacity = TOWN_FADE_TARGET;
}

// The outside-NSW wash + border (nswMaskPane, init.js) fade IN across the boot animations: born
// transparent, they ramp to full opacity as the roads draw and the town pins come up, so the
// spotlight "switches on" in step with everything else instead of being there from the first frame.
let _maskFadeStarted = false;
function startMaskFade(ms) {
    const pane = map.getPane('nswMaskPane');
    if (!pane || _maskFadeStarted) return;
    _maskFadeStarted = true;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) { pane.style.opacity = '1'; return; }
    pane.style.transition = 'none';
    pane.style.opacity = '0';
    void pane.getBoundingClientRect();   // commit the 0 frame before ramping (same forced-reflow trick as the town fade)
    pane.style.transition = 'opacity ' + Math.max(600, ms || 6000) + 'ms linear';   // linear: tracks the roads drawing at a steady pace
    pane.style.opacity = '1';
}
// Reveal-less paths (reduced motion, no strands, loader failsafe): the spotlight must not stay
// invisible — settle it to full now. Idempotent with startMaskFade via the shared latch.
function ensureMaskShown() {
    const pane = map.getPane('nswMaskPane');
    if (!pane || _maskFadeStarted) return;
    _maskFadeStarted = true;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) { pane.style.opacity = '1'; return; }
    pane.style.transition = 'opacity 400ms ease';
    pane.style.opacity = '1';
}

// Legend visibility toggles — clicking a legend item flips its key and re-applies to the map.
// green/orange/red = verdict colours; nltn = green national network; dashed = route-numbered roads;
// towns = town/city pins; boundary = CV LGA outline.
// verdict colours + dashed/towns/boundary, plus the "Highlights" group: c_centre/c_hosp/c_dest/
// c_employ = the on-select connection rings. clip = CV tab only, hide roads outside the LGA outline.
let legendToggles = { green: true, orange: true, red: true, nltn: true, dashed: true, towns: true, boundary: true, clip: false,
    bypass: false, local: true, c_centre: true, c_hosp: true, c_dest: true, c_employ: true,
    fnat: true, fstate: true, freg: true, flocal: true };   // Fresh-assessment category bins

// Cross-criteria (reclassification) test — folded into the State / Regional / Local tabs (there is
// no separate Cross-test tab). state/regional hold the segmented control's active MODE (false = own
// criteria): the State tab re-grades AS Regional ('regional') or AS Nationally Significant
// ('natsig'); the Regional tab AS State ('state'). The Local tab keeps its boolean checkbox — it
// grades the council roads by the Regional connectivity test. Shared optional criteria swap only
// the mandatory gate (State PBS-1 ↔ Regional 19m B-double); the natsig mode reads the per-road
// national-criteria verdict precomputed in nsw_criteria.json. See buildXtest() / setCrossTest().
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

// selectedUnitKey (optional): multi-unit gazetted roads pass ALL the road number's layers plus the
// clicked unit's key — that unit draws purple, sibling units keep the standard blue highlight.
function highlightRoad(layers, sourceLayer, selectedName, selectedUnitKey) {
    if (selectedSource) selectedLayers.forEach(l => selectedSource.resetStyle(l));
    selectedLayers = layers;
    selectedSource = sourceLayer;
    const wanted = String(selectedName || '').trim().toUpperCase();
    const unitKey = selectedUnitKey ? String(selectedUnitKey) : '';
    layers.forEach(function (layer) {
        const p = (layer.feature && layer.feature.properties) || {};
        if (unitKey) {
            const inUnit = roadKeyOf(p) === unitKey;
            layer.setStyle({
                weight: inUnit ? 6.5 : 5,
                opacity: inUnit ? 1 : 0.9,
                color: inUnit ? '#7c3aed' : '#2563eb',
                dashArray: null
            });
            return;
        }
        const name = String(p.road_name || '').trim().toUpperCase();
        const exact = !wanted || name === wanted;
        layer.setStyle({
            weight: exact ? 6.5 : 4,
            opacity: exact ? 1 : 0.62,
            color: exact ? '#2563eb' : '#60a5fa',
            dashArray: null
        });
    });
}

function isSelected(layer) { return selectedLayers.indexOf(layer) !== -1; }

function clearSelectedRoad() {
    clearConnections();
    _lastConnEv = null;
    if (selectedSource) selectedLayers.forEach(l => selectedSource.resetStyle(l));
    selectedLayers = [];
    selectedSource = null;
    hideRoadDistance();     // clear the selected-road distance readout
}

function deselect() {
    clearSelectedRoad();
    // Return to the regular sidebar stats instead of showing the empty detail placeholder
    if (currentTab === 'detail') { backFromDetail(); return; }
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
// A road starts once the growth has crawled to it THROUGH THE NETWORK (Dijkstra network distance
// from Sydney over the strand graph — _revealNetworkDelays), and then draws as ONE continuous
// front sweeping end-to-end from its earliest-reached side (_revealChainRoads strings a road's
// strands nose-to-tail — never two fronts converging mid-road) at its class draw speed — so a
// 200 km highway visibly streams for seconds while a 2 km street pops, tendrils branch at
// junctions, and the front is web-shaped, never a circle. Drawing is INCREMENTAL (each frame
// strokes only the new kilometres; the canvas accumulates), so per-frame cost stays tiny. The real Leaflet vector/marker panes are hidden via
// opacity (hit-testing still works) and restored when the growth completes — the final frame is the
// untouched map, byte-identical. Any pan/zoom mid-growth snaps straight to the finished map.
// Plays ONCE per page load, at boot (hideLoader → revealFromSydney, landing on the Overview) — tab
// switches never animate. Skipped under prefers-reduced-motion. Note: speeds are cinematic
// km-per-SECOND (a literal 300 km/h would take ~4 hours to cross NSW); dashed route-numbered roads
// draw solid while growing.
const REVEAL_ORIGIN = L.latLng(-33.8688, 151.2093);   // Sydney CBD
// Phased by class: Nationally Significant first, then State, then Regional — each phase starts
// once the previous one has REVEAL_PHASE_START of its kilometres drawn, with its own speeds
// (km/s of animation).
const REVEAL_CLASSES = ['nsr', 'state', 'regional'];
const REVEAL_SPEED = {
    nsr:      { spread: 1000, draw: 500 },   // motorway streams: fast and sweeping
    state:    { spread: 500,  draw: 220 },
    regional: { spread: 375,  draw: 155 }    // the detailed fill-in
};
// Verdict-colour pacing on top of the class speeds: green (meets criteria) loads 35% faster,
// orange (meets 1 of 2) 20% faster, red (does not meet) at base speed — within each phase the
// passing roads visibly race ahead. Unknown colours run at base.
const REVEAL_COLOR_BOOST = { '#16a34a': 1.35, '#f59e0b': 1.2, '#dc2626': 1 };
// The REGIONAL lens gets its own pacing: green 50% faster, orange at base speed, and red 15%
// slower than base — the downgrade candidates crawl in last. DORMANT while the reveal is
// boot-only (boot lands on the Overview); it kicks back in if per-tab reveals ever return.
const REVEAL_COLOR_BOOST_REGIONAL = { '#16a34a': 1.5, '#f59e0b': 1, '#dc2626': 0.85 };
// Phase overlap: the fraction of a class's total road-KILOMETRES that must be drawn on screen
// before the next class starts — 0.5 = State starts the moment half of Nat.Sig's km are on the
// map, Regional once half of State's are (1 would be strictly sequential). Progress-based, not
// time-based: chaining makes a class's END time hinge on its single longest chain, so a fraction
// of the end time would land long after the class LOOKS finished.
const REVEAL_PHASE_START = 0.5;
const REVEAL_MAX_MS = 40000;      // hard safety cap on the whole animation
let _revealPanes = null, _revealPending = null, _revealGen = 0;
let _revealRaf = null, _revealCanvas = null;

function _revealCleanup() {
    const ran = !!(_revealRaf || _revealCanvas || _revealPanes);   // a reveal was actually in flight
    if (_revealRaf) { cancelAnimationFrame(_revealRaf); _revealRaf = null; }
    map.off('movestart', _revealCleanup);
    map.off('zoomstart', _revealCleanup);
    if (_revealCanvas) { if (_revealCanvas.parentNode) _revealCanvas.parentNode.removeChild(_revealCanvas); _revealCanvas = null; }
    if (_revealPanes) { _revealPanes.forEach(function (el) { el.style.opacity = ''; }); _revealPanes = null; }
    // The reveal's natural end (Regional is the final class) or its early cancel (pan/zoom
    // mid-growth snaps to the finished map): either way the regional roads are done loading, so
    // the town pins start their one-shot boot fade HERE — AFTER the pane restore above and in the
    // same task, so the restore-to-'' on the town pane can never paint over the fade's 0 → full
    // writes. The leading cleanup call in _revealStart has nothing in flight (ran = false) and
    // must not start the fade before the reveal has even begun.
    if (ran) startTownFade();
}

// Straight-line km between two LatLngs (equirectangular — plenty for animation timing).
function _kmBetween(a, b) {
    const dLat = (b.lat - a.lat) * 111.32;
    const dLon = (b.lng - a.lng) * 111.32 * Math.cos((a.lat + b.lat) * Math.PI / 360);
    return Math.sqrt(dLat * dLat + dLon * dLon);
}

// Collect drawable strands from a vector layer: one strand per polyline part, with container-pixel
// points, cumulative km, and per-class draw duration. `clsOf(layer)` names the strand's phase
// ('nsr' | 'state' | 'regional'); `keyOf(layer)` names its parent ROAD (one road is many layers),
// tagged as s.roadKey. Start delay and orientation are assigned afterwards by _revealNetworkDelays
// (Dijkstra arrivals) + _revealChainRoads (one front per road), then class phase offsets in
// _revealStart.
function _revealStrands(group, clsOf, keyOf, boostTable, out) {
    if (!group || !map.hasLayer(group)) return;
    group.eachLayer(function (l) {
        if (!l.getLatLngs || !l.options) return;
        const o = l.options;
        if (o.stroke === false || !o.weight || o.opacity === 0) return;   // hidden in this lens
        const cls = clsOf(l);
        const roadKey = keyOf(l);
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
            // Orientation + rawDelay are assigned later (network arrivals, then per-road chaining)
            // — the web grows along connections, not as a disc, one front per road.
            out.push({
                pts: pts, cum: cum, len: km, idx: 0, drawn: 0, done: false, cls: cls, roadKey: roadKey,
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

// WEB propagation: growth travels ALONG the network, not as an expanding disc. Build a graph from
// strand endpoints (snapped to ~220m so touching roads connect), run Dijkstra from Sydney-area
// entry nodes, and give every strand its NETWORK distance — it can only begin once the web has
// crawled to it through connected roads. Disconnected islands fall back to penalised straight-line
// distance so they still appear (slightly late) rather than never. Sets the per-endpoint arrivals
// s._dA/s._dB (km of web growth to reach the la/lb ends) plus a provisional strand-alone rawDelay;
// _revealChainRoads then re-times every strand from these arrivals and owns orientation (the old
// per-strand away-from-Sydney flip is superseded by chain orientation).
function _revealNetworkDelays(strands) {
    const nodeKey = function (ll) { return Math.round(ll.lat * 500) + ',' + Math.round(ll.lng * 500); };
    const adj = new Map();
    const addEdge = function (a, b, w) { let e = adj.get(a); if (!e) { e = []; adj.set(a, e); } e.push([b, w]); };
    strands.forEach(function (s) {
        s.na = nodeKey(s.la); s.nb = nodeKey(s.lb);
        addEdge(s.na, s.nb, s.len); addEdge(s.nb, s.na, s.len);
    });
    const dist = new Map(), heap = [];   // binary min-heap of [distanceKm, nodeKey]
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
        s._dA = dA; s._dB = dB;   // arrival (km) at each end — _revealChainRoads picks the entry side
        s.rawDelay = (Math.min(dA, dB) / s.spreadV) * 1000;   // provisional; re-timed by the chaining pass
    });
}

// Reverse a strand in place so it draws from what was its far end: pts/cum flip, and the endpoint
// bookkeeping (la/lb latlngs, na/nb node keys, _dA/_dB arrivals) swaps to stay oriented with them.
function _revealFlipStrand(s) {
    s.pts.reverse();
    const n = s.cum.length, len = s.len, c = new Array(n);
    for (let i = 0; i < n; i++) c[i] = len - s.cum[n - 1 - i];
    s.cum = c;
    let t = s.la; s.la = s.lb; s.lb = t;
    t = s.na; s.na = s.nb; s.nb = t;
    t = s._dA; s._dA = s._dB; s._dB = t;
}

// ONE FRONT PER ROAD (runs AFTER _revealNetworkDelays): arrivals are computed per STRAND, so the
// parts of one road that the web reaches at similar times used to draw from BOTH ends at once —
// two fronts converging mid-road. This pass serializes each road: strands are grouped by parent
// road (s.roadKey, split per reveal class so the class phase offsets added later in _revealStart
// stay uniform across a chain), split into connected components by endpoint proximity (the
// strands' na/nb node keys — the same ~220m snap as the web graph), and each component is re-timed
// as a single chain. The wave ENTERS a component at the strand endpoint with the earliest network
// arrival (s._dA/_dB); the entry strand draws away from that end, and each further strand is
// picked greedily — nearest unvisited endpoint to the current tip, hard-preferring endpoints that
// touch the already-drawn part — and oriented to draw onward from its attach side. A Y-branch
// therefore draws after its stem, growing out of the junction; never two simultaneous fronts
// within a component. rawDelay becomes chainStart + sum of earlier strand durations (chainStart =
// entry arrival → ms by the same formula as before), so draw intervals within a component are
// strictly sequential. Disconnected pieces of one road chain independently from their own
// earliest-reached ends. Speeds and durations are untouched — a road's parts simply draw one
// after another. Tags s._chain (component id) + s._chainOrder (position) for the data probes.
function _revealChainRoads(strands) {
    const groups = new Map();   // 'cls|roadKey' -> that road's strands in this class
    strands.forEach(function (s) {
        const k = s.cls + '|' + s.roadKey;
        let a = groups.get(k); if (!a) { a = []; groups.set(k, a); }
        a.push(s);
    });
    groups.forEach(function (group, gk) {
        // Connected components over shared endpoint nodes (flood fill via a node -> strands index).
        const byNode = new Map();
        group.forEach(function (s, i) {
            [s.na, s.nb].forEach(function (nk) { let a = byNode.get(nk); if (!a) { a = []; byNode.set(nk, a); } a.push(i); });
        });
        const compOf = new Array(group.length);
        let nComp = 0;
        for (let i = 0; i < group.length; i++) {
            if (compOf[i] !== undefined) continue;
            compOf[i] = nComp;
            const stack = [i];
            while (stack.length) {
                const s = group[stack.pop()];
                [s.na, s.nb].forEach(function (nk) {
                    byNode.get(nk).forEach(function (m) { if (compOf[m] === undefined) { compOf[m] = nComp; stack.push(m); } });
                });
            }
            nComp++;
        }
        const comps = new Array(nComp);
        group.forEach(function (s, i) { (comps[compOf[i]] || (comps[compOf[i]] = [])).push(s); });
        comps.forEach(function (comp, ci) {
            // Entry: the endpoint the web reaches FIRST — the single side this piece draws from.
            let eS = comp[0], eB = false, eD = Infinity;
            comp.forEach(function (s) {
                if (s._dA < eD) { eS = s; eB = false; eD = s._dA; }
                if (s._dB < eD) { eS = s; eB = true; eD = s._dB; }
            });
            if (eB) _revealFlipStrand(eS);   // index 0 = the entry end
            let t = (eD / eS.spreadV) * 1000;   // chain start: entry arrival → ms (same formula as before)
            const nodes = new Set([eS.na, eS.nb]);   // node keys the drawn chain has reached
            const seen = new Set([eS]);
            eS.rawDelay = t; t += eS.dur;
            eS._chain = gk + '#' + ci; eS._chainOrder = 0;
            let tip = eS.lb;   // latlng of the current front tip
            for (let done = 1; done < comp.length; done++) {
                // Greedy next strand: nearest unvisited endpoint to the tip; an endpoint that does
                // not touch the drawn part is +1e9 km, so it can only win if the component were
                // ever split (belt-and-braces — components are node-connected by construction).
                let best = null, bB = false, bD = Infinity;
                comp.forEach(function (s) {
                    if (seen.has(s)) return;
                    const da = _kmBetween(tip, s.la) + (nodes.has(s.na) ? 0 : 1e9);
                    const db = _kmBetween(tip, s.lb) + (nodes.has(s.nb) ? 0 : 1e9);
                    if (da < bD) { best = s; bB = false; bD = da; }
                    if (db < bD) { best = s; bB = true; bD = db; }
                });
                if (bB) _revealFlipStrand(best);   // index 0 = the attach side
                seen.add(best);
                best.rawDelay = t; t += best.dur;
                best._chain = eS._chain; best._chainOrder = done;
                nodes.add(best.na); nodes.add(best.nb);
                tip = best.lb;
            }
        });
    });
}

function _revealStart() {
    _revealCleanup();   // cancel any in-flight growth first
    const container = map.getContainer();
    const mapPane = map.getPane('mapPane'); if (!mapPane) { startTownFade(); return; }
    const strands = [];
    const roadCls = function (l) { return (l.feature && l.feature.properties && l.feature.properties.admin_class === 'S') ? 'state' : 'regional'; };
    const nsrCls = function () { return 'nsr'; };
    // Parent-road identity for the one-front-per-road chaining: one road is MANY polyline layers.
    // Graded roads group by road number / name (roadKeyOf — the same key that groups click/hover),
    // NLTN lines by determination route (_natGroup); unkeyed segments stay solo (per-layer stamp).
    // Namespaced per layer group so the NSW and CV-clipped copies of a road never chain together.
    const keyer = function (ns) {
        return function (l) {
            const p = l.feature && l.feature.properties;
            const k = p ? (ns === 'nltn' ? p._natGroup : roadKeyOf(p)) : '';
            return k ? ns + '|' + k : 'lyr|' + L.stamp(l);
        };
    };
    // The Regional lens uses its own verdict-colour pacing; every other view uses the global table.
    const boostTable = (typeof currentTab !== 'undefined' && currentTab === 'regional') ? REVEAL_COLOR_BOOST_REGIONAL : REVEAL_COLOR_BOOST;
    _revealStrands(typeof nswLayer !== 'undefined' ? nswLayer : null, roadCls, keyer('nsw'), boostTable, strands);
    _revealStrands(typeof cvClipLayer !== 'undefined' ? cvClipLayer : null, roadCls, keyer('cv'), boostTable, strands);
    _revealStrands(typeof nltnLayer !== 'undefined' ? nltnLayer : null, nsrCls, keyer('nltn'), boostTable, strands);
    if (!strands.length) { startTownFade(); return; }   // nothing to reveal — the pins must not stay hidden
    _revealNetworkDelays(strands);   // Dijkstra: web-shaped per-endpoint arrivals (s._dA/_dB)
    _revealChainRoads(strands);      // serialize each road: ONE front, entering at its earliest-reached end
    // Overlapped class sequencing, PROGRESS-based: each class starts at the moment the previous
    // one has REVEAL_PHASE_START of its total road-KILOMETRES on screen (half of Nat.Sig's km
    // drawn → State begins; half of State's → Regional). Time-based ("50% of the class's end
    // time") stopped meaning that once chaining serialized each road: a class's END is dominated
    // by its single longest chain, so most of it looks finished long before. Per class we find
    // T50 = the smallest t (in the class's own rawDelay timeline) where the summed drawn km —
    // each strand drawing linearly from rawDelay to rawDelay+dur — reaches the fraction; that sum
    // is monotonic in t, so a binary search over [0, clsEnd] nails it. Classes absent from this
    // lens cost nothing. Since a chain is class-pure, adding one phase offset to all its strands
    // keeps it sequential.
    let phaseOffset = 0;
    REVEAL_CLASSES.forEach(function (cls) {
        const clsStrands = [];
        let clsEnd = 0, totalKm = 0;
        strands.forEach(function (s) {
            if (s.cls !== cls) return;
            s.delay = phaseOffset + s.rawDelay;
            clsStrands.push(s);
            totalKm += s.len;
            clsEnd = Math.max(clsEnd, s.rawDelay + s.dur);
        });
        if (!clsStrands.length || !(totalKm > 0)) return;   // no strands → contributes no offset
        const targetKm = totalKm * REVEAL_PHASE_START;
        const drawnKm = function (t) {   // km on screen at t: linear ramp per strand (dur 0 = instant)
            let km = 0;
            for (let i = 0; i < clsStrands.length; i++) {
                const s = clsStrands[i];
                if (t <= s.rawDelay) continue;
                km += s.dur > 0 ? Math.min(1, (t - s.rawDelay) / s.dur) * s.len : s.len;
            }
            return km;
        };
        let lo = 0, hi = clsEnd;
        for (let i = 0; i < 40; i++) {
            const mid = (lo + hi) / 2;
            if (drawnKm(mid) >= targetKm) hi = mid; else lo = mid;
        }
        phaseOffset += hi;   // T50: the previous classes' offsets already sit in s.delay above
    });
    // Hide the real vector/marker panes (opacity keeps hit-testing alive) and draw over the tiles.
    _revealPanes = Array.prototype.filter.call(mapPane.children, function (el) {
        return el.classList.contains('leaflet-pane') && !el.classList.contains('leaflet-tile-pane')
            && !el.classList.contains('leaflet-nswMaskPane-pane');   // the spotlight washes the tiles + fades on its own timeline
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
    // Fade the outside-NSW wash + border IN across the whole boot: it starts now (with the first roads)
    // and lands when the town pins finish — reveal end (the last strand's delay+dur) plus the pin fade —
    // so the spotlight switches on in step with the roads loading and the pins coming up.
    let _revealEnd = 0;
    for (let i = 0; i < strands.length; i++) _revealEnd = Math.max(_revealEnd, strands[i].delay + strands[i].dur);
    startMaskFade(_revealEnd + TOWN_FADE_MS);
    map.on('movestart', _revealCleanup);
    map.on('zoomstart', _revealCleanup);
}

function revealFromSydney() {
    // Reduced motion skips the reveal AND the town-pin ramp — the pins appear at their resting opacity
    // right now, with the app ready underneath.
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) { startTownFade(); return; }
    const gen = ++_revealGen;   // a newer call supersedes any pending start from an older one
    let started = false;
    const start = function () { if (started || gen !== _revealGen) return; started = true; _revealStart(); };
    // Boot's initial fitBounds (showNSW) can still be animating when the loader fades — wait for
    // the view to settle so the web is computed against the final geometry; otherwise begin on the
    // next frame.
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
// IDEMPOTENT — safe to call from any milestone (normal boot, the load-failure catch, the 12s
// failsafe below): only the first call does anything, so the fade / count-up / reveal can never
// double-fire.
let _loaderHidden = false;
function hideLoader() {
    if (_loaderHidden) return;
    _loaderHidden = true;
    const l = document.getElementById('loader');
    if (!l) return;
    const minShow = 3000;   // >= the loader artwork's full choreography (outline 1.4s, six routes chain
                            // in .55s-2.55s — amber/red primaries draw deliberately slowly, 1.5s/1.7s —
                            // last terminus dot finishes 3.0s, Sydney hub ring ripples 1.6s-2.5s)
    const elapsed = performance.now() - loadStart;
    const fade = () => {
        const bf = document.getElementById('loader-bar-fill'); if (bf) bf.style.width = '100%';
        const st = document.getElementById('loader-status'); if (st) st.textContent = 'Ready';
        // .loaded fades the overlay AND sets visibility:hidden + pointer-events:none (CSS), so a
        // faded loader can never sit invisibly over the app swallowing clicks…
        l.classList.add('loaded');
        // …and shortly after the .5s fade completes, the node leaves the DOM entirely.
        setTimeout(function () { if (l.parentNode) l.parentNode.removeChild(l); }, 700);
        document.body.classList.add('is-ready');
        _countUpStats();
        // Revamp: as the loader fades, the network blooms outward from Sydney.
        if (typeof revealFromSydney === 'function') revealFromSydney();
        // Belt-and-braces for the town-pin boot fade: the reveal owns starting it (its cleanup /
        // skip paths above), but if the reveal never gets going for ANY reason the pins must not
        // be stuck invisible. A healthy reveal is visibly running well before 5s (it defers at
        // most ~1.6s for the boot fitBounds to settle) — if by then neither its rAF loop nor its
        // canvas exists, fade now. Already faded → startTownFade is a no-op.
        setTimeout(function () { if (!_revealRaf && !_revealCanvas) startTownFade(); }, 5000);
    };
    if (elapsed < minShow) setTimeout(fade, minShow - elapsed);
    else fade();
}
// FAILSAFE — the loader can never hang over the app: if a data fetch stalls (neither resolving
// nor rejecting, so init.js never reaches hideLoader) force the fade after 12s. On a normal boot
// the real hideLoader call wins the race and this timer is a no-op (idempotent guard above).
setTimeout(hideLoader, 12000);

// IPWEA brand mark (sidebar top-left): a physics spinner easter egg. Each click flicks the logo
// with an angular impulse (+1080°/s, capped at 7200°/s), so rapid clicks wind it up. The spin
// HOLDS its current speed for 1 second after every click; only once a full second passes with no
// clicks does exponential friction (it keeps 25% of its speed per second) kick in, coasting it
// down until it's imperceptibly slow (<6°/s), where the loop stops and the inline transform is
// left EXACTLY as it is — the logo rests wherever momentum dies, a different orientation every
// time. `angle` is cumulative and never reset: there is deliberately no snap-back-to-upright code
// path. dt is clamped at 50ms so a background-tab refocus can't teleport-spin it.
// Dark mode: EXACTLY 5 clicks inside a 3-second window (anchored at the burst's first click)
// toggles body.dark-mode (see the Dark mode section of the CSS) when the window closes — 4 or
// fewer do nothing, and 6+ deliberately cancels the toggle, so the ~3s wait is what makes
// over-clicking detectable. Spin momentum is counted for every click regardless of the burst; under
// prefers-reduced-motion clicks still count toward the burst, the mark just doesn't rotate.
(function () {
    const mark = document.querySelector('.brand-mark');
    if (!mark) return;
    let angle = 0;                            // cumulative rotation, deg — mod 360 is the rest pose
    let vel = 0;                              // angular velocity, deg/s
    let rafId = null, lastT = null, lastClick = -Infinity, burstTimer = null, burstCount = 0;
    function loop(t) {
        if (lastT === null) { lastT = t; rafId = requestAnimationFrame(loop); return; }   // no first-frame dt spike
        const dt = Math.min((t - lastT) / 1000, 0.05);
        lastT = t;
        angle += vel * dt;
        if (t - lastClick > 1000) vel *= Math.pow(0.25, dt);   // 1s clickless hold, then a silky coast
        mark.style.transform = 'rotate(' + angle + 'deg)';
        if (vel < 6) { cancelAnimationFrame(rafId); rafId = null; return; }   // settled: rest right here
        rafId = requestAnimationFrame(loop);
    }
    mark.addEventListener('click', function () {
        if (burstTimer === null) {            // first click of a burst: open a single 3s window
            burstCount = 1;
            burstTimer = setTimeout(function () {
                if (burstCount === 5) {       // exactly 5 — never 4, never 6+
                    const dark = document.body.classList.toggle('dark-mode');
                    if (typeof showMapRefresh === 'function') showMapRefresh(dark ? 'Dark mode on' : 'Light mode', 1400);
                }
                burstTimer = null; burstCount = 0;   // next click starts a fresh window
            }, 3000);
        } else burstCount++;
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        lastClick = performance.now();        // same timebase as the rAF timestamp
        vel = Math.min(vel + 1080, 7200);
        if (rafId === null) { lastT = null; rafId = requestAnimationFrame(loop); }
    });
})();

// Page-reload button (fixed, bottom-right of the viewport, 8px above the #mw-scale widget —
// #page-reload in index.html): a plain full refresh, nothing clever.
(function () {
    const btn = document.getElementById('page-reload');
    if (!btn) return;
    btn.addEventListener('click', function () { location.reload(); });
})();
