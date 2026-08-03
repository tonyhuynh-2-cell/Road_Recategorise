# PROJECT_CONTEXT.md

> Handover document for AI coding agents. Last written: 27 July 2026, from the `leon` branch.
> If you are a new agent picking this up: read this file first, then `DOMAIN_KNOWLEDGE.md`, then `STATUS.md`, then `AGENT.md` before touching code.

## 1. Project overview

This is the **NSW Road Recategorisation Assessment tool**, built for IPWEA (Institute of Public Works Engineering Australasia) / a NSW roads client (TfNSW-facing). It is a browser dashboard that tests every State and Regional road in NSW against Transport for NSW's official recategorisation criteria, and shows — visually, on a map, and in an exportable spreadsheet — which roads meet the criteria for their **current** classification and which don't.

It is **not** a tool that reclassifies roads. It is a **decision-support / audit tool**: "if TfNSW's own published criteria were applied mechanically to the data we have, which roads would pass and which would fail, and why." Every verdict must be traceable to real data — nothing is invented or asserted without evidence.

## 2. Client background and business problem

TfNSW publishes a document called *Approach to road recategorisation – Definitions and criteria* (the "criteria guide", current snapshot December 2025, PDF stored at `dashboard/data/approach-to-road-recategorisation-definitions-and-criteria-snapshot-reference-guide-december-2025.pdf`). It defines rules for classifying roads as **State**, **Regional**, or **Local**, based on things like:

- what population centres the road connects
- whether it connects to hospitals, ports, airports, intermodals, or large employment/industrial precincts
- heavy-vehicle network access (PBS Level 1, PBS 2B, 19m B-double, road-train)
- traffic volume and heavy-vehicle percentage thresholds
- whether it duplicates ("closely parallels") another State Road

Applying these criteria manually, road-by-road, across the ~900+ State and Regional roads in NSW is impractical. The client wants a tool that:

1. Applies the criteria mechanically and consistently across the whole network
2. Shows the road manager **why** each road passed or failed (not just a colour)
3. Lets them export results for reporting
4. Lets them test "what if" scenarios (different thresholds, different assumptions) without re-running the whole pipeline
5. Is auditable — every number must be traceable to a named dataset

The client has been iteratively reviewing outputs and flagging places where the software's interpretation of the guide didn't match their intent (see `CRITERIA_ISSUES.md` for the formal log of these interpretation calls). This is an evolving, actively-audited system, not a "build once and ship" project.

## 3. Project goals

- Faithfully implement the TfNSW criteria guide's rules in code, road-by-road, statewide
- Make every verdict explorable — a road manager should be able to click any road and see exactly which criteria passed/failed and why, with the actual connected centre/facility named
- Support scenario testing (cross-category tests, "Best fit" re-binning, and force-pass criteria overrides)
- Support at least one detailed local case study (Clarence Valley LGA) and one large metro case study (Sydney)
- Be exportable to Excel for offline review and reporting
- Be transparent about **data gaps** — where no data exists (e.g. statewide bridge load limits, emergency evacuation routes), the tool says so rather than assuming a pass

## 4. Scope and non-goals

**In scope:**
- State and Regional road criteria (all clauses in the guide that have identifiable, obtainable data)
- Nationally Significant network (NLTN 2020) as its own lens
- Clarence Valley and Sydney as focus views ("Area" dropdown)
- Local roads only as an indicative, on-demand OpenStreetMap-loaded overlay (not a statewide dataset)
- Excel export of results
- A "Criteria Overrides" scenario panel with force-pass toggles for testing criteria sensitivity

**Out of scope / explicitly not attempted:**
- Reclassifying any road (this is an assessment tool, not an authority)
- Statewide bridge/structure load limits (data doesn't exist in an obtainable form)
- Statewide emergency evacuation routes (no dataset exists — investigated and confirmed absent)
- Interstate connectivity (would require QLD/VIC/SA census data — not sourced)
- Commercial/industrial **economic value** scoring (client explicitly decided land-area-only thresholds instead — see `CRITERIA_ISSUES.md` CI-02)
- A statewide local-road dataset/assessment (local roads are only loaded live, per-suburb, from OpenStreetMap when a user searches — there is no local road geometry for all of NSW in this repo)

## 5. High-level architecture

Two halves, no backend server, no database:

1. **Offline Python data pipeline** (`dashboard/*.py`, ~25 scripts) — reads large source datasets (NHVR GeoPackages, ABS census/geometry, TfNSW road network, planning zoning, traffic counts) and produces small, pre-computed JSON/GeoJSON files under `dashboard/data/`. This is run manually by a developer/analyst whenever source data changes or a criteria rule changes. It is **not** run at request time.

2. **Static browser dashboard** (`dashboard/index.html` + `dashboard/js/*.js` + `dashboard/css/dashboard.css`) — loads the pre-computed JSON files via `fetch`, builds a Leaflet map, and renders all UI (sidebar stats, road detail panel, criteria reference, exports, criteria overrides) entirely client-side, no bundler. It's served with a trivial static file server (`python -m http.server 8080` during development — see `ONBOARDING.md`).

There is no live database and no server-side logic at runtime. All "computation" you see in the browser (verdicts, counts, %s) is either read directly from the pre-computed JSON, or recomputed cheaply in JS from that same JSON (e.g. the Criteria Overrides panel re-derives verdicts client-side from cached per-road facts).

## 6. Repository structure

```
Road_Recategorise/
├── dashboard/
│   ├── index.html                  # single-page app shell; all markup lives here
│   ├── css/dashboard.css           # all styling (no CSS framework)
│   ├── js/                         # ~15 plain <script> files, loaded via document.write in index.html
│   │   ├── config.js               # constants, colour palette, per-lens copy (NSW_VIEW_META), icons
│   │   ├── state.js                # Leaflet map instance + all shared mutable globals (let X, Y, Z)
│   │   ├── utils.js                # pure helpers: roadKeyOf, roadLenKm, evCentres/evList (evidence rows)
│   │   ├── init.js                 # boots the app: fetches all data files, builds road-layer groups
│   │   ├── grading.js              # verdict → style mapping (nswStyle/cvStyle), criteria overrides logic
│   │   ├── panels.js               # tab switching, Area dropdown, sidebar stat refresh, map legend
│   │   ├── detail.js               # Road Detail side panel (click a road → see criteria breakdown)
│   │   ├── criteria.js             # Criteria Reference modal (the TfNSW guide, rendered as HTML)
│   │   ├── overview.js             # "Dashboard overview" full-page stats view (charts, mini-map)
│   │   ├── search.js               # road name/ID search box
│   │   ├── flagged.js              # up-to-10 flagged roads (localStorage), Flagged tab
│   │   ├── export.js               # ExcelJS-based export of assessment rows
│   │   ├── local.js                # Local tab: on-demand OSM/Overpass suburb road loading + clipping
│   │   ├── suburbs.js              # suburb search/geocoding support for the Local tab
│   │   └── trace.js                # "Live Code Trace" floating panel — explains what code just ran
│   ├── data/                       # ~55 pre-computed JSON/GeoJSON files consumed by the dashboard
│   │   └── newdata/                # raw NHVR GeoPackages + UCL shapefile (NOT tracked by git — large binaries)
│   ├── process_data.py             # FIRST-GENERATION Clarence Valley criteria engine (legacy, still referenced)
│   ├── process_nsw.py              # FIRST-GENERATION statewide criteria engine (legacy, no-ADT version)
│   ├── rebuild_*.py                # ~20 INCREMENTAL rebuild scripts — each patches one criterion/feature
│   │                                #   into the existing data/*.json without re-running the whole pipeline
│   ├── network_connectivity.py     # shared geometry/topology helper library (DisjointSet, connected components)
│   ├── regional_employment_access.py
│   ├── apply_schedule_fixes.py     # corrects admin_class per the TfNSW Schedule of Classified Roads
│   ├── build_map_locality_centres.py
│   └── test_*.py                   # a handful of pytest-style test scripts for specific rebuild scripts
├── POI/                            # source POI shapefiles/GeoJSON (hospitals, ports, SUA boundaries, census)
├── scripts/download_nsw_road_segments.py  # resumable downloader for the 1.37M-feature road segment GeoPackage
├── nsw_road_network_categorisation.geojson # ~56MB: TfNSW's current road classification (source of truth)
├── DATA_SOURCES.md                 # exhaustive, up-to-date data provenance document (READ THIS)
├── CRITERIA_ISSUES.md              # formal log of ambiguous criteria + how the software resolved them (READ THIS)
├── criteria_audit.md               # older audit vs criteria — some content now superseded, see STATUS.md
├── data_requirements.md            # original project-kickoff data requirements doc (historical)
├── FEATURES_CODE_WALKTHROUGH.md    # plain-English + code-snippet walkthrough of every dashboard feature
└── docs/                           # <-- this handover package
```

## 7. Technology stack

**Frontend:**
- Vanilla HTML/CSS/JavaScript — **no framework** (no React/Vue/etc.), **no build step**, **no bundler**, **no TypeScript**
- Leaflet 1.9.4 (loaded from `unpkg.com` CDN) — map rendering, canvas-based road overlay
- Chart.js 4.4.1 (CDN) — used only in the Dashboard Overview page's mini charts
- ExcelJS (loaded lazily, likely CDN — check `export.js`) — builds the Excel export workbook client-side
- CARTO Voyager (no-labels) basemap tiles

**Backend / data pipeline:**
- Python 3 with GeoPandas, Shapely, Pandas, NumPy, SciPy (`cKDTree` is used for spatial nearest-neighbour work), `pyogrio` for fast GeoPackage reads
- No web framework, no API server — these are one-shot CLI scripts run by a human
- Outputs are plain JSON (usually **single-line**, `ensure_ascii=False`) written directly into `dashboard/data/`

**Serving:**
- Static file server only. In development: `python -m http.server 8080` from inside `dashboard/`
- Any static host would work in production (no server-side runtime is required)

**Version control:**
- Git, hosted on GitHub (`tonyhuynh-2-cell/Road_Recategorise`)
- Multiple long-lived feature branches exist simultaneously (see `AGENT.md` git workflow section) — this is unusual and worth understanding before you branch/merge anything

## 8. Major components and their responsibilities

| Component | File(s) | Responsibility |
|---|---|---|
| Map engine | `state.js` | Owns the single Leaflet `map` object, all panes/renderers, selection state, scale bar, zoom-dependent label visibility |
| Criteria/verdict styling | `grading.js` | Decides road colour per current lens (`nswStyle`), lens membership (`nswInView`), cross-test re-grading (`buildXtest`), "Best fit" re-binning (`buildFresh`), and now the **Criteria Overrides** scenario engine |
| Tab/lens/area navigation | `panels.js` | `switchTab()`, the Category+Area dropdown interaction, sidebar stat refresh (`refreshOverview`, `refreshNswView`, `refreshRegion` for CV/Sydney), floating map legend |
| Road Detail panel | `detail.js` | Per-road criteria breakdown, cross-category test dropdown, Sections dropdown (for roads split into multiple assessment units), evidence display |
| Data loading | `init.js` | Fetches ~30 JSON/GeoJSON files in parallel at boot, builds per-road aggregates (`NSW_AGG`), groups Leaflet layers by road key, wires click handlers |
| Criteria Reference | `criteria.js` | Renders the TfNSW guide as an in-app HTML reference, road-aware (auto-scrolls/highlights the section relevant to the currently open road) |
| Dashboard Overview | `overview.js` | Full-page statewide statistics view with its own mini Leaflet map and Chart.js charts |
| Export | `export.js` | Builds an Excel workbook client-side from `export_rows.json` filtered by the current scope |
| Local roads | `local.js`, `suburbs.js` | On-demand Overpass/OSM queries for one suburb at a time; clips to suburb boundary; indicative cross-tests only |
| Flagging | `flagged.js` | Up to 10 roads pinned via `localStorage`, independent of any assessment logic |
| Offline criteria engine (current) | `dashboard/rebuild_road_units.py` | THE canonical current pipeline: builds connected/class-consistent "declared roads" from raw geometry, recomputes criteria for each, writes all `nsw_declared_*.json` and `nsw_unit_*.json` outputs |
| Offline criteria engine (legacy) | `process_data.py`, `process_nsw.py` | First-generation scorers, superseded but some of their output shape is still what the dashboard reads (`nsw_criteria.json`, `nsw_evidence.json`) — see `DECISIONS.md` |
| Incremental rebuild scripts | `dashboard/rebuild_*.py` | Each one patches a SINGLE criterion or feature into the live `data/*.json` files without re-running the full pipeline. This is the actual day-to-day pattern of how criteria bugs get fixed. |

## 9. Data pipeline

The pipeline is **not a single script**. It is an accretive series of one-purpose Python scripts, each of which:

1. Reads the *current* `dashboard/data/*.json` (or a `.preXyzFix.bak` backup if one exists, to stay idempotent)
2. Reads whatever raw source data it needs (NHVR GeoPackage, ABS shapefile, planning zoning, etc.)
3. Recomputes ONE specific criterion or ONE specific field
4. Runs a **validation gate**: it must reproduce 100% of the *unrelated* existing verdicts before it's allowed to write anything. If validation fails, the script aborts (see `criteria_audit.md`-style safety pattern, and the `rebuild_r05_urban_centres.py` "VALIDATION GATE FAILED" pattern)
5. Backs up the file it's about to modify (`<name>.pre<Feature>.bak`) if no backup already exists
6. Writes the updated JSON — typically dry-run by default, `--apply` flag required to actually write

**Why this pattern exists:** re-running the entire pipeline from raw sources every time a single criterion is tweaked is slow, hard to review, and risks silently changing unrelated verdicts. The incremental-patch-with-validation-gate pattern lets a reviewer see exactly what changed and why, road-by-road.

The **newest and most complete engine** is `rebuild_road_units.py`, which:
- Splits TfNSW's `road_number` (an administrative identifier, not a guaranteed single physical road) into **connected, class-consistent "road units"**
- Groups those units back into one **"declared road"** per official classified road number — this is the identity the dashboard actually scores, selects and exports (see `DECISIONS.md` for why this two-level model exists)
- Re-derives urban/regional/remote zone, B-double/road-train network coverage, and facility/centre connectivity per unit
- Outputs `nsw_declared_*.json` (the dashboard's real runtime layer) and `nsw_unit_*.json` (diagnostic/audit layer, still loaded by the dashboard for the Sections dropdown)

## 10. How data flows through the application

1. Developer runs Python rebuild scripts → writes/updates files in `dashboard/data/`
2. Browser loads `dashboard/index.html`
3. `init.js` fires `Promise.all([...fetch calls...])` for every data file, cache-busted with `?v=Date.now()` — **this means every page load re-fetches everything; there is no client-side data caching between sessions**
4. `init.js` builds `window.NSW_AGG` (one aggregate row per road, summed across its segments), `window.NSW_CRIT` (criteria/verdict per road), `window.NSW_EVID` (named evidence per road), `window.NHVR`, `window.ADT`, `window.ROAD_EXT`, `window.ZONE`, etc. — all as top-level `window.*` globals
5. `init.js` builds the Leaflet GeoJSON layer for the road overlay, grouping segments into `window.NSW_ROAD_LAYERS[roadKey]` so a click on any one segment highlights the whole road
6. `grading.js`'s `nswStyle(feature)` is called by Leaflet per-feature to decide colour/weight/visibility, reading `window.NSW_CRIT` and the current tab/lens state
7. User interactions (tab switch, Area dropdown, click a road, toggle a Criteria Override) all mutate a handful of shared globals in `state.js`/`panels.js`/`grading.js` (`currentTab`, `nswView`, `_activeArea`, `legendToggles`, `criteriaOverrides`) and then call `nswLayer.setStyle(nswStyle)` to force Leaflet to re-render
8. Nothing is ever sent back to a server. Export writes an `.xlsx` file directly in the browser via ExcelJS and triggers a download.

## 11. Current implementation status

See `STATUS.md` for the full breakdown. Summary:

**Completed and stable:**
- Statewide State/Regional road map with verdict colouring
- Nationally Significant (NLTN) lens
- Sydney and Clarence Valley LGA focus views, now correctly filtering sidebar stats by the active road-category lens
- Road Detail panel with criteria breakdown, evidence, cross-category tests, "Sections" for split roads
- Search, Flagging, Excel export
- Criteria Reference modal (renders the TfNSW guide, road-aware)
- Criteria Overrides scenario panel with force-pass toggles and real-time map/sidebar recolouring
- Local road on-demand loading (per suburb) with indicative cross-tests

**Partially implemented / known-limited:**
- Traffic (AADT/HV%) criterion — real data exists for 376 of 921 declared roads only; the rest show "not assessed", not a forced pass or fail
- B-double coverage threshold (R-04) — currently a flat 80%-of-length rule; there's ongoing debate (see `DECISIONS.md` and `STATUS.md`) about whether this threshold is too strict given real-world data/geometry misalignment
- Employment centre thresholds (land-area-only, per zone) — implemented, but this is a client-approved simplification, not a literal reading of the guide (guide references $ value + hectares; $ value data doesn't exist statewide)
- "Connects" — the geometric/topological meaning of "connects" in the guide is still an open interpretation (`CRITERIA_ISSUES.md` CI-01); current implementation uses connected-road-component + named-centre/facility matching, which is a reasonable but not officially confirmed interpretation

**Not implemented (by design — no data):**
- Bridge/structure load limits
- Emergency evacuation routes
- Interstate connectivity
- Statewide local-road assessment

## 12. Important dependencies

- **Leaflet 1.9.4** — pinned via CDN URL in `index.html`. Do not upgrade casually; canvas rendering behaviour (`preferCanvas: true`, shared canvas renderer with click tolerance) is deliberately tuned and fragile to Leaflet version changes.
- **Chart.js 4.4.1** — used only in `overview.js`.
- **ExcelJS** — used only in `export.js`.
- **GeoPandas / Shapely / pyogrio / SciPy** — Python side. `pyogrio` specifically for fast GeoPackage reads of the 1.37M-feature road segment dataset.
- **No package.json, no npm, no pip requirements.txt found in the repo** — dependencies are assumed pre-installed on the analyst's machine. This is a gap; see `KNOWN_ASSUMPTIONS.md`.

## 13. External datasets used

Full detail lives in `DATA_SOURCES.md` — treat that file as authoritative and read it before changing any data pipeline script. Headline sources:

- TfNSW NSW Road Network Categorisation (current road classification — the "ground truth" being tested)
- TfNSW Schedule of Classified Roads and Unclassified Regional Roads, Version 18 (March 2026) — legal record used to correct mis-classified segments
- TfNSW NSW Roads Traffic Volume Counts (open data) — AADT/HV%
- NHVR National Network Map GeoPackages — PBS Level 1, PBS 2B, 19m B-double, road-train, HV bypass
- NLTN Determination 2020 (data.gov.au) — national network
- ABS Census 2021 (UCL, SUA, SAL, SA3 population tables) — population centre tiers
- NSW Employment Lands Development Monitor (ELDM) 2025 + NSW Planning EPI zoning — employment/industrial centres
- NSW Transport Theme GDA2020 RoadSegment layer (1.37M features) — physical road centreline topology for connectivity tests
- Known-location POI files for hospitals, ports, airports, intermodals (hand-compiled, not a live feed)

## 14. Important configuration

- No environment variables, no `.env` file, no secrets — this is a fully static, client-side app with no auth
- `dashboard/js/config.js` holds the tunable constants that DO exist in code: `LOCAL_ZOOM = 14`, `TOWN_LABEL_SCALE_METRES = 2000`, `ROAD_COLORS`, per-lens copy (`NSW_VIEW_META`)
- Python rebuild scripts each define their own thresholds as module-level constants near the top of the file (e.g. `UNIT_SNAP_M = 200.0`, `COMPATIBLE_GAP_M = 1_000.0`, `MICRO_COMPONENT_KM = 0.35` in `rebuild_road_units.py`) — there is **no centralised config file** for pipeline thresholds. Changing a threshold means editing the specific script.
- `.claude/settings.json` and `.vscode/settings.json` exist but are editor/tooling config, not application config

## 15. Development workflow

There is no build step. To work on the frontend:
1. `cd dashboard`
2. `python -m http.server 8080`
3. Open `http://localhost:8080`
4. Edit any `.js`/`.css`/`.html` file and hard-refresh the browser (Ctrl+Shift+R) — there is no hot reload, and browsers aggressively cache these files, so hard refresh is frequently necessary even though `init.js` cache-busts its own data fetches

To work on the data pipeline: run the relevant `dashboard/rebuild_*.py` script directly with Python. Most support a dry-run mode by default and require `--apply` to write. **Always run dry-run first and read the impact summary before applying.**

## 16. Git workflow

See `AGENT.md` for the full rules. Key facts a new agent must know:

- There are currently 6+ long-lived branches on `origin`: `main`, `leon`, `ui-style-cleanup`, `orange-split-B`, `orange-split-C`, `dashboard-redesign`, `hisham`, `saud` — this is **not** a clean trunk-based workflow. Different people/sessions have been working on parallel branches and merging opportunistically.
- Large binary GeoPackage/shapefile files under `dashboard/data/newdata/` were **removed from git tracking** (see commit "Remove large binary data files from tracking") after they caused push timeouts (HTTP 408). Do not re-add large binaries to git. If a script needs them, document that they must be sourced locally and are gitignored (or should be).
- Merges between branches have hit real conflicts before (e.g. `panels.js`, `detail.js`, `state.js` — see git log). When merging, read the conflict carefully; "take theirs" is not always correct — check `DECISIONS.md` and recent commit messages for context on *why* a change was made before blindly picking a side.

## 17. Coding conventions

- Plain ES5/ES6 JavaScript, no modules, no `import`/`export` — every `.js` file relies on other files having already run and defined globals. **Load order in `index.html` matters.**
- Mix of `function foo() {}` declarations and `const foo = () => {}` — no single house style; match whatever is already in the file you're editing
- Heavy use of inline comments explaining *why*, not just *what* — this is a deliberately well-commented codebase. Preserve this style; don't strip comments during edits.
- CSS is one large file, plain CSS (no preprocessor), using CSS custom properties (`var(--ink)`, `var(--muted)`, etc.) for theming (light/dark mode via `body.dark-mode`)
- Python: snake_case, dataclass-free plain dicts/lists mostly, `argparse`-free (checks `"--apply" in sys.argv` directly instead of using `argparse` — a repeated pattern across rebuild scripts, kept for consistency)

## 18. Error handling philosophy

- Frontend: extremely defensive — nearly every function checks `typeof X !== 'undefined'` or `if (!el) return;` before touching a DOM element or global. This is because scripts load in a fixed order and some functions may be called before their dependencies exist (e.g. during a live-reload).
- Data gaps are surfaced, never silently assumed. E.g. traffic criterion is `null` (not assessed) when no AADT data exists for a road — it is never assumed to pass OR fail.
- Python pipeline scripts use a **validation gate** pattern: before writing anything, re-verify that the existing verdict rule reproduces already-known-correct results. If it doesn't, abort with a clear message rather than writing possibly-corrupted data.

## 19. Testing strategy

- A handful of `dashboard/test_*.py` files exist (pytest-style) for specific rebuild scripts (`test_rebuild_adt.py`, `test_rebuild_bdouble_network.py`, `test_rebuild_employment_centres.py`, `test_regional_employment_access.py`, `test_declared_road_groups.py`, `test_map_locality_centres.py`). These test the **data pipeline**, not the frontend.
- **There is no frontend test suite.** No Jest, no Playwright, no Cypress. All frontend verification has been manual (visual, in-browser) during this project's development so far.
- The de facto frontend "test" is the developer/analyst manually checking specific roads' criteria breakdowns against the TfNSW guide by hand, and the client reviewing dashboard output and reporting discrepancies (which become entries in `CRITERIA_ISSUES.md`).

## 20. Performance considerations

- The road overlay is ~17,600–20,000+ GeoJSON features rendered on a **single shared Leaflet canvas** (`preferCanvas: true`, one `L.canvas({ tolerance: 1.5 })` renderer). This was a deliberate choice — per-layer canvases were found to break click hit-testing across tab switches (documented in code comments in `state.js`).
- Restyling all features (`nswLayer.setStyle(nswStyle)`) is the main hot path — it's called on every tab switch, lens change, legend toggle, and Criteria Override change. It runs in roughly 50–100ms, acceptable but not free.
- Locality-centre pins (SAL suburbs, ~1,265 points) previously used Leaflet's `permanent: true` tooltip on every marker, which meant 1,265 always-rendered DOM elements that Leaflet had to reposition on every pan/zoom — this caused severe zoom lag and was fixed by switching to `permanent: false` (hover-only tooltips). **This is a real, previously-diagnosed performance bug — if lag reappears near the Localities toggle, check this first.**
- A separate, more serious zoom-rendering bug (roads becoming giant unscaled colour blobs on zoom) was traced to a **JavaScript `ReferenceError`** (`LABEL_ZOOM` was referenced but never defined after a merge) thrown inside a `zoomend` event handler, which silently broke Leaflet's internal zoom/redraw cycle for the whole map. **Lesson: an uncaught exception inside any `map.on(...)` handler can corrupt canvas rendering for the entire map, not just fail gracefully.** Always check the browser console for errors first when diagnosing any "the map looks broken after zoom" report.

## 21. Future roadmap

See `STATUS.md` "Highest priority next tasks" for the concrete near-term list. Directionally, ideas discussed but not committed to:
- Fixing the S-08 State facility criterion to include Commercial/Industrial/Employment centres (currently only hospitals/ports/airports/intermodals are counted for State roads — Regional already includes employment; this is a confirmed gap, not just a discussion point — see `STATUS.md` known bugs)
- Investigating whether the B-double 80%-coverage threshold is systematically too strict (evidence gathered: most "failing" roads have 70–80% coverage, i.e. near-misses, not zero coverage — see `DECISIONS.md`)
- Possible statewide local-road ingestion so local→Regional/State "upgrade candidate" analysis becomes possible (currently blocked — no statewide local road geometry in the repo)
- Any future numeric threshold scenario testing should use the authoritative Python pipeline rather than an approximate browser-side reimplementation
