# Road Recategorisation Model – Data Requirements

## Objective

Test whether the TfNSW road recategorisation criteria accurately determine the
functional category of each road in NSW. Compare the criteria-based classification
against the **current functional classification** shown on the TfNSW Road Network
Categorisation map (ArcGIS Experience Builder app). Display results on an
interactive map dashboard showing which roads meet their assigned category
criteria (green) and which do not (red).

---

## Primary Data Source – Current Road Function

**Source:** TfNSW NSW Road Network Categorisation map
- App URL: https://experience.arcgis.com/experience/c33e55c80a214cbf8dbb05db22f0fbb4
- Title: "NSW Road Network Categorisation"

This ArcGIS Experience Builder app displays the current functional category of
each road. The underlying data service needs to be accessed to extract:
- Road geometry (polylines)
- Current assigned category (State Road, Regional Road, Local Road)

**Underlying Feature Service (NSW Spatial Portal):**
- Base: `https://portal.spatial.nsw.gov.au/server/rest/services/NSW_Transport_Theme/FeatureServer`
- **Layer 5 – RoadSegment**: Road centrelines with `functionhierarchy` field
  - Coded values: 1=Motorway, 2=PrimaryRoad, 3=ArterialRoad, + more
  - Also has: `urbanity`, `surface`, `lanecount`, `roadnamebase`, `roadnametype`
- **Layer 6 – RoadNameExtent**: Named road extents with `functionhierarchy`
  - Also has: `roadnamestring`, `urbanity`

**Key field: `functionhierarchy`** – This represents the current functional
classification and serves as the "ground truth" for what category a road
currently performs.

> **Note:** The Experience Builder app may reference a *separate* categorisation
> layer specific to the recategorisation program (State/Regional/Local) rather
> than the generic function hierarchy. This needs to be confirmed by inspecting
> the app's web map configuration or contacting TfNSW.

---

## Data Requirements by Criterion

### 1. Road Geometry & Current Classification (AVAILABLE)

| Data Item | Source | Status |
|-----------|--------|--------|
| Road centrelines (polylines) | NSW_Transport_Theme/FeatureServer/5 (RoadSegment) | ✅ Available |
| Road names | NSW_Transport_Theme/FeatureServer/6 (RoadNameExtent) | ✅ Available |
| Function hierarchy (current category proxy) | `functionhierarchy` field | ✅ Available |
| Urbanity (urban/rural indicator) | `urbanity` field | ✅ Available |
| Surface type | `surface` field | ✅ Available |
| Lane count | `lanecount` field | ✅ Available |
| Max query: 2000 records per request | Pagination required | ⚠️ Manageable |

---

### 2. Traffic Data (REQUIRED – Separate Source)

| Data Item | Description | Source | Status |
|-----------|-------------|--------|--------|
| Average Daily Traffic (ADT) | Mon–Fri vehicle counts per road | TfNSW Traffic Volume Viewer | ⚠️ Needs sourcing |
| Heavy vehicle % | % of ADT that is heavy vehicles | TfNSW Traffic Volume Viewer | ⚠️ Needs sourcing |

**Where to get it:**
- TfNSW Traffic Volume Viewer: https://roads-waterways.transport.nsw.gov.au/about/corporate-publications/statistics/traffic-volumes/
- May also be available as a spatial layer on the NSW Spatial Portal
- Count station point data would need to be joined to road segments

---

### 3. Connectivity Data (REQUIRED – Derived via GIS Analysis)

| Data Item | How to Derive | Status |
|-----------|---------------|--------|
| What each road connects (town type at each end) | Spatial intersection of road endpoints with town/city boundaries | 🔧 Needs GIS processing |
| National Land Transport Network membership | Australian Gov NLTN dataset | ⚠️ Needs sourcing |
| Heavy vehicle bypass designation | TfNSW freight network maps | ⚠️ Needs sourcing |
| Emergency evacuation routes | NSW SES / TfNSW | ⚠️ Needs sourcing |
| Road train network | NHVR gazetted network maps | ⚠️ Needs sourcing |
| Parallel State Road proximity (<20km) | Buffer analysis on State Roads | 🔧 Needs GIS processing |
| Connects two State Roads | Network topology analysis | 🔧 Needs GIS processing |

---

### 4. Points of Interest / Destination Locations (REQUIRED)

| Data Item | Threshold | Source | Status |
|-----------|-----------|--------|--------|
| Capital Cities | Sydney, Canberra | ABS Census 2021 – UCL | ✅ Available (simple) |
| Metropolitan Centres | 130,000+ pop (SA3) | ABS Census 2021 – SA3 | ✅ Available |
| Regional Cities | 20,000+ Reg / 15,000+ Remote | ABS Census 2021 – UCL | ✅ Available |
| Major Towns/Urban Centres | 10,000+ / 7,000+ / 5,000+ | ABS Census 2021 – UCL/SaL | ✅ Available |
| Town Centres | 2,000+ Reg / 1,000+ Remote | ABS Census 2021 – UCL/SaL | ✅ Available |
| Interstate Towns | Within 100km border, 20,000+ | ABS Census + border buffer | 🔧 Derivable |
| Major Hospitals | 400+/100+/15+ beds | NSW Health / AIHW MyHospitals | ⚠️ Needs sourcing |
| Major Ports | Port Botany, Kembla, Newcastle | Known locations | ✅ Available (3 points) |
| Major Intermodals | Moorebank, Enfield, Newcastle, Parkes | Known locations | ✅ Available (4 points) |
| International/Regional Airports | Daily scheduled services | CASA / airport operators | ⚠️ Needs sourcing |
| Commercial/Industrial Centres | $250m+/40ha, $100m+/15ha, $20m+/5ha | ABS + NSW Planning | ❌ Hard to source |

---

### 5. Vehicle Access & Load Constraints (REQUIRED)

| Data Item | Source | Status |
|-----------|--------|--------|
| PBS Level 2B access | NHVR network maps | ⚠️ Needs sourcing |
| PBS Level 1 access | NHVR network maps | ⚠️ Needs sourcing |
| GML & CML 19m B-double routes | NHVR network maps | ⚠️ Needs sourcing |
| Load limits on bridges/structures | TfNSW + council bridge registers | ❌ Fragmented |

**Where to get it:**
- NHVR Route Planner: https://www.nhvr.gov.au/road-access/route-planner
- NHVR may publish gazetted network maps as spatial data

---

### 6. Zone & Boundary Data (REQUIRED)

| Data Item | Source | Status |
|-----------|--------|--------|
| Greater Sydney boundary | Greater Cities Commission | ✅ Available |
| Urban/Regional/Remote zones | TfNSW (Remote = west of Newell Hwy) | 🔧 Derivable |
| NSW state border | NSW Spatial Services | ✅ Available |
| LGA boundaries | ABS ASGS | ✅ Available |

---

## Summary: Data Readiness

| Category | Ready | Needs Sourcing | Needs Processing | Hard/Unavailable |
|----------|-------|----------------|------------------|------------------|
| Road Geometry & Classification | ✅ | | | |
| Traffic Data | | ⚠️ | | |
| Connectivity | | ⚠️ (some) | 🔧 (most) | |
| Points of Interest | ✅ (most) | ⚠️ (some) | | ❌ (commercial centres) |
| Vehicle Access | | ⚠️ | | ❌ (load limits) |
| Zones & Boundaries | ✅ | | 🔧 (remote zone) | |

---

## Dashboard Design

### Interactive Map (Leaflet.js or ArcGIS JS API)
- Zoomable map of NSW
- Road segments coloured:
  - **Green** = road meets the criteria for its currently assigned category
  - **Red** = road does NOT meet the criteria for its assigned category
  - **Amber** (optional) = partially meets (some criteria met, not all mandatory)
- Click a road to see: name, current category, criteria pass/fail detail, traffic data
- Layer filters: by category, by zone, by pass/fail status

### Summary Statistics Panel
- Overall accuracy: % of roads where criteria aligns with current function
- Breakdown by category (State, Regional, Local)
- Breakdown by zone (Urban, Regional, Remote)
- Per-criterion pass/fail counts

### Tech Stack
- **Map**: Leaflet.js with GeoJSON tiles (or ArcGIS JS API 4.x to connect directly to the FeatureServer)
- **Criteria engine**: Python (evaluate each road against the criteria rules)
- **Frontend**: HTML/JS dashboard
- **Data pipeline**: Python scripts to query the ArcGIS REST API, join datasets, run classification

---

## Recommended Next Steps

1. **Confirm the data layer** behind the TfNSW Experience Builder app – inspect
   its web map to find the exact categorisation field (State/Regional/Local)
2. **Source traffic data** – query TfNSW Traffic Volume Viewer or find the spatial layer
3. **Download ABS Census UCL/SA3 data** – for population thresholds
4. **Source NHVR network data** – for vehicle access criteria
5. **Build zone boundaries** – define Remote zone (west of Newell Highway)
6. **Start with available data** – build a prototype using road geometry +
   function hierarchy + population centres, then progressively add traffic and
   vehicle access data
