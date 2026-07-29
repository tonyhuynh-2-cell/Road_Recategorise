# Criteria Assessment Audit

**Road Recategorisation Tool — `main` branch vs TfNSW Criteria**

Assessed: 30 June 2026

---

## Nationally Significant State Roads

| Criteria ID | Criterion | Data Source | Method | Status |
|---|---|---|---|---|
| S-01 | On the NLTN | `nltn_2020_road.geojson` (NLTN Determination 2020, data.gov.au) | Separate NLTN layer; per-segment tagged via spatial join from `nsw_nltn.json` | ✅ Accurate — authoritative source |
| S-02 | Connects Regional City → Capital/Metro | `nltn_evidence.json` (precomputed) | `_natMetros` flag in `nltn_meta.json` | ⚠️ Precomputed offline — logic not in repo. Collapsed with S-03 |
| S-03 | Connects Metro → Metro | Same as S-02 | Merged into `_natMetros` flag | ⚠️ Collapsed — doesn't distinguish from S-02 |
| S-04 | Connects Metro → International Airport | `nltn_meta.json` → `_natPortair` | Precomputed flag | ⚠️ Collapsed with S-05 |
| S-05 | Connects Metro/Intermodal → Major Port | Same as S-04 | Merged into `_natPortair` | ⚠️ Collapsed — doesn't distinguish airport vs port |
| S-06 | PBS Level 2B access | `nltn_meta.json` → `_natPbs2b` (NHVR spatial join) | Per NLTN line: true/false/null | ✅ Accurate — spatially matched, no hard-coding |
| — | No load limits | Not assessed | Assumed compliant | ❌ Data unavailable |

---

## State Roads — Remote & Regional Areas

| Criteria ID | Criterion | Data Source | Method | Status |
|---|---|---|---|---|
| S-07 | Connects Metro/Regional Cities/Major Towns to each other | `nsw_criteria.json` → `opt.centres` | Precomputed: road touches ≥2 qualifying centres | ⚠️ Opaque — precomputed offline, not in repo |
| — | Long-distance rural route (centre → town centres) | `nsw_criteria.json` → `opt.ldr` | Precomputed flag | ⚠️ Computation not transparent |
| S-08 | Connects hospitals/ports/airports to other centres | `nsw_criteria.json` → `opt.dest` | Precomputed: touches ≥1 facility AND ≥1 town | ✅ Data-driven from POI layers |
| — | Heavy vehicle bypass | Not assessed | Not tested | ❌ Data unavailable |
| — | Traffic volumes (ADT) | Not available statewide | Shown as warning; orange = would pass if ADT met | ⚠️ Correct handling — acknowledged gap |
| S-09 | PBS Level 1 access | NHVR `PBS_Level_1.gpkg` | Buffer + `intersects` against unioned network | ⚠️ **False positives** — catches roads that merely cross at junctions |
| — | No load limits | Not assessed | Assumed compliant | ❌ Data unavailable |
| — | Does not parallel State Road within 20km | Not assessed | Not tested | ❌ Fixable — buffer analysis possible |

---

## State Roads — Within Cities, Centres and Urban Areas

| Criteria ID | Criterion | Data Source | Method | Status |
|---|---|---|---|---|
| S-10 | Connects centres (urban set) | `nsw_criteria.json` (switches when `area === 'urban'`) | Same logic as S-07, relabelled | ✅ Area-aware via ABS urbanity data |
| S-11 | Connects facilities (urban set) | Same as S-08 | Same logic, relabelled | ✅ Consistent |
| S-09 | PBS Level 1 | Same as above | Same method | ⚠️ Same false-positive issue |
| — | Does not closely parallel State Road (unless similar traffic) | Not assessed | Assumed compliant | ❌ Not fixable without ADT |

---

## Regional Roads — Remote & Regional Areas

| Criteria ID | Criterion | Data Source | Method | Status |
|---|---|---|---|---|
| R-01 | Connects Urban/Town Centres to each other | `nsw_criteria.json` → `opt.centres` | Precomputed: road touches ≥2 towns (2000+) | ⚠️ Same concerns as S-07 |
| R-02 | Connects facilities to Town/Urban Centres | `nsw_criteria.json` → `opt.dest` | Precomputed: facility + town nearby | ✅ Data-driven |
| — | Emergency evacuation route | Not assessed | Not tested | ❌ Data unavailable (NSW SES) |
| R-03 | Road train network | Not assessed | Not tested | ❌ **Fixable** — NHVR road train geopackages already in data |
| R-04 | B-double 19m access | NHVR `GML_CML_19m_BDouble.gpkg` | Buffer + `intersects` against unioned network | ⚠️ **False positives** — same issue as S-09 |
| — | No load limits | Not assessed | Assumed compliant | ❌ Data unavailable |

---

## Regional Roads — Within Cities, Centres and Urban Areas

| Criteria ID | Criterion | Data Source | Method | Status |
|---|---|---|---|---|
| R-05 | Connects Metro/Major Urban/Major Towns | `nsw_criteria.json` (urban switch) | Same as R-01, relabelled | ✅ Area-aware |
| R-06 | Connects facilities to Major Urban/Major Towns | Same as R-02 | Relabelled | ✅ Consistent |
| R-04 | B-double 19m access | Same as above | Same method | ⚠️ Same false-positive issue |

---

## Cross-Cutting Issues

### Connectivity Method

| Issue | Detail |
|---|---|
| "Connects" should mean A → B | Criterion requires linking one POI to another, not just touching a single POI |
| `process_nsw.py` (old) | Uses per-segment `intersects` — if any segment touches a POI union, it passes. A road near one town but not connecting to another still passes. |
| Dashboard (`nsw_criteria.json`) | Precomputed offline — appears to be route-level and two-POI, but logic is opaque (not in this repo) |
| `criteria-engine-refactor` branch | Fixed: route-level connectivity, requires ≥2 distinct POIs touched |

### Town Classification

| Issue | Detail |
|---|---|
| `process_nsw.py` | Only 3 tiers: Regional City (20k+), Major Town (7k+), Town Centre (2k+). Missing Capital City and Metropolitan Centre (130k+) |
| Dashboard precomputed data | May have full hierarchy — evidence files show SUA-level centres |
| Criteria requirement | 5 tiers: Capital City, Metro Centre (130k+), Regional City (20k+), Major Town (7k+), Town Centre (2k+) |

### PBS / Vehicle Access Matching

| Issue | Detail |
|---|---|
| Current method | Buffer the entire NHVR network into one geometry, then `intersects` per road segment |
| Problem | Any road that crosses or runs near a PBS route at a junction gets a false positive |
| Fix (on `criteria-engine-refactor`) | Coverage-based spatial join: NHVR segments must cover ≥25% of the road's length, plus route-level propagation |

---

## Summary Table

| Status | Count | Description |
|---|---|---|
| ✅ Accurate | 10 | Data-driven, no hard-coding, correct methodology |
| ⚠️ Issues | 10 | False positives, collapsed criteria, opaque precomputation |
| ❌ Cannot fix | 5 | Data unavailable (load limits, evacuation routes, employment centres, ADT statewide) |
| ❌ Fixable | 3 | Data exists but not yet implemented (road train, 20km parallel, PBS false positives) |

---

## Fixable Issues (Prioritised)

1. **PBS 1 / B-double / PBS 2B false positives** — Use coverage-based spatial join (built on `criteria-engine-refactor` branch). High impact on accuracy.

2. **R-03 Road train network** — NHVR road train geopackages (`GML_CML_BTriple_Road_Train.gpkg`, `GML_CML_Type2_Road_Train.gpkg`) are already in `dashboard/data/pbs/`. Add spatial match.

3. **"Does not parallel State Road within 20km"** — Buffer all State Road geometries by 20km, test if any other State/Regional road is substantially within that buffer. Moderate complexity.

4. **S-02/S-03 and S-04/S-05 collapsed** — Split the precomputed `_natMetros` and `_natPortair` flags into individual criteria. Low complexity but requires regenerating `nltn_meta.json`.

---

## Data Sources Not in Repo (Required for Full Assessment)

| Data | Needed For | Source |
|---|---|---|
| Bridge/structure load limit register | All "no load limits" criteria | TfNSW + council bridge registers |
| NSW SES evacuation routes | Regional R-02 (evacuation) | NSW SES — not publicly available |
| Commercial/Industrial centres ($250m+/40ha) | S-08, S-11, R-02, R-06 | ABS + NSW Planning — very hard to source |
| ADT statewide | Traffic volume criteria (all categories) | TfNSW Traffic Volume Viewer — only select LGAs |
| NHVR PBS 2B for all roads (not just NLTN) | S-06 if testing non-NLTN roads | Available — just needs spatial matching |
