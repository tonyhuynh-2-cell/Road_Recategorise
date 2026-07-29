# -*- coding: utf-8 -*-
"""
Reconcile the export spreadsheet R-03 line with the per-unit road-train fill.
================================================================================
rebuild_roadtrain_declared.py filled opt.hv (R-03) on the split units that were
missing a road-train flag and recomputed their verdicts. This brings the .xlsx
rows into line WITHOUT the blocked full pipeline: for the rows whose opt.hv
actually changed (vs the .preRT.bak criteria), it rewrites ONLY the R-03 Why line
(met / not met / not assessed), the R-03 What line (PASS / fail / not assessed),
the optional-count arrow line, and _v / Categorisation. Every other line is left
untouched. Dry run by default; --apply writes (backups already made by the fill).
"""
import json
import re
import shutil
import sys
from pathlib import Path

APPLY = "--apply" in sys.argv
HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
BAK = ".preRT.bak"
CAT = {"green": "Meets criteria", "orange": "Likely meets (1 optional)", "red": "Does not meet"}
WHY = {True: "met", False: "not met", None: "not assessed"}
WHAT = {True: "PASS", False: "fail", None: "not assessed"}

R03_WHY = re.compile(r"^(\S+)\s+(?:not assessed|not met|met)(\s*\(road train network\).*)$")
R03_WHAT = re.compile(r"^(\S+)\s+(?:not assessed|PASS|fail)(\s*[-–—]\s*road train access.*)$")
ARROW = re.compile(r"^(.*?\b)(\d+)(\s+optional met\s*[-–—]\s*)(.*)$")


def log(*a):
    print(*a, flush=True)


def write_json(name, obj):
    p = DATA / name
    bak = p.with_name(p.name + BAK)
    if not bak.exists():
        shutil.copyfile(p, bak)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    log(f"  wrote {name} (backup: {bak.name})")


def hv_scope(crit_name):
    live = json.load(open(DATA / crit_name, encoding="utf-8"))
    bak_path = (DATA / crit_name).with_name(crit_name + BAK)
    if not bak_path.exists():
        return set()
    bak = json.load(open(bak_path, encoding="utf-8"))
    return {k for k, c in live.items()
            if (c.get("opt") or {}).get("hv") != (bak.get(k, {}).get("opt") or {}).get("hv")}


def patch_row(row, crit):
    new_v = crit["verdict"]
    hv = (crit.get("opt") or {}).get("hv")
    met = crit.get("optMet", sum(1 for x in (crit.get("opt") or {}).values() if x is True))
    changed = False
    if row.get("_v") != new_v:
        row["_v"] = new_v; changed = True
    if row.get("Categorisation") in CAT.values() and row.get("Categorisation") != CAT[new_v]:
        row["Categorisation"] = CAT[new_v]; changed = True

    def fix(col, why):
        nonlocal changed
        text = row.get(col)
        if not isinstance(text, str):
            return
        out = []
        for line in text.split("\n"):
            if why:
                m = R03_WHY.match(line)
                if m:
                    line = f"{m.group(1)}  {WHY[hv]}{m.group(2)}"
                else:
                    a = ARROW.match(line)
                    if a:
                        line = f"{a.group(1)}{met}{a.group(3)}{CAT[new_v]}"
            else:
                m = R03_WHAT.match(line)
                if m:
                    line = f"{m.group(1)}  {WHAT[hv]}{m.group(2)}"
            out.append(line)
        joined = "\n".join(out)
        if joined != text:
            row[col] = joined; changed = True

    fix("Why", True)
    fix("What (criteria tested)", False)
    return changed


def run(export_name, crit, scope):
    ex = json.load(open(DATA / export_name, encoding="utf-8"))
    touched = 0
    for tab in ("state", "regional"):
        for row in ex.get(tab, []):
            key = str(row.get("_key") or row.get("Road ID") or "").strip()
            if key in scope and key in crit and patch_row(row, crit[key]):
                touched += 1
    log(f"{export_name}: {touched} rows patched")
    if APPLY:
        write_json(export_name, ex)


declared_crit = json.load(open(DATA / "nsw_declared_criteria.json", encoding="utf-8"))
dscope = hv_scope("nsw_declared_criteria.json")
log(f"declared roads with changed opt.hv: {len(dscope)}")
run("export_declared_rows.json", declared_crit, dscope)

if (DATA / "export_unit_rows.json").exists():
    unit_crit = json.load(open(DATA / "nsw_unit_criteria.json", encoding="utf-8"))
    uscope = hv_scope("nsw_unit_criteria.json")
    log(f"unit roads with changed opt.hv: {len(uscope)}")
    run("export_unit_rows.json", unit_crit, uscope)

if not APPLY:
    log("\ndry run only — re-run with --apply to write.")
