# STATUS.md

> Current state of development as of 27 July 2026, on the `leon` branch (which is ahead of / diverged from `main` — see `AGENT.md` for branch situation). This file should be updated whenever a significant chunk of work lands; if you're an agent reading this and it looks stale, cross-check against `git log --oneline -20` before trusting it fully.

## What is working

**Map & navigation**
- Statewide State/Regional road overlay, colour-coded by verdict (green/orange/red), on a shared canvas renderer
- Category dropdown (Overview / Nat. Sig. / State / Regional / Local) + Area dropdown (All NSW / Sydney / Clarence Valley), side by side, correctly interacting: switching category while an area is focused no longer zooms out and back in, and **sidebar stat cards correctly filter by the active category when an area is focused**.
- "Best fit" / Fresh assessment lens (blank-slate re-bin ignoring current classification)
- Nationally Significant (NLTN) lens, its own layer/styling
- Flagged roads tab (up to 10, `localStorage`-backed)
- Local tab: on-demand suburb search → OpenStreetMap/Overpass road loading, clipped to suburb boundary, indicative State/Regional cross-tests
- Local-tab verdict cards show Passes criteria / Passes 1 of 2 criteria / Fails criteria for the loaded suburb and update with the State/Regional cross-criteria buttons; Own criteria remains explicitly not assessed
- Statewide LocalRoad assessment now uses aligned zone/centre thresholds, near-straight corridor continuity, road-train/two-State-road/long-distance evidence, and a distinct insufficient-evidence result. Current available-evidence outcomes include 13 Regional-test green roads and one State-test green road.

**Road Detail panel**
- Full criteria breakdown per road: mandatory gates, optional criteria with pass/fail/not-assessed, evidence (named centres/hospitals/ports/airports/employment centres) with click-to-locate
- Cross-category test dropdown (test this road against a different category's criteria) — now correctly hides the duplicate "own category" entry from the list
- Sections dropdown for roads split into multiple connected assessment units — now display-only (no click interaction), per explicit user request
- Deselecting a road (click empty map) now correctly returns to the previous sidebar tab's stats instead of showing an empty placeholder
- Flag button correctly aligned inline with "ROAD INFORMATION" heading, no longer overlapping long road names

**Criteria Overrides panel**
- Toggle button (left of Dashboard Overview button) opens a translucent (60% opacity) overlay panel so the map stays visible underneath
- Checkboxes to force-pass individual mandatory/optional criteria
- Map recolours and sidebar cards recount immediately when overrides change
- Threshold sliders and their approximate client-side recomputation were removed because they did not reproduce the pipeline reliably
- Reset button restores original (real) verdicts from a saved snapshot
- Active-button highlighting: Criteria Overrides / Dashboard Overview / Criteria Reference buttons now stay visually highlighted while their respective panel is open (consistent pattern across all three)
- Criteria Overrides, Criteria Reference, and Dashboard Overview are mutually exclusive: opening one closes any other open top-level panel
- Criteria Overrides now refresh State/Regional category caches and flow through cross-category tests and Best Fit; Nationally Significant and Local remain outside the current override set

**Other**
- Search by road name/ID/route ref
- Excel export (whole network, by category, by area, flagged, custom selection, loaded local roads)
- Criteria Reference modal — renders the TfNSW guide as in-app HTML, auto-highlights the section relevant to the currently open road
- Dashboard Overview full-page stats view with mini map + charts
- Locality-centre (SAL suburb) pins, zoom-gated reveal by population band, now performant (previously caused severe zoom lag — fixed by switching from permanent to hover-only tooltips)
- A serious canvas zoom-rendering bug (roads becoming giant unscaled blobs on zoom) was found and fixed — root cause was an undefined variable (`LABEL_ZOOM`) thrown inside a `zoomend` handler after a branch merge, silently corrupting Leaflet's redraw cycle

## What is unfinished

- **S-08/S-11 State facility criterion does not count employment centres** — see Known Bugs below, this is the single most impactful outstanding item
- **B-double 80% coverage threshold under active question** — strong evidence it produces false negatives due to geometry misalignment between TfNSW and NHVR datasets, not genuine lack of access (see `DECISIONS.md` D-06)
- **Traffic (AADT) criterion only has real data for 376/921 declared roads** — the remaining ~59% show "not assessed," which is correct behaviour but means the traffic criterion can rarely tip a verdict either way in practice
- **No statewide local road dataset** — "which local roads would qualify for Regional/State" analysis was discussed with the user as a feature idea but is NOT implemented and NOT currently planned in the codebase; would require sourcing/loading statewide local road geometry, which doesn't exist in this repo
- **No single orchestrator script for the full data pipeline** — the correct order to run all `rebuild_*.py` scripts is only documented informally across `DATA_SOURCES.md` and individual script docstrings (see `DECISIONS.md` D-03)

## Known bugs

1. **[HIGH IMPACT, CONFIRMED] S-08/S-11 (State facility criterion) ignores Commercial/Industrial/Employment centres.** The guide explicitly lists these as qualifying facilities for State roads, but the current code (`process_nsw.py` legacy scorer, still the source of State roads' `opt.dest`) only checks hospitals/ports/airports/intermodals. Regional roads' equivalent (R-02/R-06) DOES correctly include employment centres via `rebuild_regional_facility_optional.py`, but that script was written to only update `regionalOpt.dest`, deliberately not touching State roads' own `opt.dest`. Real-world impact: roads like Goldfields Way (`0000057`) fail S-08 despite having correctly-sized, connected employment centres nearby. **Fix:** extend `rebuild_state_facility_optional.py`/`rebuild_state_facility_urban.py` to test employment centres against State zone thresholds and write into State roads' `opt.dest`. See `DECISIONS.md` D-07.

2. **[MEDIUM IMPACT, UNDER INVESTIGATION] B-double coverage threshold likely too strict.** Diagnostic query found: of Regional roads failing the R-04 mandatory gate, 95% fail due to the coverage percentage rule (not a total absence of NHVR data), and of THOSE, a large share sit at 70–80% coverage — literal near-misses, several roads within 1–2 percentage points of the 80% cutoff. This strongly suggests systematic geometry misalignment between the TfNSW road network and the separately-surveyed NHVR network, rather than a genuine lack of B-double access. **Not yet fixed** — flagged as the top investigation priority. Investigate with pipeline dry-runs and real-road comparisons before changing production data.

3. **[LOW IMPACT, COSMETIC — RESOLVED but watch for regression] Locality pin zoom performance.** Fixed by removing `permanent: true` on ~1,265 marker tooltips. If this regresses (someone re-adds `permanent: true`, or a future rebuild dramatically increases the point count), zoom lag will return. The zoom-level reveal classes (`centres-z8`/`z10`/`z11`/`z12`/`z13` on the map container) must also stay wired up in `updateTownLabels()` in `state.js` — this was accidentally dropped during a merge and had to be restored (this is WHY few localities appeared even with the toggle on, immediately after the zoom-bug fix — the class-toggling logic had been lost in the same merge that caused the `LABEL_ZOOM` bug).

4. **[LOW IMPACT] `.gitignore` may not yet formally exclude `dashboard/data/newdata/`.** Large binaries were removed from git tracking via `git rm --cached`, but it's not confirmed whether `.gitignore` was updated to prevent them from being re-added accidentally in a future commit. Verify before committing anything new under that path.

5. **[UNVERIFIED, LOW PRIORITY] No Python dependency manifest.** There is no `requirements.txt` or `pyproject.toml` visible in the repo. Anyone setting up a fresh environment must infer dependencies (GeoPandas, Shapely, Pandas, NumPy, SciPy, pyogrio) from `import` statements. Not a functional bug, but a real onboarding friction point — see `ONBOARDING.md`.

## Technical debt

- Global-variable-coupled JS with no module system — real risk of silent breakage on merge (see `DECISIONS.md` D-01, D-09)
- ~20 independent Python rebuild scripts with implicit ordering dependencies and no orchestrator
- No frontend automated tests at all; only a handful of pytest-style tests cover specific Python rebuild scripts
- 6+ long-lived diverged git branches on origin, some containing conflicting versions of the same features (see `AGENT.md`)
- Two parallel data layers (`nsw_declared_*` and `nsw_unit_*`) must be kept in sync by every future rebuild script — easy to update one and forget the other
- Backup files (`*.preXyzFix.bak`, `*.preR05.bak`, etc.) accumulate in `dashboard/data/` and are never cleaned up — not harmful, but clutter

## Highest priority next tasks

1. **Fix S-08/S-11 to include Commercial/Industrial/Employment centres for State roads** (see Known Bug #1 / `DECISIONS.md` D-07). This is a confirmed, scoped, well-understood defect with a clear fix path.
2. **Resolve the B-double coverage threshold question** (Known Bug #2 / `DECISIONS.md` D-06) — either by lowering the threshold, changing the matching method, or confirming with the client that the current strictness is intentional. Use pipeline dry-runs and real-road comparisons to gather evidence first.
3. **Write a Python dependency manifest** (`requirements.txt` at minimum) so a fresh environment can actually be set up without guessing.
4. **Confirm/update `.gitignore`** to exclude `dashboard/data/newdata/` and any other large-binary source directories going forward.

## Medium priority tasks

1. Write a single orchestrator script (or at minimum, a clearly ordered README/checklist) for running the full `rebuild_*.py` pipeline from raw sources, so a new analyst doesn't have to reverse-engineer the correct order from scattered docstrings.
2. Consolidate git branches — retire stale branches once merged, converge on `main` as the single integration point.
3. Consider wrapping `map.on(...)` handlers in `try/catch` with `console.error` logging, so a future undefined-variable bug degrades gracefully instead of silently corrupting canvas rendering for the whole map (see D-09 in `DECISIONS.md`).

## Low priority improvements

1. Clean up accumulated `.bak` files in `dashboard/data/` once confident they're no longer needed for rollback.
2. Consider a lightweight lint/syntax-check step (even just `node --check` per file) as a pre-commit habit to catch undefined-variable bugs before they reach runtime.
3. Investigate whether Git LFS should be adopted for large binary source files instead of excluding them from version control entirely (trade-off: LFS adds tooling complexity but keeps provenance; current approach is simpler but means files must be manually re-sourced on a fresh clone).
