// state.js — Leaflet map instance, shared mutable state, selection + loader + town-label control.

// Map setup
const map = L.map('map', { preferCanvas: true }).setView([-32.0, 149.5], 6);
// Drop the "Leaflet" branding watermark from the attribution box (keep the © OSM / © CARTO data
// credit — required by the basemap tile terms).
map.attributionControl.setPrefix(false);

// PDF-style basemap: CARTO Voyager (no labels) = warm/cream land, blue water, muted grey roads —
// close to the NLTN Determination 2020 map. A mild warm CSS filter (see .leaflet-tile-pane in the
// CSS) nudges the land further toward the PDF's cream. The dashboard draws its own town labels.
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OSM &copy; CARTO', maxZoom: 19
}).addTo(map);

let nswLayer, nswTownsLayer, cvLayer, cvBoundaryLayer, cvTownsLayer, nltnLayer;

// Shared canvas renderer for the State/Regional/CV road overlays, with a click tolerance so the
// selection hitbox is ~25% larger than the drawn line (a 1.5px buffer ≈ 25% of the 6px selection
// stroke). Roads become easier to click without changing how thin the lines look. Keep the default
// render padding (0.1) — a larger buffer redraws far more of the canvas on every zoom and lags.
const roadRenderer = L.canvas({ tolerance: 1.5 });

// Dedicated pane for the NLTN 2020 reference network. It sits ABOVE the road overlay (z-index 400)
// and uses an SVG renderer so the green lines (incl. proposed corridors) stay hoverable/clickable,
// while clicks on empty areas pass THROUGH to the graded roads underneath (canvas would swallow them).
map.createPane('nltnPane');
map.getPane('nltnPane').style.zIndex = 450;
const nltnRenderer = L.svg({ pane: 'nltnPane' });

// --- Connectivity highlights ---------------------------------------------------------------
// When a road is selected, ring + label every entity it connects (the evidence behind its
// criteria): town centres, major hospitals, ports / airports / intermodals. The ring is the
// ~connection radius (the "perimeter" the criteria test against). Lives in its own pane on top.
map.createPane('connPane');
map.getPane('connPane').style.zIndex = 660;   // above road/marker panes, below popups
const connRenderer = L.svg({ pane: 'connPane' });   // SVG so rings draw even with preferCanvas
const connLayer = L.layerGroup();
const CONN_STYLE = {
    town: { color: '#1d4ed8', radius: 2200, glyph: '' },
    sua:  { color: '#1d4ed8', radius: 0,    glyph: '◍' },
    hosp: { color: '#dc2626', radius: 1600, glyph: 'H' },
    dest: { color: '#7c3aed', radius: 2200, glyph: '★' }
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
function showConnections(ev) {
    clearConnections();
    if (!ev) return;
    // Centres: a mix of town points (ring + pin) and urban areas (boundary outline + pin).
    (ev.centres || []).forEach(function (e) {
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
    ['hosp', 'dest'].forEach(function (kind) {
        const items = kind === 'hosp' ? ev.hospitals : ev.dests;
        const s = CONN_STYLE[kind];
        (items || []).forEach(function (e) {
            L.circle([e.lat, e.lon], { pane: 'connPane', renderer: connRenderer, radius: s.radius, color: s.color, weight: 1.5,
                opacity: 0.65, fillColor: s.color, fillOpacity: 0.07, interactive: false }).addTo(connLayer);
            connMarker(e, kind).addTo(connLayer);
        });
    });
    if (!map.hasLayer(connLayer)) connLayer.addTo(map);
}
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
let legendToggles = { green: true, orange: true, red: true, nltn: true, dashed: true, towns: true, boundary: true };

let currentTab = 'overview';

let lastViewTab = 'overview';   // last view tab before opening Road Detail (for the Back button)

let nswView = 'all';        // active NSW lens: 'all' | 'nsr' | 'state' | 'regional'

let NSW_AGG = {};           // per-road rolled-up aggregate (set during load), used for lens counts

let NSW_SEG_TOTAL = 0;      // total assessed road segments (features) — shown alongside the road count

let mapContext = null;      // 'nsw' | 'cv' — only refit the map when this changes, not on every tab switch

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
    if (!selectedLayers.length) return;
    if (selectedSource) selectedLayers.forEach(l => selectedSource.resetStyle(l));
    selectedLayers = [];
    selectedSource = null;
    const c = document.getElementById('detail-content'); if (c) c.style.display = 'none';
    const e = document.getElementById('detail-empty'); if (e) e.style.display = '';
}

map.on('click', deselect);  // clicking off any road clears the selection

function updateTownLabels() {
    map.getContainer().classList.toggle('labels-on', map.getZoom() >= LABEL_ZOOM);
}

map.on('zoomend', updateTownLabels);

// Hide the loading screen once the constant-speed bar has reached 100%
function hideLoader() {
    const l = document.getElementById('loader');
    if (!l) return;
    const minShow = 1200;
    const elapsed = performance.now() - loadStart;
    const fade = () => l.classList.add('loaded');
    if (elapsed < minShow) setTimeout(fade, minShow - elapsed);
    else fade();
}
