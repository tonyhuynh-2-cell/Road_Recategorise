# -*- coding: utf-8 -*-
"""
Administrative-class corrections from the Schedule of Classified Roads V18.
============================================================================
Source of truth: TfNSW "Schedule of Classified Roads and Unclassified Regional
Roads", Version 18, March 2026 (SF2013/159234) — the legal record of each
gazetted road's administrative category. Cross-checking every numbered road in
data/nsw_assessment.geojson against the Schedule found 10 roads whose segments
(and in two cases the whole road) carry the wrong State/Regional class in the
sourced TfNSW categorisation extract:

  Stray segments (single mis-classed segments on otherwise-correct roads):
    0000002 Hume Hwy          1 R segment  -> S   (Schedule: State, GG21 22/2/08)
    0000010 Pacific Hwy      25 R segments -> S   (Schedule: State, GG56 23/4/10)
    0000527 Main Rd 527       1 R segment  -> S   (Schedule: State)
    0000642 Sunnyholt Rd      1 R segment  -> S   (Schedule: State)
    0000648 Cowpasture Rd     1 R segment  -> S   (Schedule: State)
    0000603 Carnley Ave       1 S segment  -> R   (Schedule: Regional)
    0007733 Old SH10 Tweed    1 S segment  -> R   (7000 series = unclassified Regional)
    0007765 Lemon Tree P. Rd  1 S segment  -> R   (7000 series)
    0007776 Old Pacific Taree 1 S segment  -> R   (7000 series)

  Whole-road re-class (the criteria engine also classed these State):
    0007731 Iluka Rd  2 S segments -> R; engine cls State -> Regional.
              The mandatory gate swaps from PBS Level 1 (met) to 19m B-double
              (NOT met per data/nhvr_networks.json) -> verdict re-earned red.
    0007776 Old Pacific Hwy through Taree  cls State -> Regional.
              19m B-double met; optional passes carry over (rural criteria, the
              urban R-05 re-scope does not apply) -> verdict stays green.

Nothing is forced: verdicts are recomputed by the SAME Regional verdict rule
the pipeline uses (red if mand.bdouble is false, else green if optMet >= 2,
orange if 1, else red), from already-earned NHVR/connectivity booleans.

Cascade (same precedent as rebuild_from_nhvr.py / rebuild_r05_urban_centres.py):
  nsw_assessment.geojson - per-segment admin_class flips (lens membership)
  nsw_criteria.json      - cls / mand.bdouble / verdict for 0007731, 0007776
  nsw_recat.json         - per-segment verdict array -> 0007731 segments red
  export_rows.json       - 0007731 + 0007776 move state -> regional (rural
                           R-01/R-02/R-04 wording), alphabetical insert

Each written file is first backed up to <name>.preSchedFix.bak (originals win
on re-runs, so the script is idempotent). Run with --apply to write; default
is a dry run (validate + report).
"""
import json
import shutil
import sys
from pathlib import Path

APPLY = "--apply" in sys.argv
DATA = Path(__file__).resolve().parent / "data"
BAK = ".preSchedFix.bak"

# road_number -> gazetted class per Schedule V18 (March 2026)
TARGET = {
    "0000002": "S", "0000010": "S", "0000527": "S", "0000642": "S", "0000648": "S",
    "0000603": "R", "0007731": "R", "0007733": "R", "0007765": "R", "0007776": "R",
}
RECLASS = ("0007731", "0007776")   # engine cls also changes State -> Regional


def log(*a):
    print(*a, flush=True)


def orig_path(name):
    p = DATA / name
    bak = p.with_name(p.name + BAK)
    return bak if bak.exists() else p


def read_orig(name):
    return json.load(open(orig_path(name), encoding="utf-8"))


def write_json(name, obj):
    p = DATA / name
    bak = p.with_name(p.name + BAK)
    if not bak.exists():
        shutil.copyfile(p, bak)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    log(f"  wrote {name} (backup: {bak.name})")


def regional_verdict(c):
    return ("red" if c["mand"].get("bdouble") is False
            else "green" if c["optMet"] >= 2 else "orange" if c["optMet"] == 1 else "red")


def state_verdict(c):
    return ("red" if c["mand"].get("pbs1") is False
            else "green" if c["optMet"] >= 2 else "orange" if c["optMet"] == 1 else "red")


# ---------------------------------------------------------------- load
asmt = read_orig("nsw_assessment.geojson")
crit = read_orig("nsw_criteria.json")
nhvr = read_orig("nhvr_networks.json")
recat = read_orig("nsw_recat.json")
exp = read_orig("export_rows.json")

# ---------------------------------------------------------------- validation gate
# The verdict rules must reproduce EVERY current verdict before we recompute anything.
bad = [k for k, c in crit.items()
       if (state_verdict(c) if c["cls"] == "State" else regional_verdict(c)) != c["verdict"]]
if bad:
    log(f"VALIDATION GATE FAILED — {len(bad)} roads do not reproduce: {bad[:10]}")
    sys.exit(1)
log(f"validation gate: verdict rules reproduce {len(crit)}/{len(crit)} current verdicts")
assert len(recat) == len(asmt["features"]), "recat/assessment length mismatch"

# ---------------------------------------------------------------- 1. segment flips
flips = {}
seg_idx = {rn: [] for rn in TARGET}
for i, f in enumerate(asmt["features"]):
    p = f["properties"]
    rn = str(p.get("road_number") or "").strip()
    if rn not in TARGET:
        continue
    seg_idx[rn].append(i)
    if p.get("admin_class") != TARGET[rn]:
        flips.setdefault(rn, []).append(i)
        p["admin_class"] = TARGET[rn]
log("segment admin_class flips: " +
    ", ".join(f"{rn}:{len(ix)}" for rn, ix in sorted(flips.items())))

# ---------------------------------------------------------------- 2. criteria re-class
crit_changes = {}
for rn in RECLASS:
    c = crit[rn]
    assert c["cls"] == "State", (rn, c["cls"])
    old_v = c["verdict"]
    c["cls"] = "Regional"
    c["mand"]["bdouble"] = bool((nhvr.get(rn) or {}).get("bdouble19"))
    c["verdict"] = regional_verdict(c)
    crit_changes[rn] = (old_v, c["verdict"], c["mand"]["bdouble"])
    log(f"  {rn}: cls State->Regional, bdouble={c['mand']['bdouble']}, "
        f"verdict {old_v} -> {c['verdict']} (optMet {c['optMet']})")

# ---------------------------------------------------------------- 3. recat cascade
recat_changed = 0
for rn, (old_v, new_v, _) in crit_changes.items():
    if new_v == old_v:
        continue
    for i in seg_idx[rn]:
        if recat[i] != new_v:
            recat[i] = new_v
            recat_changed += 1
log(f"recat segments changed: {recat_changed}")

# ---------------------------------------------------------------- 4. export rows
CAT = {"green": "Meets criteria", "orange": "Likely meets (1 of 2 optional)", "red": "Does not meet"}
SUM = {"green": "Meets criteria", "orange": "Likely meets (1 of 2)", "red": "Does not meet"}


def regional_row(row, c):
    """Rebuild a state-tab row as a rural Regional row (R-01/R-02/R-04 wording —
    both re-classed roads are area=rural, so the urban R-05 labels never apply)."""
    centres, dest = c["opt"]["centres"] is True, c["opt"]["dest"] is True
    bd, v = c["mand"]["bdouble"], c["verdict"]
    traffic_ln = row["What (criteria tested)"].split("\n")[-1]   # Traffic line carries over verbatim
    row = dict(row)
    row["Why"] = "\n".join([
        f"R-01  {'met' if centres else 'not met'} (centres)",
        f"R-02  {'met' if dest else 'not met'} (facilities)",
        f"R-04  {'met' if bd else 'not met'} (mandatory)",
        f"→ {c['optMet']} of 2 optional — {SUM[v]}",
    ])
    row["What (criteria tested)"] = "\n".join([
        f"R-01  {'PASS' if centres else 'fail'} — connects centres",
        f"R-02  {'PASS' if dest else 'fail'} — hospitals / ports / airports",
        f"R-04  {'PASS' if bd else 'fail'} — 19m B-double",
        traffic_ln,
    ])
    row["Categorisation"], row["_v"] = CAT[v], v
    return row


moved = []
for rn in RECLASS:
    src = [r for r in exp["state"] if str(r.get("Road ID", "")).strip() == rn]
    assert len(src) == 1, (rn, len(src))
    exp["state"].remove(src[0])
    moved.append(regional_row(src[0], crit[rn]))
    assert crit[rn]["area"] == "rural", rn   # R-01/R-02 wording precondition
for row in moved:
    # The tab lists were generated verdict-grouped (red, orange, green) with names
    # alphabetical inside each group; later verdict rebuilds edited rows in place.
    # Insert into the LONGEST run of this row's verdict, at its alphabetical spot.
    lst = exp["regional"]
    runs, start = [], None
    for i, r in enumerate(lst + [None]):
        if r is not None and r["_v"] == row["_v"]:
            if start is None:
                start = i
        elif start is not None:
            runs.append((start, i))
            start = None
    lo, hi = max(runs, key=lambda ab: ab[1] - ab[0])
    pos = next((i for i in range(lo, hi)
                if lst[i]["Road Name"].lower() > row["Road Name"].lower()), hi)
    lst.insert(pos, row)
    log(f"  export: {row['Road ID']} {row['Road Name']!r} state -> regional[{pos}] ({row['_v']})")
for tab in ("natsig",):
    assert not any(str(r.get("Road ID", "")).strip() in RECLASS for r in exp[tab]), tab

# ---------------------------------------------------------------- post-fix checks
for rn, tgt in TARGET.items():
    classes = {asmt["features"][i]["properties"]["admin_class"] for i in seg_idx[rn]}
    assert classes == {tgt}, (rn, classes)
log(f"post-check: all 10 roads single-class per Schedule; "
    f"export state {266 if len(exp['state']) == 264 else '?'}->{len(exp['state'])}, "
    f"regional ->{len(exp['regional'])}")

if not APPLY:
    log("dry run only — re-run with --apply to write. No files were changed.")
    sys.exit(0)

write_json("nsw_assessment.geojson", asmt)
write_json("nsw_criteria.json", crit)
write_json("nsw_recat.json", recat)
write_json("export_rows.json", exp)
log("done.")
