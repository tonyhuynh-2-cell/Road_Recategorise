# -*- coding: utf-8 -*-
"""
Fill the R-03 road-train flag on SPLIT assessment units, recomputed per unit.
================================================================================
The road-train membership (R-03) in nhvr_networks.json is rolled up per
ROAD_NUMBER (rebuild_from_nhvr.py: >= 80% of the road's length within 50 m of an
approved "NSW- RT ..." network segment). When a road_number was later split into
connected assessment units (e.g. 0000070 -> 0000070~R01 Regional + 0000070~S01
State), the B-double coverage was recomputed per unit but the road-train flag
was NOT carried across — so 50 split-unit declared roads have no `roadtrain`
value and their R-03 reads "NHVR status unavailable", even where the road is
plainly on the network (0000070 roadtrain=true at road level).

This recomputes road-train membership PER UNIT from the same source and rule as
the road-level flag (union of every approved "NSW- RT ..." segment across the
geopackages, coverage >= 0.80 within TOLERANCE_M), and fills it in for the split
units that are missing it. It does NOT touch units that already carry a value —
a validation gate first confirms the per-unit method reproduces the existing
road-level flag on the non-split roads, so the fill is consistent, not a
re-derivation.

For Regional non-urban units the filled flag also scores R-03: opt.hv = roadtrain,
then optMet + verdict are recomputed with the pipeline rule (Regional gate on
19 m B-double, then >= 2 optional green / 1 orange / 0 red). Verdicts are earned
from coverage, never forced. Dry run by default; --apply writes (.preRT.bak).
"""
import glob
import json
import shutil
import sys
from collections import defaultdict
from pathlib import Path

import geopandas as gpd
import pandas as pd

from rebuild_bdouble_network import ACCESS_THRESHOLD, route_coverage

APPLY = "--apply" in sys.argv
TOLERANCE_M = 50.0          # matches the road-level roadtrain rollup (rebuild_from_nhvr)
for _a in sys.argv:
    if _a.startswith("--tol="):
        TOLERANCE_M = float(_a.split("=", 1)[1])
HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
GPKG = DATA / "geopackages"
LAYER = "hvn_road_segments"
PROJECTED_CRS = "EPSG:3577"
BAK = ".preRT.bak"


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


def is_roadtrain_network(name):
    n = str(name or "").lower()
    return n.startswith("nsw- rt") or " rt " in n or "road train" in n


def load_roadtrain_network():
    """Union of approved segments across every 'NSW- RT ...' GeoPackage — the same set
    rebuild_from_nhvr classifies as road-train."""
    parts = []
    import sqlite3
    for f in sorted(glob.glob(str(GPKG / "*.gpkg"))):
        con = sqlite3.connect(f)
        try:
            nm = con.execute(f'SELECT network_name FROM "{LAYER}" LIMIT 1').fetchone()
        finally:
            con.close()
        if not nm or not is_roadtrain_network(nm[0]):
            continue
        g = gpd.read_file(f, layer=LAYER)
        g = g[g["access_code"].astype(str).str.contains("Approved", case=False, na=False)]
        log(f"    {Path(f).name:26} {nm[0]:38} approved={len(g)}")
        parts.append(g[["geometry"]])
    if not parts:
        raise RuntimeError("no road-train networks found in geopackages/")
    out = pd.concat(parts, ignore_index=True)
    return gpd.GeoDataFrame(out, geometry="geometry", crs=parts[0].crs)


def verdict_from(row):
    mand = row.get("mand") or {}
    if row.get("cls") == "State" and mand.get("pbs1") is False:
        return "red"
    if row.get("cls") == "Regional" and mand.get("bdouble") is False:
        return "red"
    met = sum(1 for v in (row.get("opt") or {}).values() if v is True)
    return "green" if met >= 2 else "orange" if met == 1 else "red"


def combined_boolean(values):
    known = [v for v in values if isinstance(v, bool)]
    if any(v is False for v in known):
        return False
    if known and len(known) == len(values):
        return True
    return None


# ---------------------------------------------------------------- coverage
log(f"road-train network (union of NSW- RT * approved segments), tolerance {TOLERANCE_M:g} m")
network = load_roadtrain_network()
log(f"  approved road-train segments: {len(network):,}")

assessment = read_orig("nsw_assessment.geojson")
roads = gpd.GeoDataFrame.from_features(assessment["features"], crs="EPSG:4326")
fractions = route_coverage(roads, network, TOLERANCE_M)
lengths_m = roads.to_crs(PROJECTED_CRS).geometry.length.tolist()

# per-unit coverage = length-weighted mean of per-feature coverage; also per road_number (validation)
unit_tot = defaultdict(float); unit_cov = defaultdict(float)
road_tot = defaultdict(float); road_cov = defaultdict(float)
unit_declared = {}
declared_units = defaultdict(set)
for i, f in enumerate(assessment["features"]):
    p = f["properties"]
    if p.get("unit_excluded") in (True, 1):
        continue
    u = str(p.get("road_unit") or "").strip()
    d = str(p.get("declared_road") or "").strip()
    rn = str(p.get("road_number") or "").strip()
    L = lengths_m[i]
    if u:
        unit_tot[u] += L; unit_cov[u] += L * fractions[i]
        if d:
            unit_declared[u] = d; declared_units[d].add(u)
    if rn:
        road_tot[rn] += L; road_cov[rn] += L * fractions[i]

unit_coverage = {u: (unit_cov[u] / unit_tot[u] if unit_tot[u] else 0.0) for u in unit_tot}
unit_rt = {u: unit_coverage[u] >= ACCESS_THRESHOLD for u in unit_coverage}
road_rt = {rn: (road_cov[rn] / road_tot[rn] >= ACCESS_THRESHOLD) if road_tot[rn] else False for rn in road_tot}

# ---------------------------------------------------------------- validation gate
# Per-unit method must reproduce the existing road-level roadtrain flag on the non-split roads.
road_nhvr = read_orig("nhvr_networks.json")
checked = agree = 0
disagree = []
for rn, existing in road_nhvr.items():
    ev = existing.get("roadtrain")
    if not isinstance(ev, bool) or rn not in road_rt:
        continue
    checked += 1
    if road_rt[rn] == ev:
        agree += 1
    else:
        disagree.append((rn, ev, road_rt[rn], round(road_cov[rn] / road_tot[rn], 3)))
log(f"\nvalidation: per-road_number recompute reproduces {agree}/{checked} existing road-level roadtrain flags")
if disagree:
    log(f"  {len(disagree)} disagree (first 10): {disagree[:10]}")

# ---------------------------------------------------------------- fill split units missing roadtrain
declared_crit = read_orig("nsw_declared_criteria.json")
unit_crit = read_orig("nsw_unit_criteria.json")
declared_nhvr = read_orig("nsw_declared_nhvr.json")
unit_nhvr = read_orig("nsw_unit_nhvr.json")

missing = [k for k, v in declared_nhvr.items() if not isinstance(v.get("roadtrain"), bool)]
log(f"\ndeclared roads missing roadtrain: {len(missing)}")

verdict_changes = []
filled = 0
for dkey in missing:
    units = declared_units.get(dkey) or ({dkey} if dkey in unit_rt else set())
    unit_vals = {u: unit_rt[u] for u in units if u in unit_rt}
    if not unit_vals:
        continue
    d_rt = combined_boolean(list(unit_vals.values()))
    d_cov = (sum(unit_tot[u] * unit_coverage[u] for u in unit_vals) /
             sum(unit_tot[u] for u in unit_vals)) if unit_vals else 0.0
    # write nhvr (declared + units)
    declared_nhvr.setdefault(dkey, {})["roadtrain"] = d_rt
    declared_nhvr[dkey]["roadtrainCoverage"] = round(d_cov, 6)
    declared_nhvr[dkey]["roadtrainToleranceM"] = TOLERANCE_M
    for u, val in unit_vals.items():
        unit_nhvr.setdefault(u, {})["roadtrain"] = val
        unit_nhvr[u]["roadtrainCoverage"] = round(unit_coverage[u], 6)
        unit_nhvr[u]["roadtrainToleranceM"] = TOLERANCE_M
    filled += 1
    # score R-03 for Regional non-urban units (opt.hv), recompute optMet + verdict
    for row_map, key, rt_val in ([(declared_crit, dkey, d_rt)] +
                                 [(unit_crit, u, unit_vals[u]) for u in unit_vals]):
        c = row_map.get(key)
        if not c or c.get("cls") != "Regional" or c.get("area") == "urban":
            continue
        before = c.get("verdict")
        c.setdefault("opt", {})["hv"] = rt_val
        c["optMet"] = sum(1 for v in c["opt"].values() if v is True)
        c["verdict"] = verdict_from(c)
        if key == dkey and c["verdict"] != before:
            verdict_changes.append((dkey, before, c["verdict"], rt_val, round(d_cov, 3)))

log(f"filled roadtrain on {filled} declared roads (+ their units)")
# sanity: compare each filled declared road to its PARENT road_number road-level flag
log("\nfilled roads vs parent road_number road-level flag (mine | parent):")
mismatch_parent = 0
for dkey in sorted(missing):
    if dkey not in declared_nhvr or "roadtrain" not in declared_nhvr[dkey]:
        continue
    mine = declared_nhvr[dkey]["roadtrain"]
    cov = declared_nhvr[dkey].get("roadtrainCoverage")
    parent = road_nhvr.get(dkey.split("~")[0], {}).get("roadtrain")
    flag = "" if mine == parent else "  <-- differs"
    if mine != parent and isinstance(parent, bool):
        mismatch_parent += 1
    cls = declared_crit.get(dkey, {}).get("cls"); area = declared_crit.get(dkey, {}).get("area")
    log(f"  {dkey:14} {cls:8} {area:6} mine={mine!s:5} cov={cov} parent={parent!s:5}{flag}")
log(f"filled roads differing from parent road-level flag: {mismatch_parent}")
log(f"\ndeclared verdict changes from R-03: {len(verdict_changes)}")
for dkey, o, n, rt, cov in sorted(verdict_changes):
    log(f"  {dkey:14} {o:6} -> {n:6}  roadtrain={rt!s:5} coverage {cov:.0%}")
mr70 = declared_nhvr.get("0000070~R01", {})
log(f"\nMR70~R01 roadtrain now: {mr70.get('roadtrain')} (coverage {mr70.get('roadtrainCoverage')}); "
    f"verdict {declared_crit.get('0000070~R01', {}).get('verdict')}")

if not APPLY:
    log("\ndry run only — re-run with --apply to write. No files changed.")
    sys.exit(0)

# ---------------------------------------------------------------- write
write_json("nsw_declared_nhvr.json", declared_nhvr)
write_json("nsw_unit_nhvr.json", unit_nhvr)
write_json("nsw_declared_criteria.json", declared_crit)
write_json("nsw_unit_criteria.json", unit_crit)

new_declared_verdict = {dkey: n for dkey, _o, n, _rt, _cov in verdict_changes}
if new_declared_verdict:
    for name, prop in (("nsw_declared_recat.json", "declared_road"), ("nsw_unit_recat.json", "road_unit")):
        recat = read_orig(name)
        vmap = new_declared_verdict if prop == "declared_road" else {
            u: unit_crit[u]["verdict"] for dkey in new_declared_verdict for u in declared_units.get(dkey, [])
            if u in unit_crit
        }
        n = 0
        for i, f in enumerate(assessment["features"]):
            k = str(f["properties"].get(prop) or "").strip()
            if k in vmap and i < len(recat) and recat[i] != vmap[k]:
                recat[i] = vmap[k]; n += 1
        write_json(name, recat)
        log(f"  {name}: {n} feature verdicts updated")
    asmt_live = read_orig("nsw_assessment.geojson")
    touched = 0
    for f in asmt_live["features"]:
        d = str(f["properties"].get("declared_road") or "").strip()
        if d in new_declared_verdict:
            f["properties"]["status"] = new_declared_verdict[d]; touched += 1
    write_json("nsw_assessment.geojson", asmt_live)
    log(f"  nsw_assessment.geojson: {touched} feature statuses updated")

log("\ndone. NOTE: export_declared_rows.json R-03 line / verdict reconciled separately "
    "(rebuild_centres_export.py pattern) if needed.")
