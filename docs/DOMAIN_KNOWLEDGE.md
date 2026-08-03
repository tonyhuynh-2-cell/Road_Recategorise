# DOMAIN_KNOWLEDGE.md

> Everything you need to understand about the road-recategorisation domain to work on this project competently. If you're an AI agent with no prior context on Australian road classification, read this fully before touching criteria logic.

## Why this project exists

In New South Wales, Australia, public roads are administratively classified into a hierarchy — broadly, **State Roads** (major arterial roads, managed and funded by the state government / Transport for NSW), **Regional Roads** (secondary but still state-significant roads, funding shared between state and local government), and **Local Roads** (managed by local councils). This classification determines who pays for and maintains the road, and what design/access standards apply (e.g. which roads must accommodate B-double or road-train heavy vehicles).

Transport for NSW (TfNSW) periodically reviews whether roads are still correctly classified, using a published set of objective criteria (the "criteria guide"). Applying that guide by hand to every road in the state is impractical — this project automates that application, road by road, and shows the result on an interactive map with full evidentiary drill-down.

**This is fundamentally an audit/decision-support tool, not a reclassification authority.** Its output should be read as "here is what the published criteria say about this road, given the best available data" — not as an official reclassification. The distinction matters: if you ever find yourself writing code that "reclassifies" a road or asserts a definitive real-world classification change, stop — that's outside this project's stated purpose.

## The TfNSW criteria guide

The controlling document is *Approach to road recategorisation – Definitions and criteria* (current snapshot: December 2025). A copy is stored at `dashboard/data/approach-to-road-recategorisation-definitions-and-criteria-snapshot-reference-guide-december-2025.pdf`, and the dashboard also renders an HTML version of it in-app (`dashboard/data/criteria-reference.html`, opened via the "Criteria Reference" button).

The guide defines criteria per road category, split further by area type (urban vs. remote/regional). Each category has:
- **Mandatory criteria** — a road MUST pass ALL of these, or it fails outright (verdict = red), regardless of optional criteria
- **Optional criteria** — a road needs to pass **at least 2 of the listed optional criteria** to fully meet the category (verdict = green). Passing exactly 1 optional criterion, with mandatory criteria satisfied, gives an intermediate "orange" verdict (would likely pass with more evidence, e.g. traffic data). Passing 0 optional criteria (even with mandatory satisfied) is red.

### Criteria codes used throughout the codebase

These codes appear directly in code, comments, and UI text — memorise them, they're the vocabulary of this whole project:

**Nationally Significant (National Land Transport Network):**
- S-01: On the NLTN (National Land Transport Network)
- S-02/S-03: Connects Regional City ↔ Capital/Metro, or Metro ↔ Metro
- S-04/S-05: Connects a Metro/Intermodal to a Major Port, or Metro to an International Airport
- S-06: PBS Level 2B heavy-vehicle access

**State Roads — Remote & Regional:**
- S-07 (optional): Connects Metropolitan Centres / Regional Cities / Major Towns to each other
- S-08 (optional): Connects Major Hospitals / Major Ports / Major Intermodals / International Airports / Commercial / Industrial / Employment Centres to other centre types
- S-09 (mandatory): PBS Level 1 heavy-vehicle access
- "Parallel" (mandatory): does NOT closely parallel another existing State Road within a stated distance, unless traffic volumes are similarly high
- LDR (unnumbered optional, State-specific, rural only): connects a State-tier source centre to a Town Centre via a qualifying long-distance rural route (≥25km connected component)
- Traffic (optional): AADT + heavy-vehicle % thresholds (Urban >10,000 AADT / Rural >7,000 AADT for State; heavy-vehicle % threshold also applies)

**State Roads — Urban/Within Centres:**
- S-10 (optional): Connects Metro Centres / Regional Cities / Major Urban Centres / Major Towns to each other (urban-specific centre-tier set, different from S-07's rural set)
- S-11 (optional): Same facility-connection idea as S-08, but for the urban centre-tier set

**Regional Roads — Remote & Regional:**
- R-01 (optional): Connects Urban/Town Centres to each other (rural centre-tier set)
- R-02 (optional): Connects facilities/employment centres to Town/Urban Centres (rural)
- R-03 (optional, rural only): On the NHVR road-train network
- R-04 (mandatory): 19m B-double heavy-vehicle access (GML/CML network)
- "Two State" (unnumbered optional, rural only): links two distinct State Roads (a geometry/topology test)
- Traffic (optional): lower thresholds than State (Urban >7,000 / Rural >2,000 AADT)

**Regional Roads — Urban/Within Centres:**
- R-05 (optional): Connects Metropolitan Centres / Major Urban Centres / Major Towns to each other — **note:** for urban roads this needs ≥2 *distinct* qualifying centres, historically a bug where a single touch of one Significant Urban Area (e.g. "Sydney") over-credited roads; now fixed to require genuine multi-centre connectivity at suburb (SAL) granularity
- R-06 (optional): Facility connection, urban centre-tier set

**Verdict rule (same shape for every category):**
```
if not all_mandatory_criteria_pass: verdict = red
elif optional_criteria_met >= 2:     verdict = green
elif optional_criteria_met == 1:     verdict = orange
else:                                verdict = red
```

## Why this project exists — the client's actual pain points

From the interpretation log (`CRITERIA_ISSUES.md`) and project conversations, the recurring themes are:

1. **The guide's language is not a technical specification.** Words like "connects" are never precisely defined (does it mean the road's endpoint touches the place? Passes near it? Is on the same continuous stretch of road as it?). This project had to invent a reasonable, documented, and disclosed interpretation (connected-road-component + named-evidence matching) rather than waiting for a precise spec that will likely never arrive. See `CRITERIA_ISSUES.md` CI-01.

2. **Some required data simply doesn't exist as a usable statewide dataset.** Bridge load limits, emergency evacuation routes, and comparable economic-value figures for employment centres were all investigated and confirmed absent or too fragmented to use. The project's philosophy is to say "not assessed" rather than assume a road passes or fails a criterion it has no data for.

3. **One administrative road number can be legally one road but geographically several disconnected pieces**, or can be shared/reused across genuinely different corridors. This caused real confusion (one road showing contradictory verdicts) until the "declared road" / "road unit" two-level model was introduced (see `DECISIONS.md` D-04).

4. **The client wants to sanity-check the tool's assumptions interactively**, not just receive a final report — hence the Criteria Overrides scenario panel, which can force-pass criteria and show the impact live.

## Manual vs automated criteria

Not every criterion clause can be automated with available data. As a rule of thumb in this codebase:

**Fully automated (real geospatial/statistical tests):**
- Centre connectivity (S-07/S-10/R-01/R-05) — via ABS population centre data + connected road geometry
- Facility connectivity (S-08/S-11/R-02/R-06) — via POI location data + connected road geometry + (for employment centres) land-area thresholds
- Heavy-vehicle network access (S-09, R-03, R-04, S-06) — via NHVR GeoPackage spatial matching
- NLTN membership (S-01) — via NLTN Determination 2020 spatial data
- Traffic volume/heavy-vehicle % (where TfNSW counter data exists near the road)
- "Links two State Roads" — pure geometry/topology test on road endpoints
- Long-distance rural route (LDR) — connected-component length + centre-tier matching

**Partially automated / approximated:**
- "Does not closely parallel another State Road" — implemented as a geometric proximity test in some code paths; not confirmed as fully matching the guide's intended "similar traffic volumes" exception clause in every case
- Employment centre importance — land area only, not the guide's literal $-value + hectare combined test (client-approved simplification, see `DECISIONS.md` D-05)

**Not automated at all — genuinely absent data:**
- Bridge/structure load limits (fragmented across TfNSW + individual councils, no statewide register)
- Emergency evacuation routes (no statewide road-route dataset exists; only NSW SES tsunami-evacuation AREA polygons, which are not the same thing as designated evacuation road routes)
- Interstate connectivity thresholds (would need QLD/VIC/SA census data, not sourced)

## Important terminology (glossary)

| Term | Meaning in this project |
|---|---|
| **Declared road** | The TfNSW-official classified road identity that the dashboard actually scores, selects, and exports — one verdict per declared road, regardless of how many disconnected map sections it spans |
| **Road unit** | A connected, class-consistent chunk of geometry — the diagnostic/audit-level building block that gets grouped into declared roads. Multiple units can belong to one declared road. |
| **Admin class** | `S` (State Road) or `R` (Regional Road) — the TfNSW-gazetted category currently assigned to a road, i.e. what's being *tested* against the criteria |
| **Verdict** | green / orange / red — the outcome of applying a category's criteria to a road |
| **Zone / area** | Urban vs Rural (binary, `area` field) and Urban / Regional / Remote (three-tier, `zone` field, where Remote = rural AND west of the Newell Highway) — two different classification systems used for different purposes (which criteria variant applies, vs traffic/LDR thresholds) |
| **NLTN** | National Land Transport Network — the Australian Government's national road network, separate from and layered on top of the NSW State/Regional classification |
| **NHVR** | National Heavy Vehicle Regulator — publishes gazetted heavy-vehicle access networks (PBS Level 1, PBS 2B, 19m B-double, road-train) |
| **PBS** | Performance-Based Standards — a heavy-vehicle access classification scheme (Level 1, Level 2B, etc.) |
| **B-double / Road train** | Types of long/heavy multi-trailer trucks; specific road networks are gazetted as approved for their use |
| **AADT** | Annual Average Daily Traffic — the standard measure of a road's traffic volume |
| **HV%** | Heavy-vehicle percentage of AADT |
| **SUA** | Significant Urban Area (ABS 2021 geography) — used for major metro-scale connectivity |
| **SAL** | Suburb and Locality (ABS 2021 geography) — finer-grained than SUA, used to fix the "urban roads only touch one giant SUA" over-crediting bug for R-05/S-10 |
| **UCL** | Urban Centre and Locality (ABS geography) — an earlier/parallel population-centre geography, still used in some LDR and centre-tier logic |
| **ELDM** | Employment Lands Development Monitor — NSW Planning's dataset of current employment/industrial precincts |
| **EPI** | Environmental Planning Instrument — NSW Planning zoning layer, used as the statewide fallback for employment-centre detection outside ELDM coverage |
| **"Cross-test" / "cross-category test"** | Re-grading a road against a DIFFERENT category's criteria than its own current classification, to answer "what if this were tested as State/Regional/National instead?" |
| **"Best fit" / "Fresh" bin** | A blank-slate re-classification of every road purely from earned criteria, ignoring its current administrative classification entirely |
| **LGA** | Local Government Area — a source-data boundary type. The dashboard's broader **Area** dropdown currently offers Sydney and Clarence Valley focus views. |
| **Criteria Overrides panel** | The scenario-testing UI that lets a user force-pass criteria and see the impact live, without changing the underlying pipeline output |

## Limitations to keep in mind

- **The tool's verdicts are only as good as the underlying data's spatial accuracy.** Two independently-surveyed datasets (e.g. TfNSW road network vs NHVR network) will never align perfectly; thresholds like "80% coverage" are attempts to be robust to this misalignment, but as documented in `DECISIONS.md` D-06, there's real evidence the current threshold may be miscalibrated.
- **"Connects" is an interpreted term, not a defined one.** Any code you write that touches connectivity logic is implementing one reasonable interpretation among several possible ones — see `CRITERIA_ISSUES.md` CI-01 for the honest, disclosed uncertainty here.
- **Employment centre scoring is a client-approved simplification (land area only), not the guide's literal combined $-value + hectare test.** This is disclosed in the UI and evidence data, but don't assume it's "the correct" reading of the guide in some abstract sense — it's the practically achievable reading given available data.
- **The tool does not and should not assert a road's TRUE correct classification.** It reports what the published criteria say given available data. Communicate this distinction if you're ever asked to summarise results for a non-technical audience.
