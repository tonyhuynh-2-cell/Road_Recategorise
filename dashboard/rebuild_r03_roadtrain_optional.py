# -*- coding: utf-8 -*-
"""
R-03 re-scope: road-train access is a scored rural Regional optional criterion.

The detail panel already displayed R-03 from data/nhvr_networks.json, but the
prepared criteria file kept opt.hv as null for every road. That meant R-03 could
show as passing without contributing to optMet or the final verdict.

Rule applied here:
  target roads = cls == 'Regional' and area != 'urban' in nsw_criteria.json
  R-03 pass    = nhvr_networks.json[road].roadtrain is true
  opt.hv       = R-03 pass/fail

The Regional verdict rule remains the same: the road must pass the mandatory
19m B-double gate, then green requires at least two optional passes, orange is
one optional pass, and red is zero optional passes or a failed mandatory gate.

Written files:
  nsw_criteria.json - opt.hv, optMet, verdict
  nsw_recat.json    - per-segment verdicts consumed by the map
  export_rows.json  - Regional export rows, including an R-03 line

Run with --apply to write. Without --apply this reports the impact only.
"""

import json
import shutil
import sys
from collections import Counter
from pathlib import Path


APPLY = "--apply" in sys.argv
DATA = Path(__file__).resolve().parent / "data"
BAK = ".preR03.bak"


def log(*args):
    print(*args, flush=True)


def read_json(name):
    with open(DATA / name, encoding="utf-8") as f:
        return json.load(f)


def write_json(name, obj):
    p = DATA / name
    bak = p.with_name(p.name + BAK)
    if not bak.exists():
        shutil.copyfile(p, bak)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    log(f"  wrote {name} (backup: {bak.name})")


def opt_met(c):
    return sum(1 for value in c["opt"].values() if value is True)


def verdict_of(c, optional_met):
    if c["mand"].get("bdouble") is False:
        return "red"
    if optional_met >= 2:
        return "green"
    if optional_met == 1:
        return "orange"
    return "red"


def roadtrain_value(nhvr_row):
    if not nhvr_row:
        return False
    return nhvr_row.get("roadtrain") is True


crit = read_json("nsw_criteria.json")
nhvr = read_json("nhvr_networks.json")

regional = {rn: c for rn, c in crit.items() if c["cls"] == "Regional"}
bad = [
    rn for rn, c in regional.items()
    if opt_met(c) != c["optMet"] or verdict_of(c, c["optMet"]) != c["verdict"]
]
if bad:
    log(f"VALIDATION GATE FAILED - {len(bad)} Regional roads do not reproduce: {bad[:10]}")
    sys.exit(1)
log(f"validation gate: verdict rule reproduces {len(regional)}/{len(regional)} Regional roads")

changed = {}
target_count = 0
for rn, c in crit.items():
    if c["cls"] != "Regional" or c["area"] == "urban":
        continue
    target_count += 1
    new_hv = roadtrain_value(nhvr.get(rn))
    if c["opt"].get("hv") == new_hv:
        continue
    new_opt = dict(c["opt"])
    new_opt["hv"] = new_hv
    new_opt_met = sum(1 for value in new_opt.values() if value is True)
    changed[rn] = {
        "hv": new_hv,
        "optMet": new_opt_met,
        "verdict": verdict_of(c, new_opt_met),
    }

flips = Counter((crit[rn]["opt"].get("hv"), row["hv"]) for rn, row in changed.items())
transitions = Counter((crit[rn]["verdict"], row["verdict"]) for rn, row in changed.items())


def split(pred):
    old = Counter(c["verdict"] for rn, c in crit.items() if pred(rn, c))
    new = Counter(
        changed[rn]["verdict"] if rn in changed else c["verdict"]
        for rn, c in crit.items()
        if pred(rn, c)
    )
    return old, new


def fmt(counter):
    return f"{counter['green']}/{counter['orange']}/{counter['red']} (g/o/r)"


all_old, all_new = split(lambda _rn, _c: True)
reg_old, reg_new = split(lambda _rn, c: c["cls"] == "Regional")
rural_reg_old, rural_reg_new = split(lambda _rn, c: c["cls"] == "Regional" and c["area"] != "urban")

log(f"rural Regional roads checked: {target_count}")
log(f"opt.hv flips: null/false->true {flips[(None, True)] + flips[(False, True)]}, null/true->false {flips[(None, False)] + flips[(True, False)]}")
log("verdict transitions: " + (", ".join(f"{a}->{b}: {n}" for (a, b), n in sorted(transitions.items())) or "none"))
log(f"named-road split:       {fmt(all_old)} -> {fmt(all_new)}")
log(f"Regional-only split:    {fmt(reg_old)} -> {fmt(reg_new)}")
log(f"rural Regional split:   {fmt(rural_reg_old)} -> {fmt(rural_reg_new)}")

if "0000068" in changed:
    row = changed["0000068"]
    log(f"Wilcannia-Bourke: R-03={row['hv']}, optMet {crit['0000068']['optMet']}->{row['optMet']}, verdict {crit['0000068']['verdict']}->{row['verdict']}")
else:
    c = crit["0000068"]
    log(f"Wilcannia-Bourke unchanged: R-03={c['opt'].get('hv')}, optMet={c['optMet']}, verdict={c['verdict']}")

if not APPLY:
    log("dry run only - re-run with --apply to write. No files were changed.")
    sys.exit(0)

for rn, row in changed.items():
    crit[rn]["opt"]["hv"] = row["hv"]
    crit[rn]["optMet"] = row["optMet"]
    crit[rn]["verdict"] = row["verdict"]
write_json("nsw_criteria.json", crit)

recat = read_json("nsw_recat.json")
asmt = read_json("nsw_assessment.geojson")
assert len(recat) == len(asmt["features"]), "recat/assessment length mismatch"
seg_changed = 0
for index, feature in enumerate(asmt["features"]):
    rn = str(feature["properties"].get("road_number") or "").strip()
    if rn in changed and recat[index] != changed[rn]["verdict"]:
        recat[index] = changed[rn]["verdict"]
        seg_changed += 1
write_json("nsw_recat.json", recat)
log(f"  recat segments changed: {seg_changed}")

exp = read_json("export_rows.json")
cat = {"green": "Meets criteria", "orange": "Likely meets (1 optional)", "red": "Does not meet"}
summary = {"green": "Meets criteria", "orange": "Likely meets (1 optional)", "red": "Does not meet"}
rows_changed = 0
for row in exp["regional"]:
    rn = str(row.get("Road ID", "")).strip()
    if rn not in changed:
        continue
    new_row = changed[rn]

    why = []
    inserted_why = False
    for line in row["Why"].split("\n"):
        if line.startswith("R-04") and not inserted_why:
            why.append(f"R-03  {'met' if new_row['hv'] else 'not met'} (road train)")
            inserted_why = True
        if line.lstrip().startswith("→"):
            why.append(f"→ {new_row['optMet']} optional met — {summary[new_row['verdict']]}")
        else:
            why.append(line)
    if not inserted_why:
        why.insert(2, f"R-03  {'met' if new_row['hv'] else 'not met'} (road train)")

    what = []
    inserted_what = False
    for line in row["What (criteria tested)"].split("\n"):
        if line.startswith("R-04") and not inserted_what:
            what.append(f"R-03  {'PASS' if new_row['hv'] else 'fail'} — road train network")
            inserted_what = True
        what.append(line)
    if not inserted_what:
        what.insert(2, f"R-03  {'PASS' if new_row['hv'] else 'fail'} — road train network")

    row["Why"] = "\n".join(why)
    row["What (criteria tested)"] = "\n".join(what)
    row["Categorisation"] = cat[new_row["verdict"]]
    row["_v"] = new_row["verdict"]
    rows_changed += 1

assert rows_changed == len(changed), (rows_changed, len(changed))
for tab in ("natsig", "state"):
    assert not any(str(row.get("Road ID", "")).strip() in changed for row in exp[tab]), tab
write_json("export_rows.json", exp)
log(f"  export regional rows changed: {rows_changed}")

log("done.")
