# -*- coding: utf-8 -*-
"""
Reconcile the export spreadsheet rows with the re-scored connects-centres verdicts.
================================================================================
rebuild_centres_declared.py re-scored S-10/R-05 in the declared runtime files but
left export_declared_rows.json (the .xlsx download source, export.js) untouched,
because its rows carry precomputed prose. This patch brings each row's centres-
derived fields back in line with nsw_declared_criteria.json WITHOUT the blocked
full pipeline, editing ONLY the connectivity fields and leaving every other line
(dest, traffic, LDR, mandatory, road-train) exactly as it was:

  - the centres "Why" line       "<code>  met|not met (centres)"
  - the optional-count arrow line "-> N optional met - <Categorisation>"
  - the centres "What" line       "<code>  PASS|fail - connects qualifying centres"
  - the row verdict fields        _v  and  Categorisation

The centre-criterion code (S-07 / R-01 / R-05, zone-dependent) is preserved from
each row; only met/not-met, PASS/fail, the count and the label are rewritten from
the road's current opt.centres / optMet / verdict. Rows already consistent are
left byte-for-byte. Dry run by default; --apply writes (.preCentres.bak backups).
"""
import json
import re
import shutil
import sys
from pathlib import Path

APPLY = "--apply" in sys.argv
DEBUG = "--debug" in sys.argv
HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
BAK = ".preCentres.bak"
CAT = {"green": "Meets criteria", "orange": "Likely meets (1 optional)", "red": "Does not meet"}


def log(*a):
    print(*a, flush=True)


def orig_path(name):
    p = DATA / name
    bak = p.with_name(p.name + BAK)
    return bak if bak.exists() else p


def write_json(name, obj):
    p = DATA / name
    bak = p.with_name(p.name + BAK)
    if not bak.exists():
        shutil.copyfile(p, bak)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    log(f"  wrote {name} (backup: {bak.name})")


CENTRES_WHY = re.compile(r"^(\S+)\s+(not met|met)(\s*\(centres\).*)$")
CENTRES_WHAT = re.compile(r"^(\S+)\s+(PASS|fail)(\s*[-–—]\s*connects qualifying centres.*)$")
ARROW = re.compile(r"^(.*?\b)(\d+)(\s+optional met\s*[-–—]\s*)(.*)$")


def patch_row(row, crit):
    """Return True if any field changed; edits row in place from crit (the road's criteria)."""
    new_v = crit["verdict"]
    new_cent = (crit.get("opt") or {}).get("centres")
    new_met = crit.get("optMet")
    if new_met is None:
        new_met = sum(1 for x in (crit.get("opt") or {}).values() if x is True)
    changed = False

    if row.get("_v") != new_v:
        row["_v"] = new_v
        changed = True
    if row.get("Categorisation") in CAT.values() and row.get("Categorisation") != CAT[new_v]:
        row["Categorisation"] = CAT[new_v]
        changed = True

    def fix_block(col, kind):
        nonlocal changed
        text = row.get(col)
        if not isinstance(text, str):
            return
        out = []
        for line in text.split("\n"):
            m = None
            if kind == "why":
                m = CENTRES_WHY.match(line)
                if m:
                    line = f"{m.group(1)}  {'met' if new_cent else 'not met'}{m.group(3)}"
                else:
                    a = ARROW.match(line)
                    if a:
                        line = f"{a.group(1)}{new_met}{a.group(3)}{CAT[new_v]}"
            else:  # what
                m = CENTRES_WHAT.match(line)
                if m:
                    line = f"{m.group(1)}  {'PASS' if new_cent else 'fail'}{m.group(3)}"
            out.append(line)
        joined = "\n".join(out)
        if joined != text:
            row[col] = joined
            changed = True

    fix_block("Why", "why")
    fix_block("What (criteria tested)", "what")
    return changed


def run(export_name, crit, scope):
    ex = json.load(open(orig_path(export_name), encoding="utf-8"))
    touched = 0
    samples = []
    for tab in ("state", "regional"):
        for row in ex.get(tab, []):
            key = str(row.get("_key") or row.get("Road ID") or "").strip()
            c = crit.get(key)
            if not c or key not in scope:   # only rows whose connects-centres actually flipped
                continue
            before = json.dumps({k: row.get(k) for k in ("_v", "Why", "What (criteria tested)", "Categorisation")}, ensure_ascii=False)
            if patch_row(row, c):
                touched += 1
                if len(samples) < 3:
                    after = {k: row.get(k) for k in ("_v", "Categorisation")}
                    samples.append((key, before[:200], after))
    log(f"{export_name}: {touched} rows patched")
    if DEBUG:
        for key, b, a in samples:
            log(f"  --- {key}\n    BEFORE {b}\n    AFTER  {a}")
    if APPLY:
        write_json(export_name, ex)
    return touched


def flipped_scope(crit_name):
    """Keys whose opt.centres differs from the pre-fix backup — exactly the rows this fix touches."""
    live = json.load(open(DATA / crit_name, encoding="utf-8"))
    bak_path = (DATA / crit_name).with_name(crit_name + BAK)
    if not bak_path.exists():
        return set(live)   # no backup: fall back to reconciling everything
    bak = json.load(open(bak_path, encoding="utf-8"))
    return {k for k, c in live.items()
            if (c.get("opt") or {}).get("centres") != (bak.get(k, {}).get("opt") or {}).get("centres")
            or c.get("verdict") != bak.get(k, {}).get("verdict")}


declared_crit = json.load(open(DATA / "nsw_declared_criteria.json", encoding="utf-8"))
declared_scope = flipped_scope("nsw_declared_criteria.json")
log(f"declared connects-centres flips in scope: {len(declared_scope)}")
run("export_declared_rows.json", declared_crit, declared_scope)

# export_unit_rows.json is not UI-loaded, but patch it for dataset coherence if present + same shape.
unit_path = DATA / "export_unit_rows.json"
if unit_path.exists():
    unit_crit = json.load(open(DATA / "nsw_unit_criteria.json", encoding="utf-8"))
    unit_scope = flipped_scope("nsw_unit_criteria.json")
    log(f"unit connects-centres flips in scope: {len(unit_scope)}")
    run("export_unit_rows.json", unit_crit, unit_scope)

if not APPLY:
    log("\ndry run only — re-run with --apply to write. No files changed.")
