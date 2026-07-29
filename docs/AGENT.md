# AGENT.md

> Instructions for AI coding agents (Claude Code, Codex, Cursor, ChatGPT, or any future agent) working on this repository. Read this before making any change, however small.

## Coding style

**JavaScript (`dashboard/js/*.js`):**
- No framework, no build step, no modules. Every file is a classic `<script>` and relies on globals defined by earlier-loaded files. **Check `dashboard/index.html` for load order before adding a new `.js` file** — if your new code depends on something in `state.js` or `config.js`, your `<script>` tag must load after theirs.
- Match the existing mixed style: some files use `function foo() {}`, others use `const foo = function() {}` or arrow functions. Don't impose a single style across the whole codebase in one PR — match the file you're editing.
- Defensive coding is the house style: check `typeof X !== 'undefined'` and `if (!el) return;` liberally before touching globals or DOM elements that might not exist yet. This is not overcautious boilerplate here — it's load-order safety in a no-module codebase.
- Comments explain **why**, not just what. Preserve and extend this — don't strip comments during refactors, and when you make a non-obvious change, add a comment explaining the reasoning (future agents, including future you, will need it).
- Use `var`/`let`/`const` consistently with the surrounding code in a given file (older files lean `var`/plain functions, some newer additions use `let`/`const` and arrow functions — again, match locally).

**CSS (`dashboard/css/dashboard.css`):**
- One large plain CSS file, no preprocessor, no CSS modules. Uses CSS custom properties (`var(--ink)`, `var(--muted)`, `var(--bg)`, etc.) for theming, including a `body.dark-mode` variant. When adding new colours, prefer defining/reusing a custom property over hardcoding a hex value, unless the colour is verdict-specific (green/orange/red have fixed, deliberate hex values used consistently — `#16a34a` / `#f59e0b` / `#dc2626` — do not vary these without discussion, they are load-bearing UI semantics).

**Python (`dashboard/*.py`):**
- snake_case, plain dicts/lists (no dataclasses, no Pydantic)
- No `argparse` — scripts check `"--apply" in sys.argv` directly. Match this pattern in any new rebuild script rather than introducing `argparse` inconsistently.
- Every rebuild script that writes to `dashboard/data/*.json` must:
  1. Default to dry-run (report impact, write nothing) unless `--apply` is passed
  2. Back up the file it's about to modify to `<name>.pre<FeatureName>.bak` if no backup already exists
  3. Run a validation gate BEFORE writing: re-verify the existing verdict rule reproduces all currently-known-correct, UNRELATED verdicts. Abort with a clear message if it doesn't.
  4. Write JSON single-line, `ensure_ascii=False`, matching the existing files' format (check an existing `dashboard/data/*.json` file's format before writing a new one — don't pretty-print with indentation, it changes file size and diff noise significantly)

## Preferred libraries

- **JS:** Leaflet 1.9.4 (map), Chart.js 4.4.1 (charts, `overview.js` only), ExcelJS (export, `export.js` only). Do not introduce a new mapping library, charting library, or a frontend framework without an explicit request — these three are deliberately the full extent of the frontend's third-party surface.
- **Python:** GeoPandas, Shapely, Pandas, NumPy, SciPy (`cKDTree` for nearest-neighbour), `pyogrio` (fast GeoPackage reads). These are already in heavy use; prefer them over introducing a new geospatial library for a similar task.

## Formatting

- No linter/formatter config (no `.eslintrc`, no `.prettierrc`, no `black`/`ruff` config) was found in the repo. There is no automated formatting enforcement. Match the surrounding file's indentation (appears to be 4-space in most JS/Python) and don't introduce a formatter-driven mass reformat of existing files — it would blow up every diff and obscure real changes in git history.

## Documentation expectations

- When you fix a criteria interpretation question or make a judgment call about ambiguous guide wording, **add an entry to `CRITERIA_ISSUES.md`** following its existing format (Status / Where it appears / What the guide says / What is not defined / Current software treatment / Why this matters / Suggested decision needed / Related implementation). This file is the client-facing audit trail for interpretation decisions — it matters more than inline code comments for this class of change.
- When you add or change a data source, **update `DATA_SOURCES.md`** — it is treated as the single source of truth for data provenance and is actively referenced by the client/analyst. Don't let it go stale.
- When you make an architectural or non-obvious implementation decision, **add an entry to `docs/DECISIONS.md`** using its Decision/Why/Alternatives/Trade-offs/Revisit format. Future agents (and the human client) rely on this to understand *why* code looks the way it does, not just what it does.
- Update `docs/STATUS.md` when you complete, discover, or fix something significant enough to change the "what's working / known bugs / priority tasks" picture.

## Commit philosophy

- Commit messages in this repo tend to be short, imperative, and specific (e.g. "Fix LGA view persistence when switching road categories", "LGA stats reflect active road category lens"). Match this style — describe the user-visible or behavioural change, not the mechanical diff.
- Never commit large binary files (GeoPackages, shapefiles) under `dashboard/data/newdata/` or similar raw-source directories — this has already caused push failures once (see `docs/DECISIONS.md` D-10). If you generate or receive a large binary source file, flag it to the user rather than committing it, and check whether `.gitignore` needs updating.
- Only create commits when explicitly asked, or when it's clearly the natural conclusion of a task the user asked for (this follows the general safety guardrail: don't commit speculative/exploratory changes).
- Prefer staging specific files over `git add -A`/`git add .` where practical — this repo's working tree has accumulated untracked scratch files (`check_regional.py`, `criteria_audit.md` at various points, temp analysis scripts) that should not be swept into commits accidentally. That said, be aware that recent commits in this project's history DID use `git add -A` and it has caused large/unexpected file inclusions (e.g. GeoPackages) — double-check `git status` before committing.

## Refactoring philosophy

- **Do not refactor for its own sake.** This codebase is intentionally verbose and defensively coded because it has no module system and no type checking — removing "redundant" `typeof` checks or consolidating "duplicate" logic across files can silently break load-order safety.
- If you must refactor (e.g. to fix a real bug), keep the change as small and localised as possible. Prefer fixing the specific broken thing over restructuring the surrounding function.
- Before touching `grading.js`, `state.js`, `panels.js`, or `init.js`, read the relevant section of `PROJECT_CONTEXT.md` §8 (Major components) and `DOMAIN_KNOWLEDGE.md` — these four files are the most load-order-sensitive and most frequently touched, and small changes here have caused real production bugs (the `LABEL_ZOOM` incident).

## What should never be changed without discussion

- **Verdict colour hex values** (`#16a34a` green / `#f59e0b` orange / `#dc2626` red) — these are semantic across the whole UI and multiple legends; changing them is a design decision, not a bug fix.
- **The employment-centre land-area-only scoring basis** (D-05 in `DECISIONS.md`) — this was a specific client-approved decision, not a default. Reverting to an economic-value basis (even if data becomes available) requires a client conversation.
- **The "declared road" vs "road unit" two-level model** (D-04) — this is a settled architectural decision that fixed a real, previously-reported bug (contradictory verdicts under one road number). Do not collapse it back to single-level scoring.
- **The 200m/1000m/350m connectivity-snapping constants in `rebuild_road_units.py`** (`UNIT_SNAP_M`, `COMPATIBLE_GAP_M`, `MICRO_COMPONENT_KM`) — these were tuned against real examples (see the MR 329 / Baradine-Collarenebri investigation in project history) and changing them will change which roads get split into multiple assessment units statewide. Any change here needs before/after impact analysis, not a guess.
- **The B-double 80% coverage threshold** — this IS flagged as possibly wrong (see `DECISIONS.md` D-06 and `STATUS.md` known bugs), but the fix should come from evidence-based pipeline investigation, not an arbitrary change. Don't silently lower it without documenting the before/after impact and ideally confirming with the client.
- **Anything in `CRITERIA_ISSUES.md`'s "Suggested decision needed" sections** — these are open questions the client has not yet resolved. Don't unilaterally pick an interpretation and change the code to match without either (a) explicit user instruction to do so, or (b) adding your own reasoning as a new logged entry so it's visible and reversible.

## Assumptions the project relies on

- Python and its geospatial dependencies (GeoPandas, Shapely, pyogrio, etc.) are pre-installed on whoever runs the pipeline scripts — there is no `requirements.txt`. If you're asked to run a pipeline script and imports fail, that's expected in a fresh environment; help the user install what's missing rather than assuming it's a code bug.
- The large raw source GeoPackages/shapefiles under `dashboard/data/newdata/` (or wherever they're placed) exist LOCALLY on the machine running pipeline scripts, even though they are not in git. If a pipeline script fails with a file-not-found error for a `.gpkg`/`.shp`, check whether this is the cause before assuming a code bug.
- The dashboard is served as static files — there is no server-side logic, no auth, no user accounts. Do not add server-side code (an API, a database) without an explicit request; it would be a significant, unrequested architectural change.
- All verdicts are meant to be traceable to real data. If you're ever tempted to hardcode a result "to make a test pass" or "because the data seems wrong," stop and flag it — this violates the project's core integrity principle (see `DOMAIN_KNOWLEDGE.md`).

## How to verify your work before considering a task done

- **Frontend changes:** there is no automated test suite. Manually verify in-browser: start `python -m http.server 8080` from `dashboard/`, hard-refresh (Ctrl+Shift+R), and actually click through the affected UI (select the road/tab/toggle affected, confirm the map and sidebar behave correctly). Check the browser console for errors — an uncaught exception in a Leaflet event handler has previously corrupted the ENTIRE map's rendering (see D-09 in `DECISIONS.md`), so "no console errors" is a real, meaningful check here, not boilerplate.
- **Pipeline changes:** run the relevant `rebuild_*.py` script in dry-run mode first (no `--apply`), read its printed impact summary carefully (it will report counts of roads changed and before/after verdict transitions), and only re-run with `--apply` once the impact looks correct and expected. If the validation gate fails, STOP — do not bypass it — investigate why the existing verdict rule no longer reproduces known-correct results.
- If your change affects criteria interpretation in any way, cross-check your understanding against `CRITERIA_ISSUES.md` and `DATA_SOURCES.md` before implementing — someone may have already documented the correct interpretation, or flagged it as deliberately unresolved.
