# -*- coding: utf-8 -*-
"""
Re-score the S-10 / R-05 "connects centres" optional at Major-Town granularity,
excluding the metropolitan capital bubble.
================================================================================
The connectivity option ("Connects Metro Centres / Regional Cities / Major Urban
Centres / Major Towns to each other") passes when a road links >= 2 DISTINCT
qualifying centres. Two corrections, applied to the DECLARED-road runtime files
(the layer the dashboard reads) without the full rebuild_road_units.py, which is
blocked on raw inputs:

  1. Drop the metropolitan capital bubble. Greater Sydney (4.7 M), and the other
     four SUA conurbations >= 100 k (Newcastle, Newcastle-Maitland, Central Coast,
     Wollongong), resolve to ONE giant centre, so a road that never leaves the
     metro could only ever "connect" that single bubble. A capital city is a
     Nationally-Significant connectivity target, not a State/Regional one, so any
     centre with pop >= 100 000 that is NOT a suburb (kind != 'sal') is excluded
     here and the road is judged on the SUBURBS (SAL 2021) it actually links.
     (No SAL reaches 100 k — the largest, Blacktown, is 51 k — so kind!='sal'
     never drops a suburb; it only removes the five metro bubbles.)

  2. Qualify centres at the Major-Town floor, per zone. S-10/R-05 say "Major
     Towns" / "Major Urban Centres"; in this tool a Major Town is >= 7 000
     (>= 5 000 remote). The connectivity option is raised to that floor, with a
     stricter Major-Urban-Centre floor of 10 000 inside urban zones:
         urban 10 000   |   regional 7 000   |   remote 5 000
     (The previous data counted Town Centres down to ~2 000, more permissive than
     the criterion text.)

`centres` is an OPTIONAL, so a flip changes the optional count and can move the
verdict. Each verdict is recomputed from the road's OWN other optionals with the
same rule the pipeline uses (verdict_of): the class gate first (State -> PBS-1,
Regional -> 19 m B-double), then >= 2 optional green / 1 orange / 0 red. Nothing
is forced — a road left with < 2 qualifying centres loses the option and may fall.

Writes the three files the UI grades from (declared criteria -> stats + cross-test;
declared recat[i] -> map colour + NSW_AGG.status; assessment feature status), and
the unit intermediates for coherence. Dry run by default; --apply writes
(.preCentres.bak backups; originals win on re-runs so the script is idempotent).
NOT patched: export_declared_rows.json / export_unit_rows.json (verdict-grouped
ordering) — these reconcile on the next full rebuild_road_units.py run.
"""
import json
import shutil
import sys
from collections import Counter
from pathlib import Path

APPLY = "--apply" in sys.argv
HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
BAK = ".preCentres.bak"
METRO_MIN = 100_000
FLOOR = {"urban": 10_000, "regional": 7_000, "remote": 5_000}
RANK = {"red": 0, "orange": 1, "green": 2}


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


def verdict_from(row):
    """rebuild_road_units.verdict_of, verbatim: class gate first, then optional count."""
    mand = row.get("mand") or {}
    if row.get("cls") == "State" and mand.get("pbs1") is False:
        return "red"
    if row.get("cls") == "Regional" and mand.get("bdouble") is False:
        return "red"
    opt_met = row.get("optMet")
    if opt_met is None:
        opt_met = sum(1 for v in (row.get("opt") or {}).values() if v is True)
    return "green" if opt_met >= 2 else "orange" if opt_met == 1 else "red"


def qualifying_names(centres, zone):
    """Distinct qualifying centre names after dropping the metro bubble and applying the
    zone's Major-Town floor."""
    floor = FLOOR.get(zone, 7_000)
    names = set()
    for c in centres:
        pop = c.get("pop") or c.get("population") or 0
        if pop >= METRO_MIN and c.get("kind") != "sal":   # capital-city bubble -> NatSig only
            continue
        if pop >= floor:
            nm = str(c.get("name") or "").strip()
            if nm:
                names.add(nm)
    return names


def recompute(crit, evid, zones, area_default):
    """Recompute opt.centres / optMet / verdict in-place. Returns {key: (old_v, new_v)} for
    rows whose verdict changed, plus the count of criterion flips."""
    verdict_changed = {}
    flip = 0
    for key, row in crit.items():
        opt = row.get("opt") or {}
        if opt.get("centres") is None:            # centres not assessed (natsig-only / non S,R)
            continue
        zone = zones.get(key) or ("urban" if row.get("area") == area_default else "regional")
        new_c = len(qualifying_names(evid.get(key, {}).get("centres", []), zone)) >= 2
        if new_c == opt.get("centres"):
            continue
        flip += 1
        before = row.get("verdict")
        opt["centres"] = new_c
        row["opt"] = opt
        row["optMet"] = sum(1 for v in opt.values() if v is True)
        row["verdict"] = verdict_from(row)
        if row["verdict"] != before:
            verdict_changed[key] = (before, row["verdict"])
    return verdict_changed, flip


# ---------------------------------------------------------------- declared layer
declared_crit = read_orig("nsw_declared_criteria.json")
declared_ev = read_orig("nsw_declared_evidence.json")
declared_zone = read_orig("nsw_declared_zone.json")
declared_changed, declared_flip = recompute(declared_crit, declared_ev, declared_zone, "urban")

# ---------------------------------------------------------------- unit layer (coherence only)
unit_crit = read_orig("nsw_unit_criteria.json")
unit_ev = read_orig("nsw_unit_evidence.json")
unit_zone = read_orig("nsw_unit_zone.json")
unit_changed, unit_flip = recompute(unit_crit, unit_ev, unit_zone, "urban")

# ---------------------------------------------------------------- report
zone_of = lambda k: declared_zone.get(k) or ("urban" if declared_crit[k].get("area") == "urban" else "regional")
up = sum(1 for k, (o, n) in declared_changed.items() if RANK[n] > RANK[o])
down = sum(1 for k, (o, n) in declared_changed.items() if RANK[n] < RANK[o])
trans = Counter((declared_crit[k]["cls"], zone_of(k), o, n) for k, (o, n) in declared_changed.items())
log(f"metro bubble floor {METRO_MIN:,} (non-suburb); zone floors {FLOOR}")
log(f"\nDECLARED: opt.centres flips {declared_flip}  ->  verdict changes {len(declared_changed)} "
    f"(up {up}, down {down})")
log("transitions (cls, zone, old->new):")
for (cls, z, o, n), ct in sorted(trans.items()):
    log(f"  {cls:8} {z:8} {o:6}->{n:6}: {ct}")
log(f"\nUNIT (non-UI, coherence): opt.centres flips {unit_flip}, verdict changes {len(unit_changed)}")

log("\nsample declared verdict changes:")
for k in sorted(declared_changed)[:30]:
    o, n = declared_changed[k]
    z = zone_of(k)
    nm = sorted(qualifying_names(declared_ev.get(k, {}).get("centres", []), z))
    log(f"  {k:14} {declared_crit[k]['cls']:8} {z:8} {o:6}->{n:6}  centres={nm[:5]}{'...' if len(nm) > 5 else ''}")

if not APPLY:
    log("\ndry run only — re-run with --apply to write. No files changed.")
    sys.exit(0)

# ---------------------------------------------------------------- write criteria
write_json("nsw_declared_criteria.json", declared_crit)
write_json("nsw_unit_criteria.json", unit_crit)

# ---------------------------------------------------------------- recat (list parallel to features)
# recat[i] -> _roadStatus (map colour) + NSW_AGG.status in init.js; keyed by declared_road / road_unit.
assessment = read_orig("nsw_assessment.geojson")
features = assessment["features"]


def patch_recat(name, vmap, prop):
    recat = read_orig(name)
    n = 0
    for i, f in enumerate(features):
        k = str(f["properties"].get(prop) or "").strip()
        if k in vmap and i < len(recat):
            new_v = vmap[k]
            if recat[i] != new_v:
                recat[i] = new_v
                n += 1
    write_json(name, recat)
    log(f"  {name}: {n} feature verdicts updated")


declared_vmap = {k: n for k, (o, n) in declared_changed.items()}
unit_vmap = {k: unit_crit[k]["verdict"] for k in unit_changed}
patch_recat("nsw_declared_recat.json", declared_vmap, "declared_road")
patch_recat("nsw_unit_recat.json", unit_vmap, "road_unit")

# ---------------------------------------------------------------- assessment feature status
touched = 0
for f in features:
    d = str(f["properties"].get("declared_road") or "").strip()
    if d in declared_vmap:
        f["properties"]["status"] = declared_vmap[d]
        touched += 1
write_json("nsw_assessment.geojson", assessment)
log(f"  nsw_assessment.geojson: {touched} feature statuses updated")

log("\ndone. NOTE: export_declared_rows.json / export_unit_rows.json NOT patched "
    "(verdict-grouped ordering) — reconcile on the next full rebuild_road_units.py run.")
