# ONBOARDING.md

> Written as if onboarding a new senior software engineer (or AI agent standing in for one) who has never seen this codebase. Follow this in order.

## 1. Read the docs, in this order

1. `docs/PROJECT_CONTEXT.md` — what this is, why it exists, architecture overview
2. `docs/DOMAIN_KNOWLEDGE.md` — the road-classification domain, criteria codes, glossary
3. `docs/STATUS.md` — what's currently working, what's broken, what's next
4. `docs/DECISIONS.md` — why the code looks the way it does (read before changing anything non-trivial)
5. `docs/KNOWN_ASSUMPTIONS.md` — what the project silently relies on
6. `docs/AGENT.md` — coding conventions and hard rules
7. Then, at the repo root: `DATA_SOURCES.md` (data provenance — very detailed, worth a full read before touching any pipeline script), `CRITERIA_ISSUES.md` (open interpretation questions), `FEATURES_CODE_WALKTHROUGH.md` (feature-by-feature code tour with snippets)

## 2. Set up the project

**Frontend (no build needed):**
```
cd dashboard
python -m http.server 8080
```
Open `http://localhost:8080` in a browser. That's the entire frontend setup. There is no `npm install`, no build step.

**Python pipeline (no manifest exists yet — you'll need to infer/install):**
The pipeline scripts import: `geopandas`, `pandas`, `numpy`, `shapely`, `scipy`, `pyogrio`. There is no `requirements.txt`. If you're setting up a fresh environment:
```
pip install geopandas pandas numpy shapely scipy pyogrio
```
(GeoPandas has non-trivial system dependencies — GDAL, GEOS, PROJ — on some platforms `conda`/`mamba` install is more reliable than plain `pip`. If `pip install geopandas` fails with a build error, try a conda environment instead.)

**Large raw source files:** Some pipeline scripts (`rebuild_from_nhvr.py`, `rebuild_bdouble_network.py`, anything referencing `dashboard/data/newdata/*.gpkg`) depend on large binary files that are **not tracked in git** (see `docs/DECISIONS.md` D-10). If you need to run these scripts, ask the human where these files live locally, or check `dashboard/data/newdata/` — they may already be present on disk even though git doesn't track them.

## 3. Where to start reading the code

**If you're investigating a criteria/verdict question**, start at:
1. `dashboard/js/detail.js` — `showRoadDetail()` — this is what actually renders a road's criteria breakdown; tracing backward from here shows you exactly which fields from which JSON files feed into a displayed verdict
2. `dashboard/js/grading.js` — `nswStyle()`, `nswInView()`, `buildXtest()`, `buildFresh()`, `computeOverriddenVerdict()` — this is where verdict logic and colour mapping live client-side
3. `dashboard/data/nsw_declared_criteria.json` — this is the canonical runtime layer. Open it in a text editor/JSON viewer, pick a road you recognise, and read its `opt`/`mand`/`verdict` fields to ground yourself in the actual data shape. Do not use legacy `nsw_criteria.json` for current totals.
4. The relevant `dashboard/rebuild_*.py` script that PRODUCES the field you're investigating (grep for the field name, e.g. `opt.dest`, across the Python scripts to find which one writes it)

**If you're investigating a map/UI bug**, start at:
1. `dashboard/js/state.js` — the Leaflet map instance, panes, renderers, selection state
2. `dashboard/js/panels.js` — tab switching, `switchTab()`, LGA dropdown logic, sidebar stat refresh
3. `dashboard/js/init.js` — how data is loaded and how the road-layer groups are built

**If you're investigating the data pipeline**, start at:
1. `dashboard/rebuild_road_units.py` — the newest, most complete engine (declared roads, connectivity, zone derivation)
2. `DATA_SOURCES.md` — for the full provenance and known ordering dependencies between rebuild scripts
3. Older `process_nsw.py`/`process_data.py` only if you need to understand a legacy field that hasn't yet been migrated to the new pipeline (check `DECISIONS.md` D-07 for one concrete example of legacy behaviour still in effect)

## 4. How the application actually works, end to end

1. A developer runs one or more `dashboard/rebuild_*.py` scripts (dry-run first, then `--apply`), which read raw source data and write/update JSON files in `dashboard/data/`.
2. A user opens `dashboard/index.html` in a browser (served statically).
3. `init.js` fetches ~30 JSON/GeoJSON files in parallel, builds in-memory aggregates (`window.NSW_AGG`, `window.NSW_CRIT`, `window.NSW_EVID`, etc.), and builds the Leaflet road-overlay layer.
4. The user interacts (clicks a road, switches a tab, toggles a Criteria Override). Every interaction mutates a small set of shared globals and then forces Leaflet to re-render (`nswLayer.setStyle(nswStyle)`).
5. Nothing is sent to a server. Export happens entirely in-browser (ExcelJS generates and downloads an `.xlsx` file).

## 5. How to debug it

**"The map looks wrong / roads are the wrong colour":**
- Open browser DevTools console FIRST. An uncaught JS error inside a Leaflet event handler has previously corrupted the entire map's rendering silently (see `docs/DECISIONS.md` D-09) — always rule this out before assuming it's a data/logic bug.
- Click the affected road and check the Road Detail panel's criteria breakdown — it shows the actual `opt`/`mand` values driving the verdict.
- Cross-check against `dashboard/data/nsw_declared_criteria.json` for that road's key, to rule out a display bug vs a data bug.

**"The map didn't update after I changed a JS file":**
- Hard refresh (Ctrl+Shift+R / Cmd+Shift+R). Browsers cache aggressively, and even though `init.js` cache-busts its own data fetches, the `.js`/`.css` files themselves are not cache-busted.

**"A criteria rebuild script's dry-run output looks wrong / the validation gate failed":**
- Do NOT bypass the validation gate. It failing means the script's assumed verdict rule no longer matches the actual current data — investigate why (did another script change the same field first? did the input data change shape?) before proceeding.
- Read the script's printed impact summary carefully — it typically reports a before/after breakdown by verdict transition (e.g. "green->orange: 12 roads") which usually makes the actual behaviour obvious.

**"Zoom is laggy" or "the map is frozen/distorted after zooming":**
- Check whether this is the previously-diagnosed permanent-tooltip performance issue (search `state.js`/`init.js` for `permanent: true` on marker tooltips — there should be very few, and none on high-count layers like locality pins) or the previously-diagnosed undefined-variable-in-zoomend-handler issue (check browser console for `ReferenceError` during a zoom event). Both have happened before on this exact project — see `docs/STATUS.md` known bugs and `docs/DECISIONS.md` D-09.

**"Which git branch has the feature I'm looking for?":**
- Don't assume `main` is current. Run `git log --oneline main..leon` and `git log --oneline leon..main` (or substitute whichever branches are relevant) to see actual divergence before assuming any branch is "the" source of truth. See `docs/KNOWN_ASSUMPTIONS.md` #24.

## 6. Common pitfalls

- **Editing a `.js` file and not seeing changes** — hard refresh, not just refresh.
- **Assuming `main` is up to date** — check branch divergence explicitly; this project has multiple long-lived branches (see `docs/AGENT.md` git workflow notes).
- **Committing large binary files** — never commit anything under `dashboard/data/newdata/` or similar raw-source paths; this has already caused a push failure once (see `docs/DECISIONS.md` D-10).
- **Assuming a criterion is "wrong" because it seems strict** — check `CRITERIA_ISSUES.md` and `docs/DECISIONS.md` first; several apparently-strict rules (like the B-double 80% threshold) are deliberate engineering choices, though some ARE flagged as possibly needing revision (see `docs/STATUS.md`).
- **Refactoring "duplicate-looking" code across JS files** — the defensive `typeof X !== 'undefined'` checks scattered everywhere are load-order safety, not accidental duplication. Removing them can break things that only manifest when scripts load in a different order (e.g. during specific tab-switch sequences).
- **Running a `rebuild_*.py` script with `--apply` without reading the dry-run output first** — always dry-run first, read the impact summary, then apply.
- **Using force-pass Criteria Overrides as authoritative output** — they are scenario checks, not a substitute for a real pipeline rebuild and validation (see `docs/DECISIONS.md` D-08).

## 7. Recommended development workflow for a new task

1. Read the relevant sections of `CRITERIA_ISSUES.md` and `DATA_SOURCES.md` if the task touches criteria logic or data provenance at all.
2. If it's a frontend-only UI/UX change: edit the relevant `.js`/`.css`/`.html` file directly, hard-refresh, verify manually in-browser. Check the console for errors.
3. If it's a data pipeline change: identify or write the smallest possible `rebuild_*.py` script that patches the specific thing, following the existing pattern (dry-run default, backup-before-write, validation gate, `--apply` to commit). Do not modify `process_nsw.py`/`process_data.py` directly for new features — they're legacy; extend via a new incremental rebuild script instead, consistent with how every other feature in this project's history has been added.
4. Update `docs/STATUS.md`, `docs/DECISIONS.md`, and/or `CRITERIA_ISSUES.md` as appropriate for the significance of the change (see `docs/AGENT.md` documentation expectations).
5. Commit with a short, specific, imperative message. Don't commit large binaries. Don't use `git add -A`/`git add .` without checking `git status` first.
6. If merging branches, read conflicts carefully — don't default to "take theirs" without understanding which version is actually more correct/complete (see `docs/AGENT.md` and `docs/DECISIONS.md` D-11).
