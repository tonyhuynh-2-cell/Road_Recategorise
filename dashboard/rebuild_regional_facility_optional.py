# -*- coding: utf-8 -*-
"""
Rebuild the Regional facility / employment optional criterion.

The TfNSW guide defines the Regional Road facility criterion as a connection
between a qualifying facility or employment centre and a qualifying centre:

  * R-02 (Regional / Remote): Major or Regional hospitals, ports,
    intermodals, airports, commercial, industrial or employment centres to
    Town Centres and Urban Centres.
  * R-06 (Sydney / Metropolitan): those facilities and employment centres to
    Major Urban Centres or Major Towns.

The legacy scorer only used hospitals, ports, airports and intermodals. It
already displayed Commercial and Industrial evidence, but did not let that
evidence satisfy R-02/R-06. This rebuild accepts only Regional- and
Major-tier employment evidence, and requires it to share a connected road
geometry component with a qualifying centre. Local employment centres do not
qualify.

The computed value is stored in regionalOpt.dest for every road so State roads
can use the same accurate value when tested against the Regional criteria.
Regional roads also receive the value in opt.dest, with optMet and verdict
rebuilt from the normal mandatory-gate rule.

Written files:
  nsw_criteria.json - regionalOpt.dest metadata for every road; Regional
                      roads also get opt.dest / optMet / verdict
  nsw_recat.json    - per-segment verdicts for changed Regional roads
  export_rows.json  - Regional export summaries and R-02/R-06 wording

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
BAK = ".preRegionalDest.bak"
CONNECT_KM = 0.2
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
EMPLOYMENT_TIERS = {"Regional", "Major"}


def log(*args):
    print(*args, flush=True)


def read_json(name):
    with open(DATA / name, encoding="utf-8") as f:
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


def centre_types(area):
    return URBAN_CENTRE_TYPES if area == "urban" else RURAL_CENTRE_TYPES


def evaluate_regional_dest(lines, evidence_row, area):
    components = road_components(lines)
    evidence_row = evidence_row or {}
    add_points(
        components,
        evidence_row.get("centres"),
        "centres",
        lambda item: item.get("type") in centre_types(area),
    )
    add_points(components, evidence_row.get("hospitals"), "facilities", lambda _item: True)
    add_points(components, evidence_row.get("dests"), "facilities", lambda _item: True)
    add_points(
        components,
        evidence_row.get("employment"),
        "facilities",
        lambda item: item.get("tier") in EMPLOYMENT_TIERS,
    )

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


def verdict_of(criteria, optional_met):
    if criteria["cls"] == "Regional" and criteria["mand"].get("bdouble") is False:
        return "red"
    if criteria["cls"] == "State" and criteria["mand"].get("pbs1") is False:
        return "red"
    if optional_met >= 2:
        return "green"
    if optional_met == 1:
        return "orange"
    return "red"


def category(verdict):
    return {
        "green": "Meets criteria",
        "orange": "Likely meets (1 optional)",
        "red": "Does not meet",
    }[verdict]


criteria = read_json("nsw_criteria.json")
evidence = read_json("nsw_evidence.json")
assessment = read_json("nsw_assessment.geojson")

bad = [
    road_number for road_number, criterion in criteria.items()
    if optional_count(criterion["opt"]) != criterion["optMet"]
    or verdict_of(criterion, criterion["optMet"]) != criterion["verdict"]
]
if bad:
    log(f"VALIDATION GATE FAILED - {len(bad)} roads do not reproduce: {bad[:10]}")
    sys.exit(1)
log(f"validation gate: verdict rule reproduces {len(criteria)}/{len(criteria)} roads")

road_lines = defaultdict(list)
road_names = defaultdict(set)
for feature in assessment["features"]:
    properties = feature.get("properties") or {}
    road_number = str(properties.get("road_number") or "").strip()
    if not road_number:
        continue
    for line in geometry_lines(feature.get("geometry")):
        if len(line) >= 2:
            road_lines[road_number].append(line)
    if properties.get("road_name"):
        road_names[road_number].add(str(properties["road_name"]))

derived = {
    road_number: evaluate_regional_dest(
        road_lines.get(road_number, []), evidence.get(road_number), criterion["area"]
    )
    for road_number, criterion in criteria.items()
}

changed = {}
info_changed = {}
for road_number, criterion in criteria.items():
    info = derived[road_number]
    if any((criterion.get("regionalOpt") or {}).get(key) != value for key, value in info.items()):
        info_changed[road_number] = info
    if criterion["cls"] != "Regional":
        continue
    new_options = dict(criterion["opt"])
    new_options["dest"] = info["dest"]
    new_optional_met = optional_count(new_options)
    new_verdict = verdict_of(criterion, new_optional_met)
    if (
        criterion["opt"].get("dest") != info["dest"]
        or criterion["optMet"] != new_optional_met
        or criterion["verdict"] != new_verdict
    ):
        changed[road_number] = {
            "dest": info["dest"],
            "optMet": new_optional_met,
            "verdict": new_verdict,
            "info": info,
        }

flips = Counter((criteria[rn]["opt"].get("dest"), row["dest"]) for rn, row in changed.items())
transitions = Counter((criteria[rn]["verdict"], row["verdict"]) for rn, row in changed.items())


def split(predicate):
    old = Counter(criterion["verdict"] for rn, criterion in criteria.items() if predicate(rn, criterion))
    new = Counter(
        changed[rn]["verdict"] if rn in changed else criterion["verdict"]
        for rn, criterion in criteria.items()
        if predicate(rn, criterion)
    )
    return old, new


def fmt(counter):
    return f"{counter['green']}/{counter['orange']}/{counter['red']} (g/o/r)"


all_old, all_new = split(lambda _rn, _criterion: True)
regional_old, regional_new = split(lambda _rn, criterion: criterion["cls"] == "Regional")
rural_old, rural_new = split(
    lambda _rn, criterion: criterion["cls"] == "Regional" and criterion["area"] != "urban"
)
urban_old, urban_new = split(
    lambda _rn, criterion: criterion["cls"] == "Regional" and criterion["area"] == "urban"
)

log(f"roads with new Regional facility metadata: {len(info_changed)}")
log(f"Regional roads with R-02/R-06 score changes: {len(changed)}")
log("dest flips: " + (", ".join(
    f"{old}->{new}: {count}" for (old, new), count in sorted(flips.items(), key=lambda item: str(item[0]))
) or "none"))
log("verdict transitions: " + (", ".join(
    f"{old}->{new}: {count}" for (old, new), count in sorted(transitions.items())
) or "none"))
log(f"named-road split:       {fmt(all_old)} -> {fmt(all_new)}")
log(f"Regional-only split:    {fmt(regional_old)} -> {fmt(regional_new)}")
log(f"rural Regional split:   {fmt(rural_old)} -> {fmt(rural_new)}")
log(f"urban Regional split:   {fmt(urban_old)} -> {fmt(urban_new)}")

for road_number in ("0000105",):
    if road_number in derived:
        info = derived[road_number]
        label = " / ".join(sorted(road_names.get(road_number, [])))
        log(
            f"{road_number} {label}: R-dest={info['dest']} component={info['dest_component_km']} km "
            f"centres={info['dest_centre_names']} facilities={info['dest_facility_names']} "
            f"components={info['dest_component_count']}"
        )

if not APPLY:
    log("dry run only - re-run with --apply to write. No files were changed.")
    sys.exit(0)

for road_number, info in derived.items():
    criteria[road_number]["regionalOpt"] = info
for road_number, row in changed.items():
    criterion = criteria[road_number]
    criterion["opt"]["dest"] = row["dest"]
    criterion["optMet"] = row["optMet"]
    criterion["verdict"] = row["verdict"]
write_json("nsw_criteria.json", criteria)

recat = read_json("nsw_recat.json")
assert len(recat) == len(assessment["features"]), "recat/assessment length mismatch"
segments_changed = 0
for index, feature in enumerate(assessment["features"]):
    road_number = str((feature.get("properties") or {}).get("road_number") or "").strip()
    if road_number in changed and recat[index] != changed[road_number]["verdict"]:
        recat[index] = changed[road_number]["verdict"]
        segments_changed += 1
write_json("nsw_recat.json", recat)
log(f"  recat segments changed: {segments_changed}")

exports = read_json("export_rows.json")
rows_touched = 0
for row in exports["regional"]:
    road_number = str(row.get("Road ID") or "").strip()
    criterion = criteria.get(road_number)
    if not criterion or criterion["cls"] != "Regional":
        continue
    code = "R-06" if criterion["area"] == "urban" else "R-02"
    dest = criterion["opt"].get("dest") is True
    why_lines = []
    what_lines = []
    for line in row["Why"].split("\n"):
        if line.startswith(code):
            why_lines.append(f"{code}  {'met' if dest else 'not met'} (facilities / employment)")
        elif line.lstrip().startswith("→"):
            why_lines.append(f"→ {criterion['optMet']} optional met — {category(criterion['verdict'])}")
        else:
            why_lines.append(line)
    for line in row["What (criteria tested)"].split("\n"):
        if line.startswith(code):
            target = "Major Urban Centre or Major Town" if criterion["area"] == "urban" else "Town/Urban Centre"
            what_lines.append(
                f"{code}  {'PASS' if dest else 'fail'} — qualifying facility/employment centre connected to a {target}"
            )
        else:
            what_lines.append(line)
    new_why = "\n".join(why_lines)
    new_what = "\n".join(what_lines)
    if new_why != row["Why"] or new_what != row["What (criteria tested)"]:
        rows_touched += 1
    row["Why"] = new_why
    row["What (criteria tested)"] = new_what
    row["Categorisation"] = category(criterion["verdict"])
    row["_v"] = criterion["verdict"]
write_json("export_rows.json", exports)
log(f"  export Regional rows updated: {rows_touched}")

log("done.")
