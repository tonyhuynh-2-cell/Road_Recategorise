# DECISIONS.md

> A log of significant architectural and implementation decisions made on this project, why they were made, what else was considered, and whether they're settled or still open. Written for an incoming AI agent who needs to understand *why* the code looks the way it does before changing it.
>
> Format per entry: **Decision → Why → Alternatives considered → Trade-offs → Revisit?**

---

## D-01: No frontend framework, no build step

**Decision:** Plain HTML/CSS/vanilla JS, loaded via `<script>` tags in a fixed order, no bundler, no TypeScript, no npm.

**Why:** The project started as a small internal dashboard and grew feature-by-feature. A build step would add friction for the non-frontend-specialist analysts iterating on the criteria logic, and the app's data volume (tens of JSON files, one road overlay) doesn't need code-splitting or tree-shaking to perform acceptably.

**Alternatives considered:** Not explicitly evaluated in visible project history, but the "no framework" choice has been consistently maintained across ~100+ commits and multiple contributors, so it's a durable convention rather than an oversight.

**Trade-offs:** No type safety, no module isolation (everything is `window.*` globals), load-order-dependent bugs are possible and have happened (see D-09 below), and there's no tree-shaking/minification for production. In exchange: zero build tooling to maintain, instant edit-refresh cycle, and any contributor can open a file and understand exactly what runs.

**Revisit?** Only if the codebase's global-variable coupling starts causing frequent regressions. At time of writing this is a real risk (see the `LABEL_ZOOM` incident in `STATUS.md`) but not yet bad enough to justify a rewrite. If revisited, prefer incremental modularisation (ES modules with `<script type="module">`, no build step) over a full framework migration.

---

## D-02: Static JSON pipeline instead of a live API/database

**Decision:** All criteria computation happens offline in Python, writing static JSON files that the browser fetches directly. No backend server, no database, no live queries.

**Why:** The underlying question ("does road X meet criterion Y") is deterministic given a fixed snapshot of source data (ABS census, TfNSW road network, NHVR networks). None of that source data changes in real time. A static pipeline is simpler to audit — you can diff the JSON before/after a rebuild script runs and see exactly what changed.

**Alternatives considered:** A live GIS backend (e.g. PostGIS + API) was implicitly available given the GeoPandas/Shapely tooling already in use, but was not adopted for the dashboard's runtime.

**Trade-offs:** Every source-data update requires a manual pipeline re-run, not a live refresh. But this is intentional — it forces every criteria change to go through the validation-gate pattern (see D-03) instead of silently propagating.

**Revisit?** Not recommended unless the project moves to needing live editing/collaboration (multiple analysts changing thresholds simultaneously) — at that point a backend becomes justified, but that is not the current direction.

---

## D-03: Incremental rebuild scripts with a "validation gate", not one monolithic pipeline

**Decision:** Each criterion or feature gets its own `rebuild_*.py` script that patches ONE thing into the existing `dashboard/data/*.json`, after first verifying it reproduces 100% of existing UNRELATED verdicts.

**Why:** `process_nsw.py` and `process_data.py` were the original all-in-one pipelines. As criteria interpretation evolved (see `CRITERIA_ISSUES.md`), re-running the whole thing every time risked silently changing verdicts nobody intended to touch. The validation-gate pattern makes every change reviewable in isolation: "this script changed exactly N roads' B-double result, here's the before/after breakdown."

**Alternatives considered:** A single versioned pipeline with feature flags per criterion. Rejected implicitly (never built) — the incremental-patch pattern won by default because it matched how the client raised issues (one at a time, in `CRITERIA_ISSUES.md`-style tickets).

**Trade-offs:** The pipeline is now ~20 scripts with real ordering dependencies between them (documented informally in comments, e.g. `DATA_SOURCES.md`'s note: "Cascade once those are available: `rebuild_remote_town_centres.py --apply` → `rebuild_r01_rural_centres.py --apply` → `rebuild_road_units.py --apply --raw-dir <raw>`"). There is **no single command** that runs the whole pipeline end to end — a new agent must read `DATA_SOURCES.md` and script docstrings to know the correct order. This is real technical debt (see `STATUS.md`).

**Revisit?** Worth writing a single `rebuild_all.py` orchestrator that calls the scripts in documented order, purely as a convenience — but do NOT collapse the individual scripts' validation gates into one script; keep them separately runnable and separately auditable.

---

## D-04: "Declared road" vs "road unit" two-level model

**Decision:** TfNSW's `road_number` is treated as an administrative identifier that may span multiple physically disconnected corridors. `rebuild_road_units.py` first splits geometry into connected, class-consistent **"units"** (diagnostic layer, `nsw_unit_*.json`), then re-groups units that share an official classified road number and class into one **"declared road"** (the actual scored/exported/selected identity, `nsw_declared_*.json`).

**Why:** Before this model existed, one road number with disconnected sections could show contradictory verdicts (one section green, another red) under the same road identity, which confused users and didn't match how TfNSW's Schedule treats roads (one official road = one classification). See `CRITERIA_ISSUES.md` CI-03 for the full reasoning.

**Alternatives considered:**
- Score every segment independently, no rollup at all (rejected — too noisy, doesn't match "one road, one verdict" mental model)
- Score every disconnected geometry component as its own separate road, permanently (rejected — contradicts the Schedule, which defines roads by *number*, not by *contiguous geometry*)
- Merge purely by shared road NAME (rejected — several unrelated roads share names; road number is the more reliable administrative key, with `0000057` as a documented exception because it's reused across three genuinely distinct corridors — see `CRITERIA_ISSUES.md` CI-03)

**Trade-offs:** Two parallel sets of output files (`nsw_declared_*` and `nsw_unit_*`) must both be loaded by the dashboard and kept in sync. Slightly more complex mental model for new contributors. In exchange: verdicts are stable and match the client's expectation of "one road, one answer," while the unit-level detail is still available for audit via the Sections dropdown in the Road Detail panel.

**Revisit?** Settled — this is the current correct model and should not be reverted. If a future issue arises with a specific reused/mixed-class road number, add it to the explicit exception list in `rebuild_road_units.py` rather than changing the general rule.

---

## D-05: Employment centre thresholds — land-area only, no economic value

**Decision:** Whether a commercial/industrial/employment centre counts toward S-08/S-11/R-02/R-06 is based ONLY on land area (Urban ≥40 ha, Regional ≥15 ha, Remote ≥5 ha), never on economic value, jobs, or the legacy Major/Regional/Local tier labels.

**Why:** The TfNSW guide's literal definition references both a dollar value threshold (e.g. "$250m+") AND a hectare threshold. No statewide, machine-readable, comparable economic-value dataset exists for NSW employment/industrial precincts. Rather than fabricate or approximate a $ figure, the **client explicitly approved** using land area alone as a proxy. See `CRITERIA_ISSUES.md` CI-02 — this is documented there as a "client interpretation adopted," i.e. this was a real conversation with the client, not a unilateral engineering shortcut.

**Alternatives considered:** Estimating economic value from land area × a typical $/ha figure (rejected as fabricating data); using the ELDM's or EPI's own tier labels (Major/Regional/Local) as a proxy (rejected — inconsistent coverage, and superseded once land-area rule was approved).

**Trade-offs:** This is a genuine simplification of the guide's stated rule, disclosed in the UI ("client-approved size-only rule") and in every relevant evidence row (source + threshold + decision are all stored per polygon for auditability). It is NOT deceptive — it's transparently flagged everywhere it appears — but it means a technically-compliant reading of the PDF guide and this software's actual behaviour diverge on this one point, by design.

**Revisit?** Only if a genuine statewide employment-centre economic-value dataset becomes available AND the client asks for it to be reinstated. Do not silently change this threshold basis without a client conversation — it was a deliberate, documented decision, not a default.

---

## D-06: B-double mandatory gate uses an 80%-of-length spatial coverage threshold

**Decision:** For Regional roads, the R-04 mandatory 19m B-double gate passes only if ≥80% of the road's measured length falls within 50m of the approved NHVR B-double network geometry (`rebuild_bdouble_network.py`).

**Why:** An earlier version used a much cruder `intersects()` test against a unioned buffer of the whole network, which produced **false positives** — any road that merely crossed a B-double route at a junction would register as "on the network," even if it wasn't actually approved. The 80%-of-length rule was introduced to fix that false-positive problem by requiring substantial spatial overlap, not just a touch.

**Alternatives considered:** A flat percentage was chosen over "any segment matches" (too loose, caused the original false positives) and over per-metre exact overlap with zero tolerance (too strict given real-world geometry misalignment between the TfNSW road network and the separately-surveyed NHVR network).

**Trade-offs — THIS IS CURRENTLY UNDER ACTIVE QUESTION, not settled:** Investigation during this project's later sessions found that **95% of Regional roads that fail this gate have SOME B-double coverage, often 70–80%** (see `STATUS.md` known bugs / `criteria_audit.md`-adjacent analysis done in conversation). Very few roads have genuinely zero coverage. This strongly suggests the 80% threshold, combined with geometry misalignment between the two independently-surveyed datasets, is producing systematic false negatives — i.e. real B-double-approved roads are failing the gate purely because the two datasets don't perfectly overlap, not because the road genuinely lacks access.

**Revisit?** **Yes — flagged as a high-priority open question.** See `STATUS.md` "Highest priority next tasks." A lower threshold (e.g. 50%) or a different matching method (buffer-then-any-touch with a minimum absolute length, rather than percentage-of-total) should be evaluated against real examples and pipeline dry-runs before changing the production data.

---

## D-07: State facility criterion (S-08/S-11) does not currently count employment centres

**Decision (as currently implemented, NOT as intended):** For State roads, the facility/connectivity optional criterion currently only counts hospitals, ports, international airports, and major intermodals. It does NOT count Commercial/Industrial/Employment centres, even though the criteria guide's S-08 row explicitly lists them ("Connects Major Hospital, Major Ports, Major Intermodals, Internationals Airports, Commercial, Industrial or Employment Centres to Other Centre Types").

**Why this happened:** `process_nsw.py` (the original scorer) only ever checked `connects_hospital` and `connects_destination` (ports/airports/intermodals). When `rebuild_regional_facility_optional.py` later added employment-centre support, it was written to only update `regionalOpt.dest` (used by Regional roads' R-02/R-06 and by the State→Regional cross-test), and deliberately left State roads' own `opt.dest` untouched.

**Alternatives considered:** None yet — this was diagnosed as a bug during a conversation with the user, not a deliberate design choice. It is a **confirmed defect**, not an accepted trade-off.

**Trade-offs:** Roads like Goldfields Way (`0000057`) currently fail S-08 despite having genuine, correctly-sized employment centres nearby, because those centres are only checked against the Regional threshold (`regionalOpt.dest`), not against a State-specific employment check. This under-counts State roads' true criteria performance.

**Revisit?** **Yes — this should be fixed.** The fix is to extend the State-facility rebuild (`rebuild_state_facility_optional.py` / `rebuild_state_facility_urban.py`) to also test size-qualified employment centres against the State zone thresholds (Urban 40ha / Regional 15ha / Remote 5ha — same thresholds already used for Regional, per D-05), writing the result into State roads' own `opt.dest`, not just `regionalOpt.dest`. This is listed as a top-priority task in `STATUS.md`.

---

## D-08: Criteria Overrides panel — force-pass scenario testing

**Decision:** The UI panel lets a user force-pass individual mandatory/optional criteria and see the map + sidebar stats recolour/recount in real time. Numeric threshold sliders were removed because their simplified client-side calculations did not reliably reproduce the Python pipeline.

**Why:** Analysing the impact of a threshold change (e.g. "what if B-double coverage only needed to be 50%?") previously required editing a Python script, re-running the pipeline, and reloading the dashboard — a multi-minute round trip per experiment. The client/analyst wanted fast, exploratory "what if" testing without touching the data pipeline.

**Alternatives considered:** Keeping approximate threshold sliders; running the Python pipeline with a parameter and regenerating JSON; adding a server-side recompute endpoint. Approximate sliders were removed as misleading, while a backend remains outside the static architecture in D-02.

**Trade-offs:** Force-pass toggles remain useful for broad sensitivity checks, but users can no longer explore arbitrary numeric thresholds in-browser. Threshold changes must be evaluated in the Python pipeline, where the full geometry/topology rules and validation gates apply. State/Regional cross-tests and Best Fit apply the same force-pass flags before recomputing their bins; Nationally Significant and Local do not, because the current override controls do not represent their criteria.

**Revisit?** Do not restore threshold controls unless they are backed by the same authoritative computation as the pipeline, or their limitations are explicitly accepted by the client.

---

## D-09: Fixed script load order in `index.html`, no module system

**Decision:** All `.js` files are loaded as classic (non-module) scripts in a specific order via `document.write` in `index.html`, relying on `window`-level globals being defined by the time later scripts run.

**Why:** Consistent with D-01 (no build step). `document.write` was specifically chosen (per an inline comment in `index.html`) so that edits "show up on a normal reload — no hard refresh required" — though in practice hard refresh is still often needed due to browser caching (see `ONBOARDING.md` pitfalls).

**Trade-offs — this has caused a real, previously-diagnosed production bug:** During a branch merge, a function (`updateTownLabels` in `state.js`) ended up referencing a constant (`LABEL_ZOOM`) that was never defined anywhere in the merged code. Because there's no module system and no build-time type checking, this `ReferenceError` was only caught at runtime, inside a `zoomend` event handler — and because it threw uncaught, it silently broke Leaflet's internal zoom/redraw cycle for the ENTIRE map (roads rendered as unscaled colour blobs on every zoom). This took significant debugging effort to trace back to a simple undefined-variable typo, specifically because there was no build step to catch it before runtime.

**Revisit?** Not urgent enough to justify a full module-system migration, but strongly consider: (a) adding a lightweight lint step (even just `node --check` per file, or a simple grep for suspicious patterns) as a pre-commit or pre-push habit, and (b) wrapping risky `map.on(...)` handlers in `try/catch` with a `console.error` so a future undefined-variable bug degrades gracefully instead of corrupting the whole map silently. Neither of these exists yet.

---

## D-10: Large NHVR/ABS binary source files excluded from git

**Decision:** GeoPackages and shapefiles under `dashboard/data/newdata/` (NHVR network GeoPackages, UCL shapefile — tens to ~50MB each, ~200MB total) were removed from git tracking after a push attempt failed with an HTTP 408 timeout.

**Why:** GitHub's default HTTP push has practical size/time limits; ~70-77MB of binary deltas pushed at once was timing out repeatedly.

**Alternatives considered:** Git LFS (not set up — would be the "correct" fix if this recurs); keeping them but pushing in smaller batches (not attempted, `git rm --cached` was simpler and immediately effective).

**Trade-offs:** These files still exist on disk locally but are no longer version-controlled. **Any new clone of this repository will be missing these files** and pipeline scripts that depend on them (`rebuild_from_nhvr.py`, `rebuild_bdouble_network.py`, anything reading `dashboard/data/newdata/*.gpkg`) will fail or silently use stale data until someone manually re-downloads/re-places these files. `.gitignore` should arguably be updated to formally exclude `dashboard/data/newdata/` going forward — check whether this has been done (see `KNOWN_ASSUMPTIONS.md`).

**Revisit?** If large binary source files need to be shared reliably across contributors, set up Git LFS or document a manual "fetch these from X" step in `ONBOARDING.md`. This is currently NOT documented anywhere except this decisions log and git history — a real onboarding gap.

---

## D-11: Multiple long-lived parallel git branches instead of trunk-based development

**Decision (observed, not deliberately chosen by any single person):** The repository currently has 6+ active branches on `origin` (`main`, `leon`, `ui-style-cleanup`, `orange-split-B`, `orange-split-C`, `dashboard-redesign`, `hisham`, `saud`), several of which have diverged and been merged back into each other repeatedly, sometimes with real conflicts in the same files (`panels.js`, `detail.js`, `state.js`).

**Why this happened:** Appears to be multiple people/sessions (possibly multiple analysts, possibly multiple AI-assisted sessions) working on different feature ideas concurrently without a single integration branch being kept authoritative in real time.

**Trade-offs:** Real merge conflicts have occurred and been resolved (sometimes by "take theirs," sometimes by manual reconciliation — check commit messages like "Merge origin/main into orange-split-C (resolve conflicts taking main)"). This is inherently risky: a future agent merging branches must actually read conflicting hunks rather than blindly picking one side, because "theirs" is not always the more complete/correct version (see `AGENT.md` for the explicit warning).

**Revisit?** Recommend consolidating toward `main` as the single integration point going forward, retiring stale branches once their content is merged, and avoiding starting new long-lived feature branches unless truly necessary. This is a process recommendation, not a code change — flag it to the human user rather than unilaterally deleting branches.

---

## D-12: Top-level dashboard panels are mutually exclusive

**Decision:** Opening Criteria Overrides, Criteria Reference, or Dashboard Overview closes either of the other top-level panels first.

**Why:** These controls represent alternative views of the same workspace. Leaving an overlay open behind another view created confusing active-button state and caused the old panel to reappear unexpectedly when returning to the map.

**Alternatives considered:** Allowing panels to stack, or adding a central panel manager. The current three-view interaction is small enough that each open function can defensively close the other views without adding a new abstraction.

**Trade-offs:** The open functions have small cross-file dependencies, guarded with `typeof` checks to preserve the project's load-order safety. Users cannot retain an overlay's open/split state while switching to another top-level view.

**Revisit?** If more top-level panels are added, replace the pairwise close calls with one shared `closeTopLevelPanels(except)` helper.

---

## D-13: Loaded-suburb statistics stay inside the Local tab

**Decision:** Local-road statistics are displayed only inside the Local tab. Its three verdict cards update when the user selects Test as Regional or Test as State. Under Own criteria they show not assessed because the guide provides no equivalent Local-road verdict rule.

**Why:** Suburb-loaded OpenStreetMap roads are a partial, changing scope. Adding them to statewide State/Regional or Best Fit totals made those pages appear statewide while quietly depending on which suburb happened to be loaded.

**Alternatives considered:** Appending the loaded suburb to State/Regional and Best Fit totals; ingesting every NSW local road. The first mixes incompatible scopes and the second is a separate substantial pipeline project.

**Trade-offs:** Users must visit Local to see local-road results, but statewide figures remain stable and correctly scoped. Cross-test results remain indicative because PBS/B-double gates and traffic evidence are unavailable for these council roads.

**Revisit?** Include local roads elsewhere only after a stable statewide source, road-identity model, and missing-mandatory-data policy are agreed.
