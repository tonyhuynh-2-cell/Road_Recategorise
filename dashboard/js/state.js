// state.js — Leaflet map instance, shared mutable state, selection + loader + town-label control.

// Map setup
const map = L.map('map', { preferCanvas: true }).setView([-32.0, 149.5], 6);

// PDF-style basemap: CARTO Voyager (no labels) = warm/cream land, blue water, muted grey roads —
// close to the NLTN Determination 2020 map. A mild warm CSS filter (see .leaflet-tile-pane in the
// CSS) nudges the land further toward the PDF's cream. The dashboard draws its own town labels.
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OSM &copy; CARTO', maxZoom: 19
}).addTo(map);

let nswLayer, nswTownsLayer, cvLayer, cvBoundaryLayer, cvTownsLayer, nltnLayer;

// Dedicated pane BELOW the road overlay so the NLTN 2020 reference underlay (Nat. Significant
// lens) draws under the coloured roads. overlayPane sits at z-index 400.
map.createPane('nltnPane');
map.getPane('nltnPane').style.zIndex = 350;
const nltnRenderer = L.canvas({ pane: 'nltnPane' });

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
