# -*- coding: utf-8 -*-
"""
R-01 re-scope: rural Regional centres connectivity must connect centres.

R-01 is displayed as "Connects Urban Centres and Town Centres to each other".
That wording needs at least two distinct qualifying centres. The legacy data can
credit R-01 when a road only has one named centre in nsw_evidence.json, which is
why roads such as Condobolin-Cobar showed R-01 as passed with only Condobolin
listed.

Rule applied here:
  target roads = cls == 'Regional' and area != 'urban' in nsw_criteria.json
  qualifying centres = evidence centres[] with type in:
      Significant Urban Area, Regional City, Major Town, Town Centre
  new opt.centres = distinct qualifying names >= 2

Unlike the earlier R-05 urban script, empty evidence is not kept as a pass here:
if the app cannot name at least two connected centres, R-01 is not evidenced.

Written files:
  nsw_criteria.json - opt.centres, optMet, verdict
  nsw_recat.json    - per-segment verdicts consumed by the map
  export_rows.json  - Regional export rows and criteria explanation text

Run with --apply to write. Without --apply this reports the impact only.
"""

import json
import shutil
import sys
from collections import Counter
from pathlib import Path


APPLY = "--apply" in sys.argv
DATA = Path(__file__).resolve().parent / "data"
QUALIFYING = {"Significant Urban Area", "Regional City", "Major Town", "Town Centre"}
BAK = ".preR01.bak"


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


def verdict_of(c, opt_met):
    if c["mand"].get("bdouble") is False:
        return "red"
    if opt_met >= 2:
        return "green"
    if opt_met == 1:
        return "orange"
    return "red"


def centre_names(evidence_row):
    centres = (evidence_row or {}).get("centres") or []
    return {
        str(e.get("name", "")).strip()
        for e in centres
        if e.get("type") in QUALIFYING and str(e.get("name", "")).strip()
    }


crit = read_json("nsw_criteria.json")
evid = read_json("nsw_evidence.json")

regional = {rn: c for rn, c in crit.items() if c["cls"] == "Regional"}
bad = [
    rn for rn, c in regional.items()
    if sum(1 for v in c["opt"].values() if v is True) != c["optMet"]
    or verdict_of(c, c["optMet"]) != c["verdict"]
]
if bad:
    log(f"VALIDATION GATE FAILED - {len(bad)} Regional roads do not reproduce: {bad[:10]}")
    sys.exit(1)
log(f"validation gate: verdict rule reproduces {len(regional)}/{len(regional)} Regional roads")

changed = {}
target_count = 0
target_with_under_two = 0
for rn, c in crit.items():
    if c["cls"] != "Regional" or c["area"] == "urban":
        continue
    target_count += 1
    names = centre_names(evid.get(rn))
    new_centres = len(names) >= 2
    if len(names) < 2:
        target_with_under_two += 1
    if new_centres == c["opt"]["centres"]:
        continue
    new_opt_met = sum(
        1 for key, value in c["opt"].items()
        if (new_centres if key == "centres" else value) is True
    )
    changed[rn] = {
        "centres": new_centres,
        "optMet": new_opt_met,
        "verdict": verdict_of(c, new_opt_met),
        "centreCount": len(names),
        "centreNames": sorted(names),
    }

flips = Counter((crit[rn]["opt"]["centres"], row["centres"]) for rn, row in changed.items())
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
log(f"rural Regional roads with fewer than 2 named qualifying centres: {target_with_under_two}")
log(f"opt.centres flips: true->false {flips[(True, False)]}, false->true {flips[(False, True)]}")
log("verdict transitions: " + (", ".join(f"{a}->{b}: {n}" for (a, b), n in sorted(transitions.items())) or "none"))
log(f"named-road split:       {fmt(all_old)} -> {fmt(all_new)}")
log(f"Regional-only split:    {fmt(reg_old)} -> {fmt(reg_new)}")
log(f"rural Regional split:   {fmt(rural_reg_old)} -> {fmt(rural_reg_new)}")

if "0000461" in changed:
    row = changed["0000461"]
    log(f"Condobolin-Cobar: centres={row['centreCount']} {row['centreNames']}, verdict {crit['0000461']['verdict']}->{row['verdict']}")
else:
    names = centre_names(evid.get("0000461"))
    log(f"Condobolin-Cobar unchanged: centres={len(names)} {sorted(names)}")

if not APPLY:
    log("dry run only - re-run with --apply to write. No files were changed.")
    sys.exit(0)

for rn, row in changed.items():
    crit[rn]["opt"]["centres"] = row["centres"]
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
cat = {"green": "Meets criteria", "orange": "Likely meets (1 of 2 optional)", "red": "Does not meet"}
summary = {"green": "Meets criteria", "orange": "Likely meets (1 of 2)", "red": "Does not meet"}
rows_changed = 0
for row in exp["regional"]:
    rn = str(row.get("Road ID", "")).strip()
    if rn not in changed:
        continue
    new_row = changed[rn]
    why = []
    for line in row["Why"].split("\n"):
        if line.startswith("R-01") and "(centres)" in line:
            why.append(f"R-01  {'met' if new_row['centres'] else 'not met'} (centres)")
        elif line.lstrip().startswith("→"):
            why.append(f"→ {new_row['optMet']} of 2 optional — {summary[new_row['verdict']]}")
        else:
            why.append(line)
    what = []
    for line in row["What (criteria tested)"].split("\n"):
        if line.startswith("R-01") and "connects centres" in line:
            head, sep, tail = line.partition("—")
            if sep:
                what.append(f"R-01  {'PASS' if new_row['centres'] else 'fail'} —{tail}")
            else:
                what.append(f"R-01  {'PASS' if new_row['centres'] else 'fail'}")
        else:
            what.append(line)
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
