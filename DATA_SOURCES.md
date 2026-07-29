# Where the data comes from

A plain-language map of every dataset behind the Road Recategorisation dashboard —
what it is, where it was sourced, and what it drives on screen. Last updated
**20 July 2026**.

Two kinds of data appear below:

- **Sourced** — pulled from an external authority (a government service, open-data
  portal, or supplied file).
- **Derived** — computed *from* the sourced data by a script in
  `scratchpad/` (spatial joins, geometry tests, roll-ups). Nothing here invents
  facts; derived files only re-shape what the sourced data already says.

> **Integrity note.** The dashboard scores one declared road once, even when the
> source geometry is interrupted or divided into several connected map sections.
> `nsw_declared_*.json` is the runtime assessment layer; `nsw_unit_*.json` remains
> the section-level diagnostic layer. This prevents one official road from showing
> conflicting overall verdicts while retaining the real mapped gaps and section
> results for inspection. Known reused identifiers are kept as separate roads.

---

## Quick reference

| Dataset (in `dashboard/data/`) | Source | Type | Feeds |
|---|---|---|---|
| `nsw_assessment.geojson` | TfNSW Road Network Categorisation | Sourced -> derived | Road overlay, sourced class and generated `road_unit` per segment |
| `nsw_road_units.json` | Categorisation geometry + route references | Derived | Audit of connected/class-consistent assessment units |
| `nsw_declared_roads.json` | Classified-road identity + connected-unit audit | Derived | One dashboard identity and verdict per declared road, with mapped-section drill-down |
| `nsw_declared_criteria.json` / `nsw_declared_recat.json` | Criteria engine + declared-road roll-up | Derived | Dashboard verdicts and per-segment colours |
| `nsw_declared_evidence.json` | Connected-unit evidence merged by declared road | Derived | Named centres/facilities shown for the complete declared road |
| `nsw_unit_*.json` | Connected geometry rebuild | Derived | Section-level diagnostics retained for audit and regression testing |
| `nsw_adt.json` | TfNSW Traffic Volume Counts (open data) | Sourced → joined | AADT + %HV in the detail panel & export |
| `nhvr_networks.json` | NHVR gazetted-network map service | Sourced → joined | Road train / B-double / bypass status |
| `employment_centres.json` + `employment_centre_outlines.json` | ELDM 2025 precincts + NSW Planning EPI land-zoning | Sourced → derived | Size-assessed employment centres, exact map polygons and road-gap evidence |
| `nltn_2020_road.geojson` + `nsw_nltn.json` | NLTN Determination 2020 (data.gov.au) | Sourced → joined | Nationally Significant tab |
| `nsw_towns.geojson` | ABS Census 2021 population centres | Sourced | Town/city pins + "connects centres" |
| `sua_outlines.json` | ABS Significant Urban Areas 2021 | Sourced | Urban-area perimeters (highlights) |
| Hospitals / ports / airports / intermodals | NSW Health / known-location POI files | Sourced | Facility criteria + highlights |
| `nsw_urbanity.json` | ABS Section-of-State (urban/rural) | Sourced | Urban vs rural criteria split |
| `nsw_zone.json` | Derived (urbanity + Newell Hwy) | Derived | Urban / Regional / Remote zone |
| `nsw_road_ext.json` | Derived (road geometry) | Derived | "Links two State Roads", parallel-State test |
| `network_ldr_comparison.json` | NSW Road Segment + ABS UCL/SUA population | Sourced -> derived | Auditable long-distance centre-to-town connectivity |
| `network_state_facility_comparison.json` | NSW Road Segment + ABS centres + facility evidence | Sourced -> derived | Auditable S-08 facility-to-centre connectivity |
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

**Declared roads and connected map sections** — `rebuild_road_units.py` treats `road_number` as the
TfNSW administrative identifier, not a guaranteed single-road key. Within each
identifier it groups geometry that connects within 200 m, bridges compatible
same-name/same-route source gaps up to 1 km, and separates State from Regional
sections. A disconnected component under 350 m is treated as a source fragment,
not a separate assessment, when the same identifier has a larger component. The
resulting `road_unit` is a mapped section, not automatically a separate road.

Above that diagnostic layer, the builder groups mapped sections that share the
same official classified road number and current class. The dashboard
then selects, scores, pins and exports the resulting `declared_road` once. The
section dropdown can still frame every disconnected mapped part and disclose its
diagnostic result. Identifier `0000057` is an explicit keep-separate exception
because it is reused by West Wyalong-Condobolin, Tullamore-Nyngan and Goldfields,
which are distinct corridors rather than separated pieces of one declared road.
Unnumbered roads are not merged merely because they share a common street name.

**Physical road topology** — the raw
`nsw_road_segments_gda2020/nsw_road_segments.gpkg` contains 1,373,829 features
from the public NSW Transport Theme GDA2020 `RoadSegment` layer. The resumable
download is `scripts/download_nsw_road_segments.py`. The LDR and S-08 rebuilds
match these physical centreline segments to each categorised road corridor before
testing connectivity.

**Statewide LocalRoad catalogue** — `build_local_road_catalog.py` reads the same
NSW Transport Theme GeoPackage and keeps every segment whose official coded
attributes are `operationalstatus=1` (**Operational**) and
`functionhierarchy=6` (**LocalRoad**). This is a sourced functional hierarchy,
not proof of council ownership or maintenance responsibility.

- The current source contains **524,455 operational LocalRoad segments**:
  **442,400 named** and **82,055 unnamed**.
- Connected segments with the same complete road name are grouped. At an
  unbranched degree-two junction, a name change is also bridged when the two
  lines continue within 30 degrees of straight. Disconnected roads with common
  names remain separate, and unnamed segments remain separate so intersections
  cannot create a fictitious unnamed mega-road.
- The aligned July 2026 build produces **204,390 road candidates** covering
  **126,556.9 km**: 122,335 named connected corridors/components and all 82,055
  unnamed segments. Available evidence identifies 13 Regional-test green roads,
  135 Regional-test orange roads, one State-test green road and 11 State-test
  orange roads. Gate-passing candidates with no demonstrated optional criterion
  are retained separately as insufficient evidence.
- `local_roads_manifest.json` provides statewide counts and assessment coverage.
  `local_roads_catalog.json.gz` preserves all per-road audit records.
- `local_road_chunks/*.geojson.gz` contains geometrically clipped 0.25-degree
  chunks. Best Fit decompresses only visible chunks when the map ruler reaches
  2 km or closer, avoiding a half-million-line browser load.
- Centre evidence is assigned to road terminal points within 1.2 km. Urban
  candidates use qualifying ABS locality centres; rural candidates use the same
  population floors as declared roads. A centre
  connection needs distinct centres at separate terminals; a destination
  connection needs a facility at one terminal and a centre at another. The
  terminals must span at least 500 m so tiny segments inside overlapping
  evidence catchments are not mislabelled as end-to-end connections.
- Employment-centre minimum areas match the declared-road zone rules: 40 ha
  Urban, 15 ha Regional and 5 ha Remote. Regional testing also measures Type 2
  road-train coverage and connections between two State roads; State testing
  includes the rural 25 km major-centre-to-town long-distance option. Traffic
  remains unknown. A gate-passing road with no optional evidence is reported as
  `insufficient`, not as a demonstrated criteria failure.
- The Regional 19 m B-double and State PBS Level 1 gates use official NHVR
  network geometry. B-double passes at 80% coverage or greater; PBS Level 1
  passes only above 80%. Coverage measures how much of the road follows an
  approved or approved-with-conditions route within the configured tolerance. The current build
  finds the per-road pass values recorded in the catalogue; exact totals can
  change when near-straight name changes join previously separate components.
- PBS Level 1 comes from NHVR network `NSW- PBS Aggregate GML - Level 1` in
  `nhvr_hvn_11240619.gpkg`, downloaded from the
  [NHVR National Network Map](https://maps.nhvr.gov.au/?view=Category&viewBy=Networks&exemptionSetId=-2&networkIds=%5B5972%5D).
- The Local tab's suburb search remains a separate OpenStreetMap/Overpass preview.
  The statewide Best Fit local-road population does not depend on that live API.

---

## 2. Traffic — Average Daily Traffic (AADT) & heavy-vehicle %

**`nsw_declared_adt.json`** — measured AADT for **376 of 921 declared roads**
(State 190, Regional 186). Heavy-vehicle percentage is available for 169 roads,
and 83 road measurements are from 2020 or later. `nsw_unit_adt.json` retains the
same evidence at connected-section level for audit.

- **Source:** **TfNSW "NSW Roads Traffic Volume Counts"** open data
  (`opendata.transport.nsw.gov.au`, dataset `ef2b0bd2-…`). Two CSVs:
  - *Station Reference* — 1,783 count-station locations (lat/lon).
  - *Yearly Summary* — annual counts 2006–2026 by station, direction and vehicle class.
- **How derived:** `dashboard/rebuild_adt.py` excludes partial and current-year
  counts, combines the two measured directions when TfNSW has not published a
  both-directions total, and keeps each station's newest completed-year result
  (through 2025 in the current build). Heavy-vehicle percentage is calculated
  only from the same station and year as an `ALL VEHICLES` count. Stations first
  match road administrative ID and geometry; road-name/geometry matching handles
  source-ID differences. A counter is shared with another administrative road
  record only when the road names agree and the geometries overlap within 15 m.
  The newest matched observation is selected for each road; a high old count no
  longer overrides a newer measurement.
- The old **Clarence Valley** master file (`Traffic Counts Master File.xlsx`) is
  council data for the Grafton region only — used for the CV tab, not statewide.

---

## 3. Connectivity — towns, hospitals, freight destinations, employment

All of these live in the `POI/` folder and are joined to roads to produce the
named "why" evidence (`nsw_evidence.json`, `cv_evidence.json`, `nltn_evidence.json`,
via `scratchpad/gen_evidence2.py`).

The LDR criterion additionally uses the newer raw ABS files under
`Desktop/IPWEA/data/raw`: the combined ASGS 2021 UCL/SUA GDA2020 GeoPackage and
the NSW UCL/SUA `G01` Census population tables. `rebuild_network_ldr.py` intersects
those official centre boundaries with matched NSW Road Segment components. It
requires a 25 km component containing both a qualifying source centre and a Town
Centre; statistical catch-all areas such as "Remainder of State/Territory" are
excluded.

- **Towns / cities** (`nsw_towns.geojson`, tiers in `derive_local.py`) — **ABS
  Census 2021** population centres (Urban Centres & Localities / Suburbs & Localities
  / SA2), with the population tiers the criteria use (Capital / Metropolitan ≥130k /
  Regional City / Major Town / Town Centre). Raw counts in
  `POI/Census_Population/2021Census_G01_NSW_*.csv`.
- **Significant Urban Areas** (`sua_outlines.json`) — **ABS SUA 2021**
  (`POI/SUA_NSW_2021.shp`); the perimeters used to say what a city road "connects".
- **Remote-zone town thresholds (July 2026, PENDING DATA RE-RUN):** the guide
  eases every centre tier west of the Newell Hwy (Regional City 15,000+ ·
  Major Town 5,000+ · Town Centre 1,000+). `dashboard/rebuild_remote_town_centres.py`
  applies them to the towns/evidence layer (the network-based criteria already
  honour them via `centre_roles`): it adds 12 remote towns the flat 2,000 floor
  had excluded (Bourke, Walgett, Nyngan, Lightning Ridge, Balranald…) to
  `nsw_towns.geojson`, attaches them (≤5 km) to rural roads' evidence, and
  re-tiers 3 centres (Broken Hill → Regional City; Deniliquin, Moama → Major
  Town). **The regenerated data is NOT in this lineage yet**: the declared-road
  pipeline (`rebuild_road_units.py`) now requires raw inputs not present on
  every machine (`nsw_planning_employment_zones.geojson`,
  `nsw_road_segments_gda2020/nsw_road_segments.gpkg` + the derived corridor
  cache, `abs_sua_census_profile_2021_nsw/2021Census_G01_NSW_SUA.csv`).
  Cascade once those are available: `rebuild_remote_town_centres.py --apply` →
  `rebuild_r01_rural_centres.py --apply` → `rebuild_road_units.py --apply
  --raw-dir <raw>`.
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
- **Map locality-centre inventory** (`dashboard/data/nsw_locality_centres.geojson`) —
  built by `dashboard/build_map_locality_centres.py` from the official ABS ASGS
  2021 SAL point service and the checked-in NSW SAL G01 population table. It
  includes every mapped NSW SAL with at least 1,000 residents, the guide's lowest
  remote Town Centre population floor. The dashboard progressively reveals
  the 1,000 / 2,000 / 7,000 / 20,000 population bands by zoom. These are shown
  as population-based **candidate centres**; the road zone and criterion still
  determine whether an individual candidate qualifies for a particular test.
- **Major hospitals** — `POI/Major_Hospitals_NSW.geojson` (NSW Health / AIHW
  MyHospitals), tiered by beds: Urban 400+, Regional 100+, Remote 15+.
- **State facility criterion S-08 / S-11 (July 2026 re-score):** the guide
  wording is two-legged — the facility must connect **to other centre types**.
  A qualifying facility (major hospital; Major Port / Major Intermodal /
  **International** Airport — Regional Airports qualify for R-02 only;
  qualifying commercial-industrial-employment centre) must share a connected
  road component with a qualifying centre. Two sibling rebuilds own it:
  **rural S-08** — `rebuild_state_facility_optional.py` (NSW Road Segment
  network components, corridor-matched, coverage-gated); **urban S-11** —
  `rebuild_state_facility_urban.py` (road-geometry components against the
  SAL suburb centres evidence, `dest_method: sal_evidence_components`).
  Results live in `stateOpt.dest*` (cross-tests) and drive `opt.dest` for
  State roads. Previously the criterion passed on mere buffer proximity to a
  hospital / port / airport, with no centre leg and no employment centres.
- **Ports / airports / intermodals** —
  `POI/Key_Destinations_Ports_Intermodals_Airports.geojson` (known major-facility
  locations: Port Botany/Kembla/Newcastle, Moorebank/Enfield/Parkes, international &
  regional airports).
- **Employment (commercial / industrial) centres** (`employment_centres.json`,
  `employment_centre_outlines.json`) — **NSW Employment Lands Development
  Monitor (ELDM) 2025 current precincts**, with **NSW Planning EPI land-zoning**
  as the statewide fallback (`mapprod3.environment.nsw.gov.au …/
  EPI_Primary_Planning_Layers/MapServer/2`). `rebuild_employment_centres.py`
  loads current, zoned ELDM precincts of at least 5 ha and excludes the
  Potential Future layer. Where ELDM exists it is authoritative: overlapping
  EPI geometry is removed to avoid double counting. Outside ELDM coverage, EPI
  Commercial (B1-B8, E1, E2, MU1) and Industrial (IN1-IN4, E3-E5) polygons are
  dissolved by LGA and zone class. The current build contains **379 ELDM
  precincts** and **1,367 EPI fallback centres**. The outline file contains the
  actual simplified polygon used for both scoring and map display, not a radius.
- **Employment scoring decision:** employment importance is assessed using the
  client-approved **land-area-only** thresholds: Urban >=40 ha, Regional >=15 ha
  and Remote >=5 ha. Economic value and the legacy Major/Regional/Local labels
  are not scoring inputs. Every evidence row stores its applicable threshold,
  source and size decision so the result is auditable.
- **Regional employment access for R-02/R-06**
  (`regional_employment_access.json`) — `regional_employment_access.py` tests
  size-qualified employment polygons that do not directly intersect the
  categorised road. A candidate must be within a 1.5 km direct gap and have a
  continuous path of no more than 2 km through the NSW Transport Theme GDA2020
  Road Segment network. The assessed route is reconciled to that network within
  100 m and the access street must reach the employment polygon within 50 m.
  The stored audit includes the measured shortest path and local source-segment
  count. This network-access allowance is
  specific to Regional R-02/R-06; State S-08/S-11 retains its direct-intersection
  and size-threshold treatment.

---

## 4. Heavy-vehicle networks (NHVR)

**`nhvr_networks.json`** — per-road membership of the gazetted heavy-vehicle
networks.

- **Source:** the **NHVR National Network Map** downloadable GeoPackages:
  - NSW PBS Aggregate GML - Level 1 → the S-09 mandatory criterion
  - Road Train 32 m Approved Routes (layer 21) → the R-03 criterion
  - GML/CML 19 m B-double Routes over 50 tonnes → the R-04 mandatory
  - Heavy-vehicle Bypasses
- **S-09/R-04 method:** `dashboard/rebuild_pbs1_network.py` and
  `dashboard/rebuild_bdouble_network.py` compare each source line with approved
  NHVR road-segment geometry in Australian Albers (EPSG:3577). They measure the
  actual line length inside a 50 m PBS tolerance or 100 m B-double tolerance.
  PBS Level 1 passes above 80%; B-double passes at 80% or greater.
  Endpoint touches and crossings therefore contribute only the metres
  that overlap; they cannot approve an entire multi-kilometre source feature.
- **PBS rebuild:** use `nhvr_hvn_11240619.gpkg`, network
  `NSW- PBS Aggregate GML - Level 1`, then run
  `python3 dashboard/rebuild_pbs1_network.py --network <file> --apply` followed
  by `python3 dashboard/rebuild_road_units.py --apply`.
- **Rebuild:** download the current NSW GML/CML 19 m B-double GeoPackage from the
  map's **Download Network** action into `dashboard/data/geopackages/`, run
  `python3 dashboard/rebuild_bdouble_network.py --network <file> --apply`, then
  `python3 dashboard/rebuild_road_units.py --apply`.
- **Important:** the downloaded network is an assessment input, not a legally
  authorised network map. The live NHVR National Network Map remains the legal
  reference.

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
  each road's latitude. The connected-section and declared-road rebuild now derives
  the zone directly from final segment lengths rather than inheriting a legacy
  road-wide value. Urban distance must exceed rural distance; otherwise rural roads
  are Regional or Remote according to which side of the Newell contains more length.
  The current declared-road split is 516 Urban / 312 Regional / 93 Remote.
- **Criteria-family integrity:** `rebuild_road_units.py` maps Urban to the urban
  criteria family and Regional/Remote to the rural criteria family. Any row whose
  stored criteria family disagrees is recomputed from its final geometry and evidence.
  Unit and declared-road validation both fail the rebuild if even one mismatch remains.
  The July 2026 correction reduced the known mismatch count from 89 to zero.
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
  pass/fail against the State & Regional criteria, retained as rebuild inputs.
- **Declared-road outputs** (`rebuild_road_units.py`) —
  `nsw_declared_roads.json`, `nsw_declared_criteria.json`,
  `nsw_declared_recat.json`, `nsw_declared_evidence.json`,
  `nsw_declared_nhvr.json`, `nsw_declared_adt.json`,
  `nsw_declared_road_ext.json`, `nsw_declared_zone.json` and
  `export_declared_rows.json`. These are the dashboard's runtime identity,
  assessment and export layer.
- **Connected map-section outputs** (`rebuild_road_units.py`) —
  `nsw_unit_criteria.json`, `nsw_unit_recat.json`, `nsw_unit_evidence.json`,
  `nsw_unit_nhvr.json`, `nsw_unit_adt.json`, `nsw_unit_road_ext.json`,
  `nsw_unit_zone.json` and `export_unit_rows.json`. These retain section-level
  diagnostic results. `nsw_road_units.json` records the full topology audit.
- **`nsw_evidence.json`, `cv_evidence.json`, `nltn_evidence.json`** — the named
  entities each road connects (the clickable "why" in the detail panel).
- **`nsw_road_ext.json`** (`scratchpad/derive_local.py`) — pure-geometry topology:
  "links two State Roads", and "closely parallels another State Road within 20 km"
  (the mandatory no-parallel test).
- **Centre tiers** — Capital / Metropolitan / Regional City / Major Town / Town
  Centre, from ABS population counts.
- **Network-backed LDR** (`rebuild_network_ldr.py`, `network_connectivity.py`) —
  matches categorised routes to physical NSW Road Segment topology, assigns ABS
  UCL/SUA centres to connected components, and synchronises the criterion result,
  map colour and export. The derived corridor cache stays with the raw data rather
  than being committed to the dashboard.
- **Network-backed S-08/S-11** (`rebuild_state_facility_optional.py`) — requires a
  qualifying facility or commercial/industrial/employment area and an ABS centre
  on the same connected NSW Road Segment component. Employment areas must also
  intersect the selected categorisation geometry and meet the client-approved
  size-only threshold (Remote 5 ha; Regional 15 ha; Urban 40 ha). A 50 m network
  tolerance only reconciles the categorisation line with its matching physical
  road centreline; it cannot turn a displayed polygon-to-road gap into a pass.
  The size-only assessment basis is disclosed in the detail panel and comparison
  report. `rebuild_road_units.py` reruns this test for urban roads and
  for each unit of split road identifiers. This preserves matching ABS centres
  and facilities without copying one road-wide result to disconnected sections.
- **Exact employment-map evidence** (`rebuild_road_units.py`) — calculates the
  true boundary-to-road relationship for every intersecting employment polygon
  and the four closest non-intersecting polygons within 3 km. An intersection is
  labelled explicitly. A near miss keeps its measured distance and nearest-point
  connector, so the map can show even a small physical gap rather than implying
  contact from a representative point or fixed-radius circle.
- **Short Regional employment access paths** (`regional_employment_access.py`) —
  queries the 1.3-million-feature NSW Road Segment source around each nearby
  size-qualified employment polygon and runs a shortest-path test through
  endpoint-connected street segments. R-02/R-06 can use paths up to 2 km when
  the polygon is no more than 1.5 km directly from the assessed road. The detail
  panel reports the path length instead of relabelling the polygon as an
  intersection.

---

## 9. Known gaps (not available)

| Requirement | Status |
|---|---|
| **Statewide load limits** on bridges/structures | Not sourced — fragmented across TfNSW + councils; shown as "assumed compliant". |
| **Emergency evacuation routes** | **No statewide dataset exists** — only council PDFs + NSW SES *tsunami evacuation areas* (coastal polygons, not road routes). Investigated and confirmed unavailable. |
| **Interstate towns within 100 km of the border** | Skipped (needs QLD/VIC/SA town data; only NSW census is on disk). |
| **Commercial/industrial economic value** | Deliberately excluded from scoring under the client-approved size-only method. The software does not infer jobs, freight output or income from the available polygons. |
| **Measured ADT on roads without a nearby TfNSW counter** | The importer locates every usable TfNSW station observation to connected road geometry, including tightly overlapping named administrative records. Roads with no matching counter remain unavailable rather than borrowing traffic from a nearby, parallel or crossing road. B-double and PBS-1 remain available from segment-level flags. |

---

## Basemap

Map tiles are **CARTO "Voyager" (no labels)** — © OpenStreetMap contributors, ©
CARTO. The dashboard draws its own town labels on top.
