# -*- coding: utf-8 -*-
"""
Rebuild the State facility / employment optional criterion (S-08 / S-11).

The TfNSW guide defines the State Road facility criterion as a connection
between a qualifying facility and OTHER CENTRE TYPES:

  * S-08 (Rural): "Connects Major Hospital, Major Ports, Major Intermodals,
    International Airports, Commercial, Industrial or Employment Centres to
    Other Centre Types."
  * S-11 (Sydney / Metropolitan): the same set "to other centre types".

The legacy scorer was one-legged: it passed if the road merely came within a
buffer of a hospital or a port/airport/intermodal (process_nsw.py
connects_hospital / connects_destination), never testing the connection TO a
centre, and never letting Commercial / Industrial / Employment centres
qualify. This rebuild mirrors rebuild_regional_facility_optional.py: the
qualifying facility must share a connected road-geometry component with a
qualifying centre.

Qualifying facilities (State set — stricter than R-02/R-06):
  * hospitals[]  - all entries (the dataset IS the Major Health Services set:
                   Urban 400+ / Regional 100+ / Remote 15+ beds);
  * dests[]      - ftype in {Major Port, Major Intermodal, International
                   Airport}; Regional Airports qualify for R-02 only;
  * employment[] - tier in {Regional, Major} (the +$/hectare state-economic-
                   generation thresholds); Local never qualifies.

Qualifying centres ("other centre types", per the guide's Point-of-interest
definitions — Metropolitan Centres / Regional Cities / Major Towns & Major
Urban Centres / Town & Urban Centres):
  * rural roads  - centres[] entries typed Significant Urban Area, Regional
                   City, Major Town or Town Centre;
  * urban roads  - centres[] entries of kind 'sal' (ABS SAL suburbs >= 7,000
                   people, rebuild_sal_urban_centres.py — the guide's own SaL
                   fallback for centre populations), plus any typed entries
                   (Significant Urban Area / Regional City / Major Town).

The computed value is stored in stateOpt.dest* for EVERY road (merged beside
the stateOpt.ldr* keys, never replacing them) so Regional roads use the same
accurate value when cross-tested against the State criteria. State roads also
receive the value in opt.dest, with optMet and verdict rebuilt from the
normal mandatory-gate rule. Verdicts are earned from the data, never forced.

Written files (each backed up to <name>.preStateDest.bak on first write):
  nsw_criteria.json - stateOpt.dest* metadata for every road; State roads
                      also get opt.dest / optMet / verdict
  nsw_recat.json    - per-segment verdicts for changed State roads
  export_rows.json  - State export summaries and S-08/S-11 wording

Run with --apply to write. Without --apply this reports the impact only.
"""

import json
import math
import shutil
import sys
from collections import Counter, defaultdict
from pathlib import Path


APPLY = "--apply" in sys.argv
DATA = Path(__file__).resolve().parent / "data"
BAK = ".preStateDest.bak"
CONNECT_KM = 0.2
STATE_DEST_FTYPES = {"Major Port", "Major Intermodal", "International Airport"}
EMPLOYMENT_TIERS = {"Regional", "Major"}
RURAL_CENTRE_TYPES = {
    "Significant Urban Area",
    "Regional City",
    "Major Town",
    "Town Centre",
}
URBAN_CENTRE_TYPES = {
    "Significant Urban Area",
    "Regional City",
    "Major Town",
}


def log(*args):
    print(*args, flush=True)


def orig_path(name):
    path = DATA / name
    backup = path.with_name(path.name + BAK)
    return backup if backup.exists() else path


def read_json(name):
    with open(orig_path(name), encoding="utf-8") as f:
        return json.load(f)


def write_json(name, obj):
    path = DATA / name
    backup = path.with_name(path.name + BAK)
    if not backup.exists():
        shutil.copyfile(path, backup)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    log(f"  wrote {name} (backup: {backup.name})")


def dist_km(a, b):
    mid_lat = math.radians((a[1] + b[1]) / 2.0)
    dx = (a[0] - b[0]) * math.cos(mid_lat)
    dy = a[1] - b[1]
    return math.hypot(dx, dy) * 111.32


def line_length_km(coords):
    return sum(dist_km(coords[i - 1], coords[i]) for i in range(1, len(coords)))


def geometry_lines(geometry):
    if not geometry:
        return []
    if geometry.get("type") == "LineString":
        return [geometry.get("coordinates") or []]
    if geometry.get("type") == "MultiLineString":
        return [line for line in (geometry.get("coordinates") or []) if line]
    return []


def point_line_dist_km(point, line):
    if not line:
        return float("inf")
    return min(dist_km(point, coord) for coord in line)


def road_components(lines):
    if not lines:
        return []
    parent = list(range(len(lines)))

    def find(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(left, right):
        root_left, root_right = find(left), find(right)
        if root_left != root_right:
            parent[root_right] = root_left

    ends = [(line[0], line[-1]) for line in lines]
    for left in range(len(lines)):
        for right in range(left + 1, len(lines)):
            if min(dist_km(a, b) for a in ends[left] for b in ends[right]) <= CONNECT_KM:
                union(left, right)

    groups = defaultdict(list)
    for index in range(len(lines)):
        groups[find(index)].append(index)

    return sorted(({
        "lines": [lines[index] for index in indexes],
        "km": sum(line_length_km(lines[index]) for index in indexes),
        "centres": set(),
        "facilities": set(),
    } for indexes in groups.values()), key=lambda component: component["km"], reverse=True)


def nearest_component(point, components):
    best, best_distance = None, float("inf")
    for component in components:
        distance = min(point_line_dist_km(point, line) for line in component["lines"])
        if distance < best_distance:
            best, best_distance = component, distance
    return best


def add_points(components, items, bucket, predicate):
    for item in items or []:
        name = str(item.get("name") or "").strip()
        if not name or item.get("lon") is None or item.get("lat") is None or not predicate(item):
            continue
        component = nearest_component([item["lon"], item["lat"]], components)
        if component is not None:
            component[bucket].add(name)


def centre_ok(item, area):
    # Urban centres evidence is SAL suburbs (rebuild_sal_urban_centres.py); typed UCL/SUA
    # entries qualify wherever they still appear.
    if area == "urban":
        return item.get("kind") == "sal" or item.get("type") in URBAN_CENTRE_TYPES
    return item.get("type") in RURAL_CENTRE_TYPES


def evaluate_state_dest(lines, evidence_row, area):
    components = road_components(lines)
    evidence_row = evidence_row or {}
    add_points(components, evidence_row.get("centres"), "centres",
               lambda item: centre_ok(item, area))
    add_points(components, evidence_row.get("hospitals"), "facilities", lambda _item: True)
    add_points(components, evidence_row.get("dests"), "facilities",
               lambda item: item.get("ftype") in STATE_DEST_FTYPES)
    add_points(components, evidence_row.get("employment"), "facilities",
               lambda item: item.get("tier") in EMPLOYMENT_TIERS)

    qualifying = [component for component in components if component["centres"] and component["facilities"]]
    best = qualifying[0] if qualifying else (components[0] if components else None)
    all_centres = sorted({name for component in components for name in component["centres"]})
    all_facilities = sorted({name for component in components for name in component["facilities"]})

    return {
        "dest": bool(qualifying),
        "dest_component_km": round((best or {}).get("km", 0.0), 1),
        "dest_centre_names": sorted((best or {}).get("centres", [])),
        "dest_facility_names": sorted((best or {}).get("facilities", [])),
        "dest_all_centre_names": all_centres,
        "dest_all_facility_names": all_facilities,
        "dest_component_count": len(components),
    }


def optional_count(options):
    return sum(1 for value in options.values() if value is True)


def verdict_of(criteria_row, optional_met):
    gate = (criteria_row["mand"].get("pbs1") if criteria_row["cls"] == "State"
            else criteria_row["mand"].get("bdouble"))
    if gate is False:
        return "red"
    if optional_met >= 2:
        return "green"
    if optional_met == 1:
        return "orange"
    return "red"


CAT = {"green": "Meets criteria", "orange": "Likely meets (1 of 2 optional)", "red": "Does not meet"}
SUM = {"green": "Meets criteria", "orange": "Likely meets (1 of 2)", "red": "Does not meet"}


criteria = read_json("nsw_criteria.json")
evidence = read_json("nsw_evidence.json")
assessment = json.load(open(DATA / "nsw_assessment.geojson", encoding="utf-8"))  # read-only

# ---------------------------------------------------------------- validation gate
bad = [rn for rn, c in criteria.items()
       if optional_count(c["opt"]) != c["optMet"]
       or verdict_of(c, c["optMet"]) != c["verdict"]]
if bad:
    log(f"VALIDATION GATE FAILED - {len(bad)} roads do not reproduce: {bad[:10]}")
    sys.exit(1)
log(f"validation gate: verdict rule reproduces {len(criteria)}/{len(criteria)} roads")

# ---------------------------------------------------------------- geometry
road_lines = defaultdict(list)
road_names = defaultdict(set)
for feature in assessment["features"]:
    properties = feature.get("properties") or {}
    rn = str(properties.get("road_number") or "").strip()
    if not rn:
        continue
    for line in geometry_lines(feature.get("geometry")):
        if len(line) >= 2:
            road_lines[rn].append(line)
    if properties.get("road_name"):
        road_names[rn].add(str(properties["road_name"]))

# ---------------------------------------------------------------- derive
derived = {rn: evaluate_state_dest(road_lines.get(rn, []), evidence.get(rn), c["area"])
           for rn, c in criteria.items()}

changed = {}
info_changed = 0
for rn, c in criteria.items():
    info = derived[rn]
    if any((c.get("stateOpt") or {}).get(key) != value for key, value in info.items()):
        info_changed += 1
    if c["cls"] != "State":
        continue
    new_options = dict(c["opt"])
    new_options["dest"] = info["dest"]
    new_opt_met = optional_count(new_options)
    new_verdict = verdict_of(c, new_opt_met)
    if (c["opt"].get("dest") != info["dest"] or c["optMet"] != new_opt_met
            or c["verdict"] != new_verdict):
        changed[rn] = {"dest": info["dest"], "optMet": new_opt_met, "verdict": new_verdict}

# ---------------------------------------------------------------- impact matrix
flips = Counter((criteria[rn]["opt"].get("dest"), row["dest"]) for rn, row in changed.items())
transitions = Counter((criteria[rn]["verdict"], row["verdict"]) for rn, row in changed.items())
def split(predicate):
    old = Counter(c["verdict"] for rn, c in criteria.items() if predicate(rn, c))
    new = Counter(changed[rn]["verdict"] if rn in changed else c["verdict"]
                  for rn, c in criteria.items() if predicate(rn, c))
    return old, new
fmt = lambda ctr: f"{ctr['green']}/{ctr['orange']}/{ctr['red']} (g/o/r)"
all_old, all_new = split(lambda rn, c: True)
st_old, st_new = split(lambda rn, c: c["cls"] == "State")
ru_old, ru_new = split(lambda rn, c: c["cls"] == "State" and c["area"] != "urban")
ur_old, ur_new = split(lambda rn, c: c["cls"] == "State" and c["area"] == "urban")
log(f"roads with new State facility metadata: {info_changed}")
log(f"State roads with S-08/S-11 score changes: {len(changed)}")
log("dest flips: " + (", ".join(f"{a}->{b}: {n}" for (a, b), n in sorted(flips.items(), key=lambda i: str(i[0]))) or "none"))
log("verdict transitions: " + (", ".join(f"{a}->{b}: {n}" for (a, b), n in sorted(transitions.items())) or "none"))
log(f"named-road split (892): {fmt(all_old)} -> {fmt(all_new)}")
log(f"State-only split:       {fmt(st_old)} -> {fmt(st_new)}")
log(f"rural State split:      {fmt(ru_old)} -> {fmt(ru_new)}")
log(f"urban State split:      {fmt(ur_old)} -> {fmt(ur_new)}")

if not APPLY:
    log("dry run only - re-run with --apply to write. No files were changed.")
    sys.exit(0)

# ---------------------------------------------------------------- 1. nsw_criteria.json
# stateOpt also carries the ldr_* keys (rebuild_state_ldr_optional.py) — MERGE, never replace.
for rn, info in derived.items():
    criteria[rn].setdefault("stateOpt", {}).update(info)
for rn, row in changed.items():
    criteria[rn]["opt"]["dest"] = row["dest"]
    criteria[rn]["optMet"] = row["optMet"]
    criteria[rn]["verdict"] = row["verdict"]
write_json("nsw_criteria.json", criteria)

# ---------------------------------------------------------------- 2. nsw_recat.json
recat = read_json("nsw_recat.json")
assert len(recat) == len(assessment["features"]), "recat/assessment length mismatch"
segments_changed = 0
for index, feature in enumerate(assessment["features"]):
    rn = str((feature.get("properties") or {}).get("road_number") or "").strip()
    if rn in changed and recat[index] != changed[rn]["verdict"]:
        recat[index] = changed[rn]["verdict"]
        segments_changed += 1
write_json("nsw_recat.json", recat)
log(f"  recat segments changed: {segments_changed}")

# ---------------------------------------------------------------- 3. export_rows.json
exports = read_json("export_rows.json")
rows_touched = 0
for row in exports["state"]:
    rn = str(row.get("Road ID") or "").strip()
    c = criteria.get(rn)
    if not c or c["cls"] != "State":
        continue
    code = "S-11" if c["area"] == "urban" else "S-08"
    dest = c["opt"].get("dest") is True
    why_lines, what_lines = [], []
    for line in row["Why"].split("\n"):
        if line.startswith(code) and "facilit" in line:
            why_lines.append(f"{code}  {'met' if dest else 'not met'} (facilities / employment)")
        elif line.lstrip().startswith("→"):
            if "of 2 optional" in line:
                why_lines.append(f"→ {c['optMet']} of 2 optional — {SUM[c['verdict']]}")
            else:
                why_lines.append(f"→ {c['optMet']} optional met — {SUM[c['verdict']]}")
        else:
            why_lines.append(line)
    for line in row["What (criteria tested)"].split("\n"):
        if line.startswith(code) and ("hospitals" in line or "facilit" in line):
            what_lines.append(f"{code}  {'PASS' if dest else 'fail'} — qualifying facility/employment centre connected to another centre type")
        else:
            what_lines.append(line)
    new_why, new_what = "\n".join(why_lines), "\n".join(what_lines)
    if new_why != row["Why"] or new_what != row["What (criteria tested)"]:
        rows_touched += 1
    row["Why"], row["What (criteria tested)"] = new_why, new_what
    row["Categorisation"], row["_v"] = CAT[c["verdict"]], c["verdict"]
write_json("export_rows.json", exports)
log(f"  export State rows updated: {rows_touched}")

log("done.")
