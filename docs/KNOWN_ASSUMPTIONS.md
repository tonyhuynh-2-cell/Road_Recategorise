# KNOWN_ASSUMPTIONS.md

> Every assumption currently baked into this project, explicit or implicit. If you're an agent about to make a change, check whether your change relies on (or violates) one of these. Assumptions marked **[UNVERIFIED]** are inferred from code/behaviour, not confirmed by the client — treat with extra caution.

## Assumptions about datasets

1. **The TfNSW `nsw_road_network_categorisation.geojson` file (~56MB, project root) is the authoritative "current classification" ground truth.** All verdicts are computed as "does road X meet the criteria for the class it's CURRENTLY assigned in this file." If this file is stale or wrong for a specific road, the tool will faithfully report a wrong-but-consistent verdict — it has no independent way to detect that the input classification itself is outdated.

2. **The TfNSW Schedule of Classified Roads, Version 18 (March 2026) is treated as the legal correction reference** for the ~10 roads found mis-classified in the raw extract. It is assumed this Schedule itself is current and correct; the project does not have a mechanism to detect if a future Schedule version changes classifications again (`apply_schedule_fixes.py` would need to be re-run with a new Schedule).

3. **NHVR network GeoPackages are assumed reasonably current at time of pipeline run**, but are explicitly documented as "an assessment input, not a legally authorised network map" (see `DATA_SOURCES.md` §4) — the live NHVR National Network Map remains the legal reference, and this tool's copy can drift out of date if not periodically re-downloaded.

4. **ABS Census 2021 is the only census year used** for all population-based centre-tier thresholds (Regional City, Major Town, Town Centre, etc.). **[UNVERIFIED]** whether a 2026 Census update (if one becomes available before this project's usable life ends) has been considered or would require a pipeline re-run — likely yes, but not planned/scheduled anywhere in the repo.

5. **Employment centre "importance" is assumed adequately proxied by land area alone** (Urban ≥40ha / Regional ≥15ha / Remote ≥5ha) — this is a CLIENT-APPROVED assumption (see `DECISIONS.md` D-05), not an inferred one, but it IS still an assumption: it assumes land area correlates well enough with the guide's intended "$250m+ economic significance" concept for practical purposes. This has not been independently validated against any ground-truth economic dataset (none exists statewide).

6. **Traffic (AADT) data availability is assumed to be genuinely sparse (only ~41% of declared roads have usable measured data), and this sparsity is treated as a real data gap, not a bug.** The pipeline explicitly does NOT interpolate, borrow from nearby/parallel roads, or assume a default value for roads without a matched counter — see `DATA_SOURCES.md` §9 "Known gaps."

7. **Large binary source files (NHVR GeoPackages, UCL shapefile) are assumed to exist locally on whichever machine runs the pipeline scripts**, even though they are NOT tracked in git (removed after a push timeout — see `DECISIONS.md` D-10). **[UNVERIFIED]** whether this is documented anywhere for a fresh contributor beyond this docs package — likely not, prior to this handover.

## Assumptions about geometry

8. **Road segments whose endpoints fall within 200m of each other are assumed to represent one continuous physical road** (`UNIT_SNAP_M = 200.0` in `rebuild_road_units.py`). This is a tuned heuristic, not a certainty — some genuinely separate short roads could theoretically be within 200m of each other at a junction and get incorrectly merged, though this has not been reported as an observed problem.

9. **Same-name or same-route-reference geometry gaps up to 1000m are assumed bridgeable** (`COMPATIBLE_GAP_M = 1_000.0`) — i.e. if two disconnected pieces share a road name or route shield and are within 1km, they're assumed to be the same road with a data gap in between, not two genuinely different roads that happen to share a name. Exception: identifier `0000057` is explicitly hardcoded as NOT bridgeable because it's known to be reused across three genuinely distinct corridors (West Wyalong-Condobolin, Tullamore-Nyngan, Goldfields).

10. **Components under 350m (`MICRO_COMPONENT_KM = 0.35`) are assumed to be source-data fragments/artifacts, not separate roads**, when a larger component exists under the same identifier — i.e. a tiny disconnected sliver is assumed to be noise, not a real short road segment worth its own assessment.

11. **The NHVR-to-TfNSW road network spatial join uses a 50–100m tolerance** (documented as raised from 50m to 100m in git history: "R-04 B-double: raise match tolerance 50m -> 100m (fixes false red verdicts)") — this assumes that within 100m, apparent gaps between the two independently-surveyed datasets are alignment noise, not genuine lack of physical overlap. This tolerance has already been adjusted once in response to observed false negatives; it may need further adjustment (see the ongoing B-double coverage-threshold question in `DECISIONS.md` D-06).

12. **B-double/road-train mandatory-gate coverage is assumed correctly measured by "≥80% of the road's LENGTH falls within tolerance of the network," not by a simpler "any segment touches" test.** This was a deliberate fix for a previously-worse false-positive problem, but per `DECISIONS.md` D-06, there is now evidence this may have overshot into false negatives. The 80% figure itself is not derived from the criteria guide (which doesn't specify a percentage) — it's an engineering choice.

13. **Employment centre polygons must directly intersect the assessed road for State roads (S-08/S-11)**, but Regional roads (R-02/R-06) get a more lenient "within 1.5km + a network-proven access path ≤2km" allowance. **[UNVERIFIED/OPEN]** whether this State/Regional asymmetry is intentional and confirmed by the client, or simply how it was implemented first for Regional and not yet extended to State — worth confirming, especially alongside fixing the separate S-08 employment-centre-omission bug (`DECISIONS.md` D-07).

## Assumptions about road categories

14. **Local roads are assumed to have no statewide assessment need** — the project treats Local roads as out of scope for statewide criteria testing, only supporting on-demand, per-suburb, indicative cross-tests via live OpenStreetMap data. This was reaffirmed in a recent conversation (user asked about "local roads pushed up to State/Regional" and the answer was: not currently feasible without new statewide local-road geometry, which doesn't exist in this repo).

15. **A road's `admin_class` (S or R) in the source data is assumed to be the correct STARTING point for "which category's criteria do I test this road against by default."** Cross-tests and "Best fit" bins exist precisely to question this assumption interactively, but the DEFAULT view always tests a road against its own current class.

16. **Urban vs Rural (`area` field) is assumed to be a clean binary split, and every road belongs to exactly one.** In practice this comes from a metro-area classification step (likely SUA population ≥100k as the boundary, inferred from context but not confirmed in a single authoritative code comment — **[UNVERIFIED]**, worth checking `rebuild_sal_urban_centres.py` and any `rebuild_*metro*` naming for the exact rule if this ever needs to be explained precisely).

## Assumptions about user workflow

17. **Users are assumed to interact via a single desktop browser session at a time** — there is no multi-user state, no login, no concurrent-edit conflict handling. The app is a single-tenant, static, client-side tool.

18. **Users are assumed to hard-refresh the browser after a code change** during development — there is no hot-reload, and browsers can cache aggressively even though data fetches are cache-busted. This is a workflow assumption baked into how development has actually proceeded (documented repeatedly in project history: "hard refresh (Ctrl+Shift+R)").

19. **The Criteria Overrides panel's force-pass results are assumed to be used for EXPLORATORY analysis, not as final authoritative output.** The panel changes client-side verdicts for scenario testing; authoritative results still require the Python pipeline and its validation gates.

20. **The person running Python pipeline scripts is assumed to be technically capable of reading dry-run impact summaries and deciding whether to proceed with `--apply`.** There is no non-technical-user-friendly wrapper around the pipeline; it is a developer/analyst tool, not an end-user tool.

## Assumptions about deployment

21. **The dashboard is assumed to be deployable as pure static files with no server-side runtime requirement.** Any static host (or even a local file server) would work. There's no assumption of a specific hosting platform beyond "serves static files with correct MIME types" (Python's `http.server` handles this trivially in dev; production hosting has not been explicitly discussed/decided in visible project history — **[UNVERIFIED]** whether this project has ever been deployed anywhere beyond a developer's local machine).

22. **No authentication or access control exists or is assumed to be needed** — this is treated as an internal/client-facing analysis tool, not a public-facing product. If this assumption is ever wrong (e.g. if this needs to go on a public URL), that's a significant unaddressed gap — there is currently zero access control of any kind.

23. **The project assumes Python 3 with GeoPandas/Shapely/Pandas/NumPy/SciPy/pyogrio available in the environment**, with no dependency manifest to pin versions. This means reproducibility across machines/time is NOT guaranteed — a pipeline script that works today could behave differently with a future GeoPandas version. **[GAP, not yet addressed]** — flagged in `STATUS.md` as a high-priority task (write a `requirements.txt`).

24. **Git branch `main` is assumed to be the nominal "production" branch**, but at time of writing, `leon` branch is meaningfully ahead of `main` with unreleased work (Criteria Overrides, LGA stat fix, zoom bug fix). **[PROCESS GAP]** — there is no clear "this is what's actually deployed/current" signal in the repo; a new agent must check branch divergence explicitly (`git log --oneline main..leon` and vice versa) rather than assuming `main` is authoritative just because it's the default branch name.
