# Where the data comes from

A plain-language map of every dataset behind the Road Recategorisation dashboard —
what it is, where it was sourced, and what it drives on screen. Last updated
**1 July 2026**.

Two kinds of data appear below:

- **Sourced** — pulled from an external authority (a government service, open-data
  portal, or supplied file).
- **Derived** — computed *from* the sourced data by a script in
  `scratchpad/` (spatial joins, geometry tests, roll-ups). Nothing here invents
  facts; derived files only re-shape what the sourced data already says.

> **Integrity note.** The green / amber / red **verdicts** come only from the
> criteria engine (`nsw_criteria.json` / `nsw_recat.json`). Newer data (traffic,
> zones, heavy-vehicle networks, employment) is **shown** in the detail panel and
> export but does **not** silently flip any road's colour.

---

## Quick reference

| Dataset (in `dashboard/data/`) | Source | Type | Feeds |
|---|---|---|---|
| `nsw_assessment.geojson` | TfNSW Road Network Categorisation | Sourced | The road overlay + State/Regional class |
| `nsw_adt.json` | TfNSW Traffic Volume Counts (open data) | Sourced → joined | AADT + %HV in the detail panel & export |
| `nhvr_networks.json` | NHVR gazetted-network map service | Sourced → joined | Road train / B-double / bypass status |
| `employment_centres.json` | NSW Planning Portal land-zoning | Sourced → derived | Commercial/industrial centres by hectares |
| `nltn_2020_road.geojson` + `nsw_nltn.json` | NLTN Determination 2020 (data.gov.au) | Sourced → joined | Nationally Significant tab |
| `nsw_towns.geojson` | ABS Census 2021 population centres | Sourced | Town/city pins + "connects centres" |
| `sua_outlines.json` | ABS Significant Urban Areas 2021 | Sourced | Urban-area perimeters (highlights) |
| Hospitals / ports / airports / intermodals | NSW Health / known-location POI files | Sourced | Facility criteria + highlights |
| `nsw_urbanity.json` | ABS Section-of-State (urban/rural) | Sourced | Urban vs rural criteria split |
| `nsw_zone.json` | Derived (urbanity + Newell Hwy) | Derived | Urban / Regional / Remote zone |
| `nsw_road_ext.json` | Derived (road geometry) | Derived | "Links two State Roads", parallel-State test |
| `nsw_evidence.json` etc. | Derived (spatial joins) | Derived | The named "why" behind each criterion |
| `nsw_criteria.json` / `nsw_recat.json` | Derived (criteria engine) | Derived | The green/amber/red verdicts |
| Clarence Valley files | CV Council + ABS LGA boundary | Sourced | CV tab |

---

## 1. Road network & current classification

**`nsw_assessment.geojson`** — the ~17,700 road segments you see on the map, each
tagged `admin_class` = **S**tate / **R**egional (Local roads are filtered out).

- **Source:** the **TfNSW NSW Road Network Categorisation** dataset
  (`nsw_road_network_categorisation.geojson`, ~56 MB, in the project root) — the
  authority for each road's *current* functional class. This is the "ground truth"
  the criteria are tested against.
- Underlying service (per `data_requirements.md`): NSW Spatial Portal
  `NSW_Transport_Theme/FeatureServer` — RoadSegment / RoadNameExtent layers, field
  `functionhierarchy`.
- **Gazetted-class corrections (July 2026):** every numbered road was cross-checked
  against the **TfNSW Schedule of Classified Roads and Unclassified Regional Roads,
  Version 18 (March 2026, SF2013/159234)** — the legal record of each road's
  administrative category. Ten roads carried segments mis-classed in the extract
  (8 single stray segments, e.g. one "Regional" segment on the Hume; 25 Regional
  segments on the Pacific; and two whole roads, Iluka Rd `0007731` and Old Pacific
  Hwy Taree `0007776`, classed State where the 7000 series is Regional by
  definition). Corrected by `dashboard/apply_schedule_fixes.py` (dry-run/--apply,
  `*.preSchedFix.bak` backups); the two re-classed roads' verdicts were re-earned
  under the Regional rule (Iluka Rd fails the 19m B-double gate → red).
- **Known source gaps:** the extract is missing stretches of a few roads the
  Schedule gazettes as continuous — MR241 Gunning–Boorowa–Young–Temora (~41 km),
  Old Northern Rd MR160 (~3.5 km), Olympic Hwy MR78 (~2.6 km), Mitchell Hwy HW7
  (~2.5 km), and RR7784's Frome St leg in Moree (~0.8 km, Jones Ave → Newell Hwy —
  the extract carries only the Edward St + Jones Ave legs). The live NSW Spatial services expose no gazetted road number, so these
  cannot be re-fetched authoritatively; the drawn breaks reflect the source data.
  (Roads the Schedule itself describes in discontinuous sections — e.g. Mid Western,
  Snowy Mountains, Sturt at Narrandera — and freeway interleaves are NOT gaps.)

**Route shields (A / B / D / M numbers)** — `nsw_refs.json`, `cv_refs.json`, with
manual fixes in `ref_overrides.json`. Sourced from an OpenStreetMap route join.

---

## 2. Traffic — Average Daily Traffic (AADT) & heavy-vehicle %

**`nsw_adt.json`** — real AADT + %HV for **366 roads** (State 191/266, Regional
175/626).

- **Source:** **TfNSW "NSW Roads Traffic Volume Counts"** open data
  (`opendata.transport.nsw.gov.au`, dataset `ef2b0bd2-…`). Two CSVs:
  - *Station Reference* — 1,783 count-station locations (lat/lon).
  - *Yearly Summary* — annual counts 2006–2026 by station, direction and vehicle class.
- **How derived:** for each station, take the latest **all-days, both-directions**
  count (ALL VEHICLES / UNCLASSIFIED) as AADT and the HEAVY-VEHICLES count for %HV;
  spatially join each station to the busiest assessed road within **250 m**
  (`scratchpad/build_adt.py`). Coverage is strong on State roads, sparser on rural
  Regional roads (fewer stations).
- The old **Clarence Valley** master file (`Traffic Counts Master File.xlsx`) is
  council data for the Grafton region only — used for the CV tab, not statewide.

---

## 3. Connectivity — towns, hospitals, freight destinations, employment

All of these live in the `POI/` folder and are joined to roads to produce the
named "why" evidence (`nsw_evidence.json`, `cv_evidence.json`, `nltn_evidence.json`,
via `scratchpad/gen_evidence2.py`).

- **Towns / cities** (`nsw_towns.geojson`, tiers in `derive_local.py`) — **ABS
  Census 2021** population centres (Urban Centres & Localities / Suburbs & Localities
  / SA2), with the population tiers the criteria use (Capital / Metropolitan ≥130k /
  Regional City / Major Town / Town Centre). Raw counts in
  `POI/Census_Population/2021Census_G01_NSW_*.csv`.
- **Significant Urban Areas** (`sua_outlines.json`) — **ABS SUA 2021**
  (`POI/SUA_NSW_2021.shp`); the perimeters used to say what a city road "connects".
- **Suburbs & Localities (SAL 2021)** — **ABS ASGS Edition 3, Non-ABS Structures
  GeoPackage** (`dashboard/Newfile/ASGS_Ed3_Non_ABS_Structures_GDA2020_updated_2025.gpkg`,
  layer `SAL_2021_AUST_GDA2020`; ~1 GB, NOT in git — auto-extracted from the
  sibling .zip), joined to `2021Census_G01_NSW_SAL.csv` populations. **Urban
  centres re-score (July 2026):** S-10 / R-05 for urban roads is computed at
  suburb granularity by `dashboard/rebuild_sal_urban_centres.py` — a qualifying
  centre is a SAL with ≥7,000 people (the Major Town floor) the road runs
  through, and the criterion needs **≥2 distinct** qualifying SALs. Previously
  urban centres resolved to the whole Significant Urban Area, so every road
  inside the metro saw ONE centre ("Sydney") and the connects-centres-to-each-
  other test was undecidable there. Urban roads' `nsw_evidence.json` centres[]
  lists the actual suburbs (kind `sal`).
- **Major hospitals** — `POI/Major_Hospitals_NSW.geojson` (NSW Health / AIHW
  MyHospitals), tiered by beds: Urban 400+, Regional 100+, Remote 15+.
- **Ports / airports / intermodals** —
  `POI/Key_Destinations_Ports_Intermodals_Airports.geojson` (known major-facility
  locations: Port Botany/Kembla/Newcastle, Moorebank/Enfield/Parkes, international &
  regional airports).
- **Employment (commercial / industrial) centres** (`employment_centres.json`,
  `scratchpad/fetch_employment.py`) — **NSW Planning Portal land-zoning**
  (`mapprod3.environment.nsw.gov.au …/EPI_Primary_Planning_Layers/MapServer/2`).
  Every Commercial (B1–B7, E1, E2, MU1) and Industrial (IN1–IN4, E3–E5) zone
  polygon, measured in **hectares** and tiered Major ≥40 ha / Regional ≥15 ha /
  Local ≥5 ha. **1,835 centres.**
  *(The dollar-value half of this criterion — an employment-density estimate — was
  built and then removed at your request; it's recoverable in git history.)*

---

## 4. Heavy-vehicle networks (NHVR)

**`nhvr_networks.json`** — per-road membership of the gazetted heavy-vehicle
networks.

- **Source:** the **NHVR** map service
  (`maps.nhvr.gov.au …/NHVR/GazettedNetworks` and `…/Bypasses`):
  - Road Train 32 m Approved Routes (layer 21) → the R-03 criterion
  - B-double 19 m Approved Routes NSW (layer 17) → the R-04 mandatory
  - Heavy-vehicle Bypasses
- **How derived:** the service strips geometry, but *spatial-intersect counts* work
  — each road's simplified, buffered polyline is POSTed and the network is "on" if
  it intersects ≥1 feature (`scratchpad/nhvr_source.py`).

---

## 5. National network (Nationally Significant tab)

- **`nltn_2020_road.geojson`** — the **National Land Transport Network
  (Determination 2020)** road network, from **data.gov.au** ("Key Freight Routes
  NLTN 2020 Road" / infrastructure.gov.au), converted from the source shapefile
  (`scratchpad/convert_validate.py`).
- **`nsw_nltn.json`** — per-segment NLTN membership (spatial join), used to flag
  "nationally significant" State roads.
- **`nltn_meta.json`** — per-route national-criteria attributes, incl. **NHVR PBS
  Level 2B** approved-route status (S-06), tested live against the NHVR network.

---

## 6. Zones & boundaries

- **`nsw_urbanity.json`** — **ABS Section-of-State** urban/rural per segment; drives
  the urban vs rural criteria thresholds.
- **`nsw_zone.json`** (derived, `scratchpad/build_zones.py`) — **Urban / Regional /
  Remote**, where *Remote = rural AND west of the Newell Highway*. The Newell's
  alignment is pulled from the road network itself and its longitude interpolated at
  each road's latitude. 507 urban / 296 regional / 89 remote.
- **Greater Sydney / NSW state boundary** — `POI/Greater_Sydney_GCCSA_2021.shp`,
  `POI/NSW_State_Boundary_2021.shp` (ABS ASGS 2021).
- **LGA boundaries** — `scratchpad/nsw_lga.geojson` (ABS ASGS 2021 LGAs); used for
  the "LGA(s) touched" column in the Excel export.

---

## 7. Clarence Valley tab

- **`clarence_valley_assessment.geojson`** — the CV council assessment (retired from
  the map; the CV tab now shows the statewide overview zoomed into the LGA).
- **`clarence_valley_boundary.geojson`** — the CV **LGA boundary** (ABS ASGS 2021),
  drawn as the black outline and used to geometrically clip roads to the LGA.
- **`Traffic Counts Master File.xlsx`** — Clarence Valley Council traffic counts
  (Grafton region).

---

## 8. Derived / computed layers (no external source)

These are produced entirely from the datasets above:

- **`nsw_criteria.json` / `nsw_recat.json`** — the criteria engine's per-road
  pass/fail against the State & Regional criteria → the map's green/amber/red.
- **`nsw_evidence.json`, `cv_evidence.json`, `nltn_evidence.json`** — the named
  entities each road connects (the clickable "why" in the detail panel).
- **`nsw_road_ext.json`** (`scratchpad/derive_local.py`) — pure-geometry topology:
  "links two State Roads", and "closely parallels another State Road within 20 km"
  (the mandatory no-parallel test).
- **Centre tiers** — Capital / Metropolitan / Regional City / Major Town / Town
  Centre, from ABS population counts.

---

## 9. Known gaps (not available)

| Requirement | Status |
|---|---|
| **Statewide load limits** on bridges/structures | Not sourced — fragmented across TfNSW + councils; shown as "assumed compliant". |
| **Emergency evacuation routes** | **No statewide dataset exists** — only council PDFs + NSW SES *tsunami evacuation areas* (coastal polygons, not road routes). Investigated and confirmed unavailable. |
| **Interstate towns within 100 km of the border** | Skipped (needs QLD/VIC/SA town data; only NSW census is on disk). |
| **Commercial/industrial $-value (income)** | Only the hectare half is in; the $ estimate was built then removed at your request. ABS place-of-work jobs (needed for a measured version) are only available via ABS TableBuilder, not a clean API. |

---

## Basemap

Map tiles are **CARTO "Voyager" (no labels)** — © OpenStreetMap contributors, ©
CARTO. The dashboard draws its own town labels on top.
