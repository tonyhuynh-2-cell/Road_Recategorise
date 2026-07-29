# Road Recategorise: Plain-English Feature And Code Walkthrough

This document explains what the software does, how it gets it done in code, and shows a short code snippet for each major feature or processing capability.

The project has two main parts:

- Data preparation scripts in `dashboard/*.py`, which turn road, traffic, town, facility, NHVR, NLTN and geometry data into small dashboard-ready JSON/GeoJSON files.
- The browser dashboard in `dashboard/index.html` and `dashboard/js/*.js`, which loads those prepared files and turns them into maps, criteria panels, search, exports, local-road tools and review workflows.

The snippets below are intentionally short. They show the core idea, not every defensive branch in the real code.

## 1. Dashboard Data Loading

What it is:

The dashboard loads all prepared data files in parallel before drawing the map. These files include NSW roads, criteria results, traffic, NHVR access, road topology, towns, evidence and boundaries.

What the code does:

`dashboard/js/init.js` builds a cache-busted URL, fetches every JSON/GeoJSON file, updates the loading bar after each file finishes, then stores important datasets on `window` so the other modules can use them.

Key files:

- `dashboard/js/init.js`
- `dashboard/data/*.json`
- `dashboard/data/*.geojson`

Snippet:

```js
const _bust = '?v=' + Date.now();
const _f = u => fetch(u + _bust)
    .then(r => r.json())
    .then(j => { _loadTick(); return j; });

Promise.all([
    _f('data/nsw_assessment.geojson'),
    _f('data/nsw_criteria.json'),
    _f('data/nsw_evidence.json'),
    _f('data/nhvr_networks.json'),
    _f('data/nsw_road_ext.json'),
    _f('data/nsw_adt.json')
]).then(([nswRoads, nswCrit, nswEvid, nhvr, roadExt, adt]) => {
    window.NSW_CRIT = nswCrit || {};
    window.NSW_EVID = nswEvid || {};
    window.NHVR = nhvr || {};
    window.ROAD_EXT = roadExt || {};
    window.ADT = adt || {};
});
```

## 2. Leaflet Map Setup

What it is:

The app uses Leaflet to display the road network, boundaries, labels, connection highlights, national routes and local roads.

What the code does:

`dashboard/js/state.js` creates one main map, sets a NSW-centred view, adds a CARTO basemap, and creates separate panes for things that need different draw order or click behaviour.

Key files:

- `dashboard/js/state.js`
- `dashboard/js/panels.js`
- `dashboard/js/grading.js`

Snippet:

```js
const map = L.map('map', {
    preferCanvas: true,
    renderer: L.canvas({ tolerance: 1.5 }),
    maxBounds: VIEW_BOUNDS,
    maxBoundsViscosity: 1.0,
    minZoom: 5
}).setView([-32.0, 149.5], 6);

L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OSM &copy; CARTO',
    maxZoom: 19
}).addTo(map);
```

## 3. Road Grouping

What it is:

One named road is usually made of many line segments. The software groups those segments so selecting a road highlights the whole road, not just one small segment.

What the code does:

`roadKeyOf()` creates a stable key from `road_number` or road name. `init.js` uses that key to roll segment data up into one per-road aggregate.

Key files:

- `dashboard/js/utils.js`
- `dashboard/js/init.js`

Snippet:

```js
function roadKeyOf(p) {
    const n = (p.road_number != null && String(p.road_number).trim() !== '')
        ? String(p.road_number).trim()
        : '';
    return n || (p.road_name ? 'n:' + String(p.road_name).trim().toLowerCase() : '');
}

nswRoads.features.forEach(f => {
    const k = roadKeyOf(f.properties);
    const a = nswRoadAgg[k] || (nswRoadAgg[k] = Object.assign({}, f.properties, {
        status: 'red',
        _len: 0,
        _byStatus: { red: 0, orange: 0, green: 0 },
        _names: []
    }));
    a._len += roadLenKm(f.geometry);
});
```

## 4. Road Length And Visual Weighting

What it is:

Longer roads draw slightly thicker than short roads, so the map is easier to read.

What the code does:

`roadLenKm()` estimates line length from coordinates. `weightForKm()` converts length into a stroke width.

Key files:

- `dashboard/js/utils.js`
- `dashboard/js/init.js`

Snippet:

```js
function roadLenKm(g) {
    let L = 0;
    const run = c => {
        for (let i = 1; i < c.length; i++) {
            const a = c[i - 1], b = c[i];
            const m = (a[1] + b[1]) / 2 * Math.PI / 180;
            const dx = (b[0] - a[0]) * Math.cos(m);
            const dy = b[1] - a[1];
            L += Math.sqrt(dx * dx + dy * dy) * 111.32;
        }
    };
    if (g.type === 'LineString') run(g.coordinates);
    else if (g.type === 'MultiLineString') g.coordinates.forEach(run);
    return L;
}

function weightForKm(km) {
    return Math.max(1.0, Math.min(4.0, 0.75 + Math.log10(1 + km) * 1.05));
}
```

## 5. Criteria Verdict Colours

What it is:

Roads are coloured by assessment result:

- Green: meets criteria
- Orange: likely / one optional criterion
- Red: does not meet

What the code does:

`dashboard/js/grading.js` decides if a feature should be visible in the current lens, then chooses the verdict colour.

Key files:

- `dashboard/js/config.js`
- `dashboard/js/grading.js`

Snippet:

```js
const ROAD_COLORS = { green: '#16a34a', orange: '#f59e0b', red: '#dc2626' };

function nswStyle(feature) {
    const p = feature.properties;
    if (!nswInView(p)) return HIDDEN_STYLE;

    let v = p._roadStatus || p.status;
    if (!legendToggles[v]) return HIDDEN_STYLE;

    return {
        stroke: true,
        color: ROAD_COLORS[v] || '#a8a29e',
        weight: p._w || 2,
        opacity: v === 'red' ? 0.85 : 1,
        lineCap: 'round',
        lineJoin: 'round'
    };
}
```

## 6. Map Lenses And Tabs

What it is:

The dashboard has several map views: overview, Nationally Significant, State Roads, Regional Roads, Sydney, Clarence Valley, Flagged roads and Local roads.

What the code does:

`switchTab()` updates the active sidebar panel, updates the map lens, refreshes summary numbers, shows the right layers and rebuilds the floating legend.

Key files:

- `dashboard/index.html`
- `dashboard/js/panels.js`
- `dashboard/js/grading.js`

Snippet:

```js
function switchTab(tab) {
    currentTab = tab;

    const contentId = (tab === 'overview')
        ? 'overview'
        : NSW_LENSES.includes(tab) ? 'nsw' : tab;
    document.getElementById(`tab-${contentId}`).classList.add('active');

    if (NSW_MAP_TABS.includes(tab)) {
        nswView = (tab === 'overview') ? 'all' : tab;
        if (tab === 'overview') refreshOverview();
        else refreshNswView();
        showNSW();
    } else if (tab === 'cv') {
        refreshCV();
        showCV();
    } else if (tab === 'local') {
        refreshLocal();
        showLocal();
    }

    renderMapLegend();
}
```

## 7. Layer Visibility And Legend Toggles

What it is:

The map legend is interactive. Users can hide/show verdict colours, route-numbered roads, town pins, boundaries, connection highlights, HV bypass halos and local labels.

What the code does:

`legendToggles` stores the current on/off state. `applyLegend()` adds, removes or restyles layers according to the current tab and those toggles.

Key files:

- `dashboard/js/state.js`
- `dashboard/js/panels.js`

Snippet:

```js
let legendToggles = {
    green: true,
    orange: true,
    red: true,
    nltn: true,
    dashed: true,
    towns: true,
    boundary: true,
    clip: false,
    bypass: false,
    local: true,
    c_centre: true,
    c_hosp: true,
    c_dest: true,
    c_employ: true
};

function applyLegend(opts) {
    const cvClip = currentTab === 'cv' && legendToggles.clip;
    const hideNsw = cvClip || currentTab === 'local' || nswView === 'nsr';

    if (nswLayer) {
        if (hideNsw) map.removeLayer(nswLayer);
        else {
            map.addLayer(nswLayer);
            nswLayer.setStyle(nswStyle);
        }
    }
}
```

## 8. Road Detail Panel

What it is:

When the user clicks a road, the dashboard opens a detail panel showing the road name, classification, result, traffic, mandatory criteria, optional criteria, vehicle access and connectivity evidence.

What the code does:

`showRoadDetail()` gathers the road aggregate, criteria row, NHVR record, traffic record, topology flags and evidence lists. It then builds the panel HTML.

Key files:

- `dashboard/js/detail.js`
- `dashboard/js/utils.js`

Snippet:

```js
function showRoadDetail(p, source) {
    const key = roadKeyOf(p);
    const c = window.NSW_CRIT ? window.NSW_CRIT[key] : null;
    const nh = (window.NHVR || {})[key] || {};
    const rx = (window.ROAD_EXT || {})[key] || {};
    const ad = (window.ADT || {})[key] || null;
    const evd = (window.NSW_EVID || {})[key] || {};

    document.getElementById('detail-road-name').innerHTML = roadLabel(p);
    showConnections({
        centres: evd.centres || [],
        hospitals: evd.hospitals || [],
        dests: evd.dests || [],
        employment: evd.employment || []
    });
}
```

## 9. "To Fully Meet" Criteria Chips

What it is:

The detail result tells the user which criteria are still preventing a road from fully meeting the category.

What the code does:

The code collects failing or unknown mandatory criteria and optional criteria. If the optional quota is already met, it does not list extra optional criteria as things still needed.

Key files:

- `dashboard/js/detail.js`
- `dashboard/js/utils.js`

Snippet:

```js
const mandatoryRefs = [], optionalRefs = [];

const addCriterionRef = function (refs, state, code, anchor, label) {
    if (state === true) return;
    refs.push({ state: state, code: code, anchor: anchor, label: label });
};

const optionalQuotaMet = ownOptionalPasses !== null && ownOptionalPasses >= 2;
const criterionRefs = mandatoryRefs.concat(optionalQuotaMet ? [] : optionalRefs);
```

## 10. Traffic And Heavy-Vehicle Thresholds

What it is:

The rebuild imports the newest completed-year measured traffic count for each
matched road. The detail panel shows that evidence and checks traffic volume and
heavy-vehicle percentage against the correct State/Regional and urban/rural
thresholds.

What the code does:

`rebuild_adt.py` rejects partial/current-year observations, combines directional
counts, pairs heavy vehicles to the same station/year and matches counters to
road units. It also applies the traffic result to the generated criteria and
verdict. `detail.js` reproduces the same calculation for display. If
heavy-vehicle percentage is missing, the traffic criterion is not treated as a
clean pass.

Key files:

- `dashboard/js/detail.js`
- `dashboard/rebuild_adt.py`
- `dashboard/rebuild_road_units.py`
- `dashboard/data/nsw_adt.json`

Snippet:

```js
const effState = xtMode === 'state' ? true : xtMode === 'regional' ? false : isState;
const adtThr = effState ? (urbanArea ? 10000 : 7000) : (urbanArea ? 7000 : 2000);
const hvThr = effState ? 8 : 6;

const aadtPass = ad ? ad.aadt > adtThr : null;
const hvPass = ad && ad.hv_pct != null ? ad.hv_pct > hvThr : null;
const trafficPass = ad
    ? (aadtPass === true && hvPass === true ? true
        : (aadtPass === false || hvPass === false ? false : null))
    : null;
```

## 11. Connectivity Evidence Highlights

What it is:

When a road is selected, the map highlights the towns, urban areas, hospitals, ports, airports, intermodals and employment centres that explain its criteria result.

What the code does:

`showConnections()` reads the selected road's evidence data and draws rings, labels and markers in a dedicated Leaflet pane.

Key files:

- `dashboard/js/state.js`
- `dashboard/js/utils.js`
- `dashboard/data/nsw_evidence.json`

Snippet:

```js
function showConnections(ev) {
    clearConnections();
    _lastConnEv = ev || null;
    if (!ev) return;

    if (legendToggles.c_centre) {
        (ev.centres || []).forEach(function (e) {
            L.circle([e.lat, e.lon], {
                pane: 'connPane',
                renderer: connRenderer,
                radius: CONN_STYLE.town.radius,
                color: CONN_STYLE.town.color
            }).addTo(connLayer);
            connMarker(e, 'town').addTo(connLayer);
        });
    }
}
```

## 12. Cross-Criteria Reclassification Tests

What it is:

The app can ask: "What if this State road were tested as Regional?" or "What if this Regional road were tested as State?"

What the code does:

`buildXtest()` recomputes optional counts and mandatory gates for the target category. It does not force a result; it regrades using the available data.

For Regional roads tested as State roads, the State-only long-distance rural route criterion is read from `stateOpt.ldr`. That keeps the road's own Regional `optMet` clean while still allowing the State cross-test to score the unnumbered State LDR criterion.

The LDR criterion is not a length-only shortcut. The rebuild checks that a non-urban road has a connected geometry component of at least 25 km, with evidence for both a State-tier source centre and a Town Centre on that same component.

For urban State roads, LDR is cleared as not applicable because the urban criteria table uses S-10, S-11, traffic and mandatory PBS/parallel checks, not the rural LDR item.

Key files:

- `dashboard/js/grading.js`
- `dashboard/js/config.js`
- `dashboard/js/detail.js`
- `dashboard/rebuild_state_ldr_optional.py`

Snippet:

```js
function xverdict(optMet, mandPass) {
    return !mandPass ? 'red' : optMet >= 2 ? 'green' : optMet === 1 ? 'orange' : 'red';
}

function buildXtest() {
    const X = {}, crit = window.NSW_CRIT || {}, nhvr = window.NHVR || {}, roadExt = window.ROAD_EXT || {};

    for (const k in crit) {
        const c = crit[k];
        const ldrOpt = c.area !== 'urban' && (
            (c.opt && c.opt.ldr === true) ||
            (c.stateOpt && c.stateOpt.ldr === true)
        );
        const asStateOptMet = countOpt(c, ['centres', 'dest', 'traffic']) + (ldrOpt ? 1 : 0);
        const twoStateOpt = c.area !== 'urban' && (
            (c.opt && c.opt.two_state === true) ||
            (roadExt[k] && roadExt[k].two_state === true)
        );
        const asRegionalOptMet = countOpt(c, ['centres', 'dest', 'hv']) + (twoStateOpt ? 1 : 0);

        X[k] = {
            asState: xverdict(asStateOptMet, c.mand && c.mand.pbs1 === true),
            asReg: xverdict(asRegionalOptMet, nhvr[k] && nhvr[k].bdouble19 === true)
        };
    }
    return X;
}
```

The LDR value is generated from length, centre evidence and connected geometry:

```python
qualifying = [
    comp for comp in comps
    if comp["km"] >= 25.0 and comp["source"] and comp["town"]
]

info = {
    "ldr": bool(qualifying),
    "ldr_km": round(total_km, 1),
    "ldr_component_km": round(best_component_km, 1),
    "ldr_source_centres": sorted(best_source_centres),
    "ldr_town_centres": sorted(best_town_centres),
}
```

Regional facility connectivity is assessed separately from the State facility
criterion. R-02/R-06 can use named hospitals, ports, airports and intermodals,
as well as employment centres that meet the client-approved size-only threshold
for the road zone: Urban 40 ha, Regional 15 ha or Remote 5 ha. Economic value and
legacy tier labels are not scoring inputs. The rebuild requires a qualifying
facility and a qualifying centre to occur on the same connected road component,
so a disconnected road-number group cannot earn the criterion by combining
evidence from different pieces of geometry.

When a size-qualified employment polygon does not directly intersect the
categorised road, `regional_employment_access.py` can still establish the
connection through ordinary access streets. The polygon must be within 1.5 km
of the assessed road and the NSW Road Segment network must contain a continuous
path no longer than 2 km. This is a shortest-path topology test, not a larger
display buffer.

```python
path_m = shortest_access_path(route_geometry, employment_polygon, local_segments)

item["network_access"] = path_m is not None and path_m <= 2_000
item["network_access_m"] = round(path_m) if path_m is not None else None
```

```python
qualifying = [
    component for component in components
    if component["centres"] and component["facilities"]
]

info = {
    "dest": bool(qualifying),
    "dest_centre_names": sorted(best_component["centres"]),
    "dest_facility_names": sorted(best_component["facilities"]),
}
```

The result is stored in `regionalOpt.dest`. Regional roads use it as their own
R-02/R-06 result; State roads use it only when the Regional cross-test is
active. This prevents the State and Regional facility thresholds from being
mixed together.

## 13. Links Two State Roads Topology Feature

What it is:

This is the automated criteria-assessment feature we just added. It checks whether a Regional road links two distinct State roads.

Plain technical term:

It is a geometry-derived topology criterion, or a topology-based assessment feature.

What the code does:

`dashboard/rebuild_two_state_optional.py` groups road geometry by road number, finds Regional road endpoints, checks which State roads those endpoints touch, then marks the Regional road as passing if it touches at least two distinct State roads.

Key files:

- `dashboard/rebuild_two_state_optional.py`
- `dashboard/data/nsw_road_ext.json`
- `dashboard/data/nsw_criteria.json`
- `dashboard/js/detail.js`
- `dashboard/js/grading.js`

Snippet:

```python
computed = {}
for rn, road in roads.items():
    if road["cls"] != "R":
        continue

    touches = {}
    for pt in endpoint_candidates(road["lines"]):
        for state in nearest_state_roads(pt, state_lines):
            touches[state["rn"]] = state

    computed[rn] = {
        "two_state": len(touches) >= 2,
        "touches": sorted(touches.values(), key=lambda row: row["rn"]),
    }
```

The result is then counted as a Regional optional criterion:

```python
for rn, c in crit.items():
    if c["cls"] != "Regional" or c["area"] == "urban":
        continue

    c["opt"]["two_state"] = new_ext.get(rn, {}).get("two_state") is True
    c["optMet"] = opt_met(c)
    c["verdict"] = verdict_of(c, c["optMet"])
```

## 14. NHVR Vehicle Access Assessment

What it is:

The app checks heavy-vehicle network access, including PBS Level 1, PBS 2B, 19m B-double and road-train networks.

What the code does:

`rebuild_pbs1_network.py` and `rebuild_bdouble_network.py` filter the relevant
NHVR GeoPackages to approved routes and measure how much of each source road
line follows the network within 50 m for PBS Level 1 and 100 m for B-double.
`rebuild_road_units.py` then rolls those fractions up by length and applies the
mandatory gate only at 80% coverage or greater. This prevents a crossing or
short shared section from approving an entire road.

Key files:

- `dashboard/rebuild_from_nhvr.py`
- `dashboard/rebuild_pbs1_network.py`
- `dashboard/rebuild_bdouble_network.py`
- `dashboard/rebuild_road_units.py`
- `dashboard/rebuild_r03_roadtrain_optional.py`
- `dashboard/data/nhvr_networks.json`
- `dashboard/data/nsw_criteria.json`

Snippet:

```python
def classify(network_name):
    n = network_name.lower()
    if "pbs" in n and "level 1" in n:
        return "pbs1"
    if "pbs" in n and "2b" in n:
        return "pbs2b"
    if "b-double" in n or "b double" in n:
        return "bdouble"
    if "road train" in n:
        return "roadtrain"
    return None

def on_network(roads, seg_gdf):
    rb = gpd.GeoDataFrame(geometry=roads.geometry.buffer(BUF), crs=roads.crs)
    j = gpd.sjoin(rb, seg_gdf, predicate="intersects", how="inner")
    return roads.index.isin(j.index.unique())
```

## 15. Nationally Significant Network Layer

What it is:

The Nat. Significant tab displays the National Land Transport Network and grades it by national criteria.

What the code does:

The app loads `nltn_2020_road.geojson`, joins it with precomputed metadata, and styles it separately from the State/Regional road overlay.

Key files:

- `dashboard/js/init.js`
- `dashboard/js/grading.js`
- `dashboard/data/nltn_2020_road.geojson`
- `dashboard/data/nltn_meta.json`
- `dashboard/data/nltn_evidence.json`

Snippet:

```js
function nltnFeatureStyle(feature) {
    const p = (feature && feature.properties) || {};
    const v = p._natCat || 'orange';

    if (!legendToggles[v]) return HIDDEN_STYLE;

    return {
        stroke: true,
        color: ROAD_COLORS[v] || '#16a34a',
        weight: 5,
        opacity: p._proposed ? 0.45 : 0.9,
        lineCap: 'round',
        lineJoin: 'round'
    };
}
```

## 16. Sydney And Clarence Valley Area Views

What it is:

The app can focus on the Sydney urban area or Clarence Valley LGA, showing the same statewide road data filtered/framed to that area.

What the code does:

`init.js` builds point-in-polygon tests from the area boundary. Roads with any vertex inside the boundary are tagged, then `panels.js` uses those tags for stats, map framing and export scopes.

Key files:

- `dashboard/js/init.js`
- `dashboard/js/panels.js`
- `dashboard/data/clarence_valley_boundary.geojson`
- `dashboard/data/sua_outlines.json`

Snippet:

```js
cvInside = function (x, y) {
    if (x < bx0 || x > bx1 || y < by0 || y > by1) return false;

    for (const poly of cvPolys) {
        let inP = false;
        for (const ring of poly) {
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                const xi = ring[i][0], yi = ring[i][1];
                const xj = ring[j][0], yj = ring[j][1];
                if (((yi > y) !== (yj > y)) &&
                    (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi)) {
                    inP = !inP;
                }
            }
        }
        if (inP) return true;
    }
    return false;
};
```

## 17. Road Search

What it is:

The search box finds roads by road name, road ID or route reference, then jumps to the road and opens its detail panel.

What the code does:

`search.js` builds a small in-browser index from the per-road aggregate, scores candidates against the query, shows the top matches, and selects the chosen road.

Key files:

- `dashboard/js/search.js`
- `dashboard/js/init.js`

Snippet:

```js
function _scoreRoad(e, q) {
    const num = e.num.toLowerCase();
    const name = e.name.toLowerCase();
    const ref = e.ref.toLowerCase();

    if (num && num === q) return 100;
    if (ref && ref === q) return 95;
    if (num && num.indexOf(q) === 0) return 90;
    if (name && name.indexOf(q) === 0) return 80;
    if (name && name.indexOf(q) !== -1) return 60;
    return -1;
}

function selectRoadFromSearch(key) {
    const a = NSW_AGG[key];
    const layers = (window.NSW_ROAD_LAYERS || {})[key] || [];
    highlightRoad(layers, nswLayer);
    showRoadDetail(Object.assign({}, a), 'nsw');
}
```

## 18. Flagged Roads

What it is:

Users can flag up to 10 roads and view them together in a dedicated Flagged roads tab.

What the code does:

`flagged.js` stores road keys in `localStorage`, keeps the flag button and list in sync, and reuses the same map styling machinery to show only flagged roads.

Key files:

- `dashboard/js/flagged.js`
- `dashboard/js/detail.js`
- `dashboard/js/grading.js`

Snippet:

```js
const FLAG_LIMIT = 10;
const FLAG_STORE = 'flaggedRoads';
const flaggedRoads = new Set(JSON.parse(localStorage.getItem(FLAG_STORE) || '[]'));

function toggleRoadFlag(k) {
    if (flaggedRoads.has(k)) flaggedRoads.delete(k);
    else {
        if (flaggedRoads.size >= FLAG_LIMIT) return;
        flaggedRoads.add(k);
    }

    localStorage.setItem(FLAG_STORE, JSON.stringify(Array.from(flaggedRoads)));
    refreshFlagged();
    applyLegend();
}
```

## 19. Excel Export

What it is:

The user can export the full assessment, a category, an area, flagged roads, a custom selection, or loaded local roads to an Excel workbook.

What the code does:

`export.js` computes the road keys for the selected scope, filters `export_rows.json`, and uses ExcelJS to build styled worksheets with verdict colours and criteria text.

Key files:

- `dashboard/js/export.js`
- `dashboard/data/export_rows.json`
- `dashboard/js/local.js`

Snippet:

```js
function exportScopeKeys(scope) {
    const agg = NSW_AGG || {};
    const keys = [];

    for (const k in agg) {
        const a = agg[k];
        if (scope === 'all') keys.push(k);
        else if (scope === 'state' && a.admin_class === 'S' && !a._nsr) keys.push(k);
        else if (scope === 'regional' && a.admin_class === 'R') keys.push(k);
        else if (scope === 'sydney' && a._inSyd) keys.push(k);
        else if (scope === 'cv' && a._inCV) keys.push(k);
    }

    return keys;
}
```

## 20. Local Road Loading

What it is:

The Local tab lets the user search a suburb and load council/local roads from OpenStreetMap.

This live suburb view is separate from the statewide Best Fit catalogue described
below. It is useful for quick exploration, but requires internet access and its OSM
road tags do not prove council ownership.

What the code does:

`local.js` resolves the suburb boundary, asks Overpass for local-road ways inside the suburb bounding box, clips those roads to the suburb polygon and draws them as local road vectors.

Key files:

- `dashboard/js/local.js`
- `dashboard/js/suburbs.js`

Snippet:

```js
function loadSuburbResult(g) {
    const bb = g.boundingbox;
    const rings = geojsonRings(g.geojson);

    const q = '[out:json][timeout:60];way["highway"~"' + LOCAL_HW + '"](' +
        (+bb[0]).toFixed(5) + ',' + (+bb[2]).toFixed(5) + ',' +
        (+bb[1]).toFixed(5) + ',' + (+bb[3]).toFixed(5) +
        ');out geom;';

    overpassFetch(q).then(function (data) {
        const res = overpassToClippedGeojson(data, rings);
        localRoadsXLayer.clearLayers();
        localRoadsXLayer.addData(res.fc);
        buildLocalGroups(suburbLabel(g));
    });
}
```

## 20A. Statewide Local Roads in Best Fit

What it is:

Best Fit includes every operational road segment classified `LocalRoad` by the
official NSW Transport Theme, rather than considering only today's State and
Regional roads.

What the code does:

`build_local_road_catalog.py` filters the 1.37-million-segment NSW file to
`operationalstatus=1` and `functionhierarchy=6`, groups connected segments with
the same full name and preserves every unnamed segment. Distinct centres must be
assigned to separate terminal points; a facility must be at one terminal and a
centre at another. A 500 m minimum terminal span prevents tiny segments inside
overlapping evidence catchments from appearing to connect destinations. The
Regional and State mandatory gates are measured against the NHVR 19 m B-double
and PBS Level 1 networks using an 80% route-coverage rule. Approved and
approved-with-conditions geometry is included; a crossing or endpoint touch is
not enough.

The build writes:

- `local_roads_manifest.json` for statewide totals;
- `local_roads_catalog.json.gz` for all per-road audit records;
- `local_road_chunks/*.geojson.gz` for zoom-gated map geometry.

`local.js` calculates the visible 0.25-degree chunks once the displayed map
scale reaches 2 km or closer, decompresses only those files, styles the roads by
Best Fit category and uses nearest-line selection for reliable clicks. The
popup shows each road's measured PBS and B-double coverage. `refreshFresh()`
combines the manifest totals with the existing State/Regional Best Fit
waterfall.

Key files:

- `dashboard/build_local_road_catalog.py`
- `dashboard/test_build_local_road_catalog.py`
- `dashboard/js/local.js`
- `dashboard/js/panels.js`
- `dashboard/js/init.js`

Important interpretation:

`LocalRoad` is the NSW source's functional hierarchy. It is not by itself proof
that a council owns or maintains the road. A confirmed higher category requires
its mandatory network gate and at least two available optional criteria. A
dashed provisional road passes its gate with one optional criterion. Otherwise
it remains Local because the available criteria do not demonstrate a higher
category.

## 21. Local Road Clipping

What it is:

Local roads are clipped to the suburb boundary so roads do not leak outside the searched suburb.

What the code does:

The app converts the suburb polygon into rings, tests each road coordinate against those rings, and keeps only coordinate runs inside the suburb.

Key files:

- `dashboard/js/local.js`

Snippet:

```js
function clipCoordsToRings(coords, rings) {
    const out = [];
    let cur = [];

    for (let i = 0; i < coords.length; i++) {
        if (ringsContain(rings, coords[i][0], coords[i][1])) {
            cur.push(coords[i]);
        } else {
            if (cur.length >= 2) out.push(cur);
            cur = [];
        }
    }

    if (cur.length >= 2) out.push(cur);
    return out;
}
```

## 22. Local Road Cross-Tests

What it is:

Loaded local roads can be indicatively tested as Regional or State roads.

What the code does:

`gradeLocalGroup()` looks at nearby centres and facilities for the live
OpenStreetMap suburb preview. That preview does not join its temporary OSM
geometry to the NHVR mandatory networks, so it is clearly marked indicative.
The statewide Best Fit catalogue is the authoritative local-road assessment and
does measure both NHVR gates.

Key files:

- `dashboard/js/local.js`

Snippet:

```js
function gradeLocalGroup(g, mode) {
    const geoms = g.feats.map(function (f) { return f.geometry; });

    if (mode === 'state') {
        const nc = _nearPtIdx(geoms, xtStateCentrePts(), 1.2).length;
        const fac = xtFacilityPts();
        const fIdx = _nearPtIdx(geoms, fac.pts, 1.2);
        const met = (nc >= 2 ? 1 : 0) + (fIdx.length ? 1 : 0);
        return { v: met >= 2 ? 'green' : met === 1 ? 'orange' : 'red' };
    }

    const n = _nearPtIdx(geoms, xtCentrePts(), 1.2).length;
    return { v: n >= 2 ? 'green' : n === 1 ? 'orange' : 'red', centres: n };
}
```

## 23. Town Pins And Street Labels

What it is:

The app shows town/city pins and can show local street labels when zoomed in.

What the code does:

Town pins come from prepared ABS town data. Street labels are a CARTO label tile layer that turns on only at high zoom.

Key files:

- `dashboard/js/state.js`
- `dashboard/js/local.js`
- `dashboard/js/utils.js`
- `dashboard/data/nsw_towns.geojson`

Snippet:

```js
function localRoadsAllowed() {
    return legendToggles.local &&
        LOCAL_TABS.indexOf(currentTab) !== -1 &&
        map.getZoom() >= LOCAL_ZOOM;
}

function updateLocalRoads() {
    if (localRoadsAllowed()) {
        if (!map.hasLayer(localLabelsLayer)) map.addLayer(localLabelsLayer);
    } else if (map.hasLayer(localLabelsLayer)) {
        map.removeLayer(localLabelsLayer);
    }
}
```

## 24. Code Trace Overlay

What it is:

The floating code trace panel explains what code path ran after a user action, with a small code snippet and context.

What the code does:

`traceCode()` appends a formatted entry to the trace feed and also logs the same information to the browser console.

Key files:

- `dashboard/js/trace.js`
- calls throughout `dashboard/js/*.js`

Snippet:

```js
function traceCode(title, explanation, code, context) {
    if (CODE_TRACE_PAUSED) return;

    const html =
        '<article class="ct-entry">' +
        '<div class="ct-entry-head"><span>' + _traceEsc(title) + '</span></div>' +
        '<p>' + _traceEsc(explanation) + '</p>' +
        '<pre><code>' + _traceEsc(code).trim() + '</code></pre>' +
        '</article>';

    feed.insertAdjacentHTML('beforeend', html);
}
```

## 25. First-Generation Clarence Valley Processor

What it is:

`process_data.py` is the original Clarence Valley criteria engine. It loads road, traffic, NHVR, town and facility data, then grades roads in and around Clarence Valley.

What the code does:

It loads the road network, filters to roads touching Clarence Valley, joins traffic and NHVR access, checks connectivity to centres/facilities, applies State or Regional criteria, then exports dashboard-ready GeoJSON.

Key files:

- `dashboard/process_data.py`
- `dashboard/data/clarence_valley_assessment.geojson`

Snippet:

```python
def assess_regional_road(row):
    criteria_met = []

    if row.get("connects_town_centre") or row.get("connects_major_town"):
        criteria_met.append("R-01: Connects Town/Urban Centres")

    if row.get("connects_hospital") or row.get("connects_airport"):
        criteria_met.append("R-02: Connects hospitals/airports to centres")

    mandatory_pass = bool(row.get("has_bdouble"))
    meets_criteria = len(criteria_met) >= 2 and mandatory_pass

    return {
        "meets_category": meets_criteria,
        "mandatory_pass": mandatory_pass,
        "score": len(criteria_met),
    }
```

## 26. First-Generation NSW-Wide Processor

What it is:

`process_nsw.py` is the original NSW-wide processor. It grades NSW roads without full ADT coverage, using green/orange/red to separate confirmed passes from possible passes.

What the code does:

It loads the full NSW road network, joins NHVR vehicle access, detects key freight routes and POI connectivity, then marks roads green, orange or red.

Key files:

- `dashboard/process_nsw.py`
- `dashboard/data/nsw_assessment.geojson`
- `dashboard/data/nsw_stats.json`

Snippet:

```python
def assess_state_nsw(row):
    optional_met = 0

    if row["connects_major_town"] or row["is_key_freight_route"]:
        optional_met += 1

    if row["connects_hospital"] or row["connects_destination"]:
        optional_met += 1

    mandatory_pass = bool(row["has_pbs1"])
    passes_without_adt = optional_met >= 2 and mandatory_pass
    might_pass_with_adt = optional_met >= 1 and mandatory_pass

    return passes_without_adt, might_pass_with_adt, mandatory_pass
```

## 27. Focused Rebuild Scripts

What it is:

The project has targeted rebuild scripts that update one criterion or data source without rebuilding everything manually.

What the code does:

Each rebuild script validates the existing verdict rule, computes its changed criterion, updates `nsw_criteria.json`, updates per-segment map verdicts in `nsw_recat.json`, and updates `export_rows.json`.

Key files:

- `dashboard/rebuild_from_nhvr.py`
- `dashboard/rebuild_r01_rural_centres.py`
- `dashboard/rebuild_r03_roadtrain_optional.py`
- `dashboard/rebuild_r05_urban_centres.py`
- `dashboard/rebuild_regional_facility_optional.py`
- `dashboard/rebuild_state_ldr_optional.py`
- `dashboard/rebuild_two_state_optional.py`

Snippet:

```python
def verdict_of(c, optional_met):
    if c["mand"].get("bdouble") is False:
        return "red"
    if optional_met >= 2:
        return "green"
    if optional_met == 1:
        return "orange"
    return "red"

for rn, row in changed.items():
    crit[rn]["opt"]["hv"] = row["hv"]
    crit[rn]["optMet"] = row["optMet"]
    crit[rn]["verdict"] = row["verdict"]
```

## 28. Export Rows As A Reporting Layer

What it is:

The dashboard does not build Excel text from scratch each time. It has a prepared road-unit reporting table, `export_unit_rows.json`, with road names, criteria explanations, NHVR status, traffic and categorisation.

What the code does:

The criteria rebuild scripts keep the legacy `export_rows.json` aligned with `nsw_criteria.json`. `rebuild_road_units.py` turns it into `export_unit_rows.json`; `export.js` then filters those rows by unit key and formats them into a workbook.

Key files:

- `dashboard/data/export_rows.json`
- `dashboard/data/export_unit_rows.json`
- `dashboard/rebuild_road_units.py`
- `dashboard/js/export.js`
- `dashboard/rebuild_*.py`

Snippet:

```python
row["Why"] = update_why(row["Why"], two_state, c["optMet"], c["verdict"])
row["What (criteria tested)"] = update_what(row["What (criteria tested)"], two_state)
row["Categorisation"] = cat[c["verdict"]]
row["_v"] = c["verdict"]
```

## 29. Data Source Documentation

What it is:

`DATA_SOURCES.md` records where the dashboard data comes from, such as NHVR, ABS towns, NLTN, TfNSW traffic counts and derived road topology.

What the code does:

This is not runtime code, but it is part of the software's traceability. It explains which files are sourced and which are derived.

Key files:

- `DATA_SOURCES.md`

Snippet:

```md
| `nhvr_networks.json` | NHVR gazetted-network map service | Sourced -> joined | Road train / B-double / bypass status |
| `nsw_road_ext.json` | Derived (road geometry) | Derived | "Links two State Roads", parallel-State test |
| `nsw_criteria.json` / `nsw_recat.json` | Derived (criteria engine) | Derived | The green/amber/red verdicts |
```

## 30. How The Pieces Fit Together

Plain flow:

1. Python scripts prepare the data.
2. Prepared JSON/GeoJSON files are saved under `dashboard/data/`.
3. `rebuild_road_units.py` separates overloaded administrative IDs into connected assessment units.
4. `index.html` loads Leaflet and all JavaScript modules.
5. `init.js` fetches the unit files and builds road aggregates/layers.
6. `grading.js` decides how each road should be coloured in the current view.
7. `panels.js` switches tabs, counts roads and applies map layers.
8. `detail.js` explains a selected road's criteria.
9. `search.js`, `flagged.js`, `export.js` and `local.js` add workflows around that same road data.

Compact version:

```text
source data
  -> Python processing/rebuild scripts
  -> dashboard/data/*.json and *.geojson
  -> browser loads prepared files
  -> Leaflet map layers + sidebar panels
  -> search/detail/export/local-road workflows
```

## 31. Network-Backed Long-Distance Rural Route Assessment

What it is:

The LDR criterion tests whether a non-urban road has a connected component at
least 25 km long that joins an eligible State-tier source centre to a Town Centre.
It now follows the physical NSW road network instead of comparing only the ends
of categorisation geometry.

What the code does:

`network_connectivity.py` matches the categorised corridor to the NSW Transport
Theme RoadSegment layer, builds connected components from shared road endpoints,
and intersects those components with ABS UCL/SUA boundaries classified from 2021
Census population. `rebuild_network_ldr.py` compares the result with the previous
LDR value, records the impact, and updates criteria, map colours and exports when
run with `--apply`.

Key files:

- `dashboard/network_connectivity.py`
- `dashboard/rebuild_network_ldr.py`
- `dashboard/data/network_ldr_comparison.json`
- `dashboard/data/nsw_criteria.json`
- `dashboard/js/detail.js`
- `scripts/download_nsw_road_segments.py`

Snippet:

```python
qualifying = [
    component for component in components
    if component["km"] >= 25.0
    and component["source_centres"]
    and component["town_centres"]
]

result = {
    "ldr": bool(qualifying),
    "coverage": route_coverage(route_geometry, matched_segments),
    "source_centres": best["source_centres"],
    "town_centres": best["town_centres"],
}
```

The dashboard only mentions separate components when qualifying source and town
evidence exists but is split between those components. It does not present every
small geometry break as a reason the road failed.

## 32. Network-Backed State Facility Connectivity (S-08/S-11)

What it is:

S-08 tests non-urban State roads and S-11 applies the equivalent test to urban
State roads. Each asks whether a qualifying major facility or employment area
connects to another centre type. Nearby map items alone do not pass the criterion;
both sides must be on the same connected NSW road-network component.

What the code does:

`rebuild_state_facility_optional.py` reuses the cached NSW Road Segment corridor,
assigns ABS UCL/SUA centres and eligible facility evidence to each component, and
passes the criterion when one component contains both. Employment land must
intersect the selected road geometry and meet the client-approved size-only
threshold: Remote 5 ha, Regional 15 ha or Urban 40 ha. Economic value is not
part of the assessment.

`rebuild_employment_centres.py` uses current ELDM 2025 employment precincts as
the authoritative source where available and removes overlapping NSW Planning
EPI geometry. EPI zoning remains the statewide fallback, while potential-future
ELDM precincts are excluded. `rebuild_road_units.py` measures each source polygon
boundary against the selected road. `state.js` renders that real outline; a
non-intersecting polygon is dashed and linked to the road by the exact shortest
measured gap. This keeps context visible without presenting a near miss as a
connection.

For road numbers divided into several assessment units, `rebuild_road_units.py`
assigns every matched physical road segment to its nearest compatible unit and
reruns the same component test for each unit. Urban road identifiers are rerun as
well so S-11 uses the same evidence rules. The matching ABS centres and
facilities are written into that unit's evidence. This avoids both failure modes:
dropping centres that were absent from the older evidence file, and copying a
road-wide pass to an unrelated section.

Key files:

- `dashboard/rebuild_state_facility_optional.py`
- `dashboard/rebuild_employment_centres.py`
- `dashboard/rebuild_road_units.py`
- `dashboard/network_connectivity.py`
- `dashboard/data/network_state_facility_comparison.json`
- `dashboard/data/nsw_criteria.json`
- `dashboard/data/nsw_unit_criteria.json`
- `dashboard/data/nsw_unit_evidence.json`
- `dashboard/data/employment_centre_outlines.json`
- `dashboard/js/detail.js`
- `dashboard/js/state.js`
- `dashboard/js/grading.js`

Snippet:

```python
qualifying = [
    component
    for component in components
    if component["centre_names"] and component["facilities"]
]

result = {
    "dest": bool(qualifying) if network_coverage >= 0.70 else None,
    "qualifying_components": component_details,
}
```

Employment areas first earn candidate status from their exact geometry:

```python
if item["relation"] == "intersects" and employment_size_qualifies(item["ha"], road_zone):
    candidates.append({**item, "facility_kind": "employment"})

zone_point, road_point = nearest_points(zone_geometry, road_geometry)
item["link"] = [to_lonlat(zone_point), to_lonlat(road_point)]
```

That direct-intersection snippet is the State S-08/S-11 rule. Regional
R-02/R-06 instead accepts a size-qualified polygon when it intersects or
has `network_access == true`; the evidence row keeps the measured path so the
map can still show the real polygon-to-route gap.

For split road identifiers, the unit rebuild uses that evaluator again:

```python
unit_matches = assign_network_segments(source_matches, units)

for unit in units:
    result = evaluate_state_dest(
        unit_route,
        unit_matches[unit["key"]],
        unit_zone,
        centres,
        evidence,
    )
```

## 33. Declared Roads and Connected Map Sections

What it is:

TfNSW `road_number` is an administrative identifier and can cover disconnected
geometry, mixed State/Regional sections and several names. A physical break in
the source geometry does not necessarily mean the government has declared two
different roads. The dashboard therefore has two identities: `road_unit` for a
connected mapped section and `declared_road` for the road that owns the verdict.

What the code does:

`rebuild_road_units.py` first groups segments by administrative ID and current
class, connects endpoints within 200 m, bridges modest compatible source gaps,
and gives each connected corridor a stable unit key. Each unit receives its own
diagnostic evidence and result.

The same builder then groups units into declared roads when they share an official
classified road number and current class. Known reused identifiers such as
`0000057` remain separate, and unnumbered common-name roads are not merged. A grouped road starts from the road-level criteria and
rechecks mandatory network coverage across all sections, so a pass on one piece
cannot hide a failure elsewhere. Its evidence is the deduplicated union of its
member sections.

`roadKeyOf()` prefers `declared_road`, so map highlighting, search, details, pins,
cross-tests and exports all use one road identity and one verdict. The Sections
dropdown frames each real connected piece without changing the road-level score,
and the audit retains every unit's diagnostic verdict.

Key files:

- `dashboard/rebuild_road_units.py`
- `dashboard/data/nsw_road_units.json`
- `dashboard/data/nsw_declared_roads.json`
- `dashboard/data/nsw_declared_*.json`
- `dashboard/data/nsw_unit_*.json`
- `dashboard/data/export_declared_rows.json`
- `dashboard/js/utils.js`
- `dashboard/js/init.js`
- `dashboard/js/search.js`
- `dashboard/js/state.js`

Snippet:

```python
grouped_indexes[(road_number, admin_class)].append(segment_index)

for component in connected_groups(component_geometries):
    properties["road_unit"] = unit_key

if all_sections_belong_to_one_declared_road(source_id, units):
    for unit in units:
        section_to_road[unit["key"]] = source_id
        properties["declared_road"] = source_id
```

```javascript
function roadKeyOf(p) {
    if (p.declared_road) return p.declared_road;
    if (p.road_unit) return p.road_unit;
    return p.road_number;
}
```
