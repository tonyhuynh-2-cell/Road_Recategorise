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
    };
    if (elapsed < minShow) setTimeout(fade, minShow - elapsed);
    else fade();
}
