# -*- coding: utf-8 -*-
"""
Remote-zone town centres: apply the guide's REMOTE population thresholds.
=========================================================================
The guide's Point-of-interest definitions ease every centre tier in remote
areas: Regional City 15,000+ (vs 20,000), Major Town 5,000+ (vs 7,000),
Town Centre 1,000+ (vs 2,000). The network-based criteria (rural S-08, LDR,
unit reassessment) already honour this via centre_roles(zone) — but the
towns/evidence layer that drives R-01 ("Connects Urban Centres and Town
Centres to each other") was built with a FLAT 2,000 floor and flat tiers
(process_nsw.py), so:

  * remote towns of 1,000-2,000 people (Bourke, Walgett...) are absent
    from nsw_towns.geojson and from every road's evidence — a remote road
    connecting two of them can never earn R-01;
  * remote centres in the eased bands are under-tiered (Broken Hill 17,456
    = "Major Town" flat, but a remote Regional City at 15,000+).

Rule applied here (REMOTE-zone UCLs only — everything east of the Newell
stays exactly as assessed, since the flat thresholds ARE the guide's
regional-zone thresholds):

  remote            = the UCL's representative point lies west of the Newell
                      Hwy alignment — the same newell_longitude() crossing
                      rule rebuild_road_units.py uses for road zones;
  tiers (remote)    = Regional City >= 15,000 · Major Town >= 5,000 ·
                      Town Centre >= 1,000 (ABS UCL 2021 x Census G01);
  towns dataset     = re-tier existing remote towns; ADD qualifying remote
                      UCLs that are missing ('Remainder' catch-alls skipped);
  evidence          = for every non-urban road, added/re-tiered towns within
                      5.0 km of the road's geometry (the dataset's standard
                      town attach radius — beyond that only route termini
                      appear, which this script never fabricates) are
                      appended/updated in centres[] (kind 'town').

Downstream (run in this order after --apply):
  python rebuild_r01_rural_centres.py --apply    # R-01 re-score from evidence
  python rebuild_road_units.py --apply --raw-dir <dir with abs_lga_boundaries_2025>

Inputs (not in git): Newfile/ASGS_2021_SUA_UCL_SOS_SOSR_GPKG_GDA2020.gpkg
(auto-extracted from the .zip beside it), POI/Census_Population/
2021Census_G01_NSW_UCL.csv.

Written files (backed up to <name>.preRemoteTC.bak on first write):
  nsw_towns.geojson, nsw_evidence.json
Verdicts are earned from the data, never forced. Dry run by default.
"""
import json
import math
import shutil
import sys
import zipfile
from collections import defaultdict
from pathlib import Path

APPLY = "--apply" in sys.argv
HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
NEWFILE = HERE / "Newfile"
POI = HERE.parent / "POI"
GPKG = NEWFILE / "ASGS_2021_SUA_UCL_SOS_SOSR_GPKG_GDA2020.gpkg"
UCL_LAYER = "UCL_2021_AUST_GDA2020"
UCL_POP_CSV = POI / "Census_Population" / "2021Census_G01_NSW_UCL.csv"
ATTACH_KM = 5.0
REMOTE_TIERS = ((15_000, "Regional City"), (5_000, "Major Town"), (1_000, "Town Centre"))
BAK = ".preRemoteTC.bak"


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


def dist_km(a, b):
    mid_lat = math.radians((a[1] + b[1]) / 2.0)
    dx = (a[0] - b[0]) * math.cos(mid_lat)
    dy = a[1] - b[1]
    return math.hypot(dx, dy) * 111.32


# --- Newell Hwy boundary: identical crossing rule to rebuild_road_units.newell_longitude ---
def newell_longitude(newell_segments, latitude):
    crossings = []
    nearest = None
    for start, end in newell_segments:
        y1, y2 = start[1], end[1]
        distance = min(abs(latitude - y1), abs(latitude - y2))
        candidate = start[0] if abs(latitude - y1) <= abs(latitude - y2) else end[0]
        if nearest is None or distance < nearest[0]:
            nearest = (distance, candidate)
        if (y1 <= latitude <= y2) or (y2 <= latitude <= y1):
            if y1 == y2:
                crossings.extend((start[0], end[0]))
            else:
                ratio = (latitude - y1) / (y2 - y1)
                crossings.append(start[0] + ratio * (end[0] - start[0]))
    if crossings:
        crossings.sort()
        return crossings[len(crossings) // 2]
    return nearest[1] if nearest else None


def geometry_lines(geometry):
    if not geometry:
        return []
    if geometry.get("type") == "LineString":
        return [geometry.get("coordinates") or []]
    if geometry.get("type") == "MultiLineString":
        return [line for line in (geometry.get("coordinates") or []) if line]
    return []


# ---------------------------------------------------------------- load
towns = read_orig("nsw_towns.geojson")
evid = read_orig("nsw_evidence.json")
crit = json.load(open(DATA / "nsw_criteria.json", encoding="utf-8"))       # read-only
asmt = json.load(open(DATA / "nsw_assessment.geojson", encoding="utf-8"))  # read-only

newell_segments = []
for f in asmt["features"]:
    if "NEWELL" not in str(f["properties"].get("road_name") or "").upper():
        continue
    for line in geometry_lines(f.get("geometry")):
        newell_segments.extend(zip(line[:-1], line[1:]))
assert newell_segments, "no Newell Hwy segments found in nsw_assessment.geojson"
log(f"Newell Hwy boundary: {len(newell_segments)} segments")

# ---------------------------------------------------------------- remote UCLs
import geopandas as gpd            # noqa: E402
import pandas as pd                # noqa: E402

if not GPKG.exists():
    zp = GPKG.with_suffix(".zip")
    log(f"extracting {GPKG.name} from {zp.name}…")
    zipfile.ZipFile(zp).extract(GPKG.name, NEWFILE)

ucl = gpd.read_file(GPKG, layer=UCL_LAYER, where="STATE_CODE_2021 = '1'")
pop = pd.read_csv(UCL_POP_CSV, usecols=["UCL_CODE_2021", "Tot_P_P"])
pop["code"] = pop["UCL_CODE_2021"].astype(str).str.replace("UCL", "", regex=False)
ucl = ucl.merge(pop[["code", "Tot_P_P"]], left_on="UCL_CODE_2021", right_on="code", how="left")
ucl["Tot_P_P"] = ucl["Tot_P_P"].fillna(0)
ucl = ucl[ucl.geometry.notna() & ~ucl.geometry.is_empty
          & ~ucl["UCL_NAME_2021"].str.contains("Remainder", case=False, na=False)].copy()
ucl["pt"] = ucl.geometry.representative_point()

remote = []   # (name, pop, tier, lon, lat)
for r in ucl.itertuples():
    lon, lat = r.pt.x, r.pt.y
    bx = newell_longitude(newell_segments, lat)
    if bx is None or lon >= bx:
        continue
    p = int(r.Tot_P_P)
    tier = next((t for thr, t in REMOTE_TIERS if p >= thr), None)
    if tier:
        remote.append((str(r.UCL_NAME_2021), p, tier, round(lon, 5), round(lat, 5)))
log(f"remote-zone UCLs (west of Newell, pop >= 1,000): {len(remote)}")

# ---------------------------------------------------------------- towns dataset
by_name = {str(f["properties"].get("name")): f for f in towns["features"]}
SPECIAL_TIERS = {"Capital City", "Metropolitan Centre"}
retier, added = [], []
for name, p, tier, lon, lat in remote:
    f = by_name.get(name)
    if f is not None:
        pr = f["properties"]
        if pr.get("tier") in SPECIAL_TIERS:
            continue
        if pr.get("town_type") != tier:
            retier.append((name, p, pr.get("town_type"), tier))
            if APPLY:
                pr["town_type"] = tier
                pr["tier"] = tier
    else:
        added.append((name, p, tier))
        if APPLY:
            towns["features"].append({
                "type": "Feature",
                "properties": {"name": name, "population": float(p), "town_type": tier, "tier": tier},
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
            })

# ---------------------------------------------------------------- evidence
changed_towns = {name: (p, tier, lon, lat) for name, p, tier, lon, lat in remote
                 if any(name == n for n, *_ in retier) or any(name == n for n, *_ in added)}
rural_roads = [rn for rn, c in crit.items() if c.get("area") != "urban"]
road_lines = defaultdict(list)
for f in asmt["features"]:
    rn = str(f["properties"].get("road_number") or "").strip()
    if rn in crit and crit[rn].get("area") != "urban":
        for line in geometry_lines(f.get("geometry")):
            road_lines[rn].extend(line)

ev_added, ev_retier, roads_touched = 0, 0, set()
for rn in rural_roads:
    pts = road_lines.get(rn)
    if not pts:
        continue
    rec = evid.setdefault(rn, {}) if APPLY else (evid.get(rn) or {})
    centres = rec.get("centres") or []
    have = {str(e.get("name")) for e in centres}
    for name, (p, tier, lon, lat) in changed_towns.items():
        if name in have:
            e = next(e for e in centres if str(e.get("name")) == name)
            if e.get("kind") != "sua" and e.get("type") != tier:
                ev_retier += 1
                roads_touched.add(rn)
                if APPLY:
                    e["type"] = tier
            continue
        # cheap bbox prefilter (~0.1 deg ≈ 11 km) before the exact distance
        near = [q for q in pts if abs(q[0] - lon) < 0.1 and abs(q[1] - lat) < 0.1]
        if not near:
            continue
        d = min(dist_km((lon, lat), q) for q in near)
        if d <= ATTACH_KM:
            ev_added += 1
            roads_touched.add(rn)
            if APPLY:
                if "centres" not in rec:
                    rec["centres"] = centres
                centres.append({"name": name, "kind": "town", "pop": p, "type": tier,
                                "lon": lon, "lat": lat, "km": round(d, 1)})

# ---------------------------------------------------------------- report / write
log(f"towns re-tiered (remote thresholds): {len(retier)}")
for name, p, old, new in retier:
    log(f"  {name} ({p:,}): {old} -> {new}")
log(f"towns ADDED (remote, >=1,000, was below the flat 2,000 floor): {len(added)}")
for name, p, tier in sorted(added, key=lambda t: -t[1])[:15]:
    log(f"  {name} ({p:,}) -> {tier}")
if len(added) > 15:
    log(f"  … +{len(added) - 15} more")
log(f"evidence: {ev_added} town entries added, {ev_retier} re-typed, across {len(roads_touched)} rural roads")
log("NOTE: run rebuild_r01_rural_centres.py --apply then rebuild_road_units.py --apply next.")

if not APPLY:
    log("dry run only — re-run with --apply to write. No files were changed.")
    sys.exit(0)

write_json("nsw_towns.geojson", towns)
write_json("nsw_evidence.json", evid)
log("done.")
