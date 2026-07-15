# -*- coding: utf-8 -*-
"""
Rebuild the "Links two State Roads" Regional optional criterion.

The detail panel displayed ROAD_EXT.two_state as an optional Regional criterion,
but nsw_criteria.json did not count it in optMet. This script makes the data
consistent and also patches false negatives by deriving additional two-State
links from the road geometry:

  * group NSW assessment geometry by road_number
  * find topological endpoints of each Regional road
  * treat an endpoint within TOUCH_METERS of a State road as connected
  * pass the criterion when the road touches at least two distinct State roads

Existing true ROAD_EXT.two_state flags are preserved. The geometry pass only
promotes false/missing flags to true, which avoids removing prior positives
that may have come from a wider manual/topology process.

Written files:
  nsw_road_ext.json  - promoted two_state flags
  nsw_criteria.json  - opt.two_state, optMet, verdict
  nsw_recat.json     - per-segment verdicts consumed by the map
  export_rows.json   - Regional export rows, including the Two State line

Run with --apply to write. Without --apply this reports the impact only.
"""

import json
import math
import shutil
import sys
from collections import Counter
from pathlib import Path


APPLY = "--apply" in sys.argv
DATA = Path(__file__).resolve().parent / "data"
BAK = ".preTwoState.bak"
TOUCH_METERS = 20.0
ENDPOINT_PRECISION = 6


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


def lines_of_geometry(geom):
    if not geom:
        return []
    if geom.get("type") == "LineString":
        return [geom.get("coordinates") or []]
    if geom.get("type") == "MultiLineString":
        return geom.get("coordinates") or []
    return []


def line_bbox(line):
    xs = [pt[0] for pt in line]
    ys = [pt[1] for pt in line]
    return min(xs), min(ys), max(xs), max(ys)


def endpoint_key(pt):
    return f"{pt[0]:.{ENDPOINT_PRECISION}f},{pt[1]:.{ENDPOINT_PRECISION}f}"


def endpoint_candidates(lines):
    counts = Counter()
    reps = {}
    for line in lines:
        if len(line) < 2:
            continue
        for pt in (line[0], line[-1]):
            key = endpoint_key(pt)
            counts[key] += 1
            reps[key] = pt
    endpoints = [reps[key] for key, n in counts.items() if n == 1]
    return endpoints or list(reps.values())


def degree_pad(meters, lat):
    lat_rad = math.radians(lat)
    return (
        meters / (111_320.0 * max(math.cos(lat_rad), 0.01)),
        meters / 110_540.0,
    )


def point_segment_distance_m(pt, a, b):
    lat_rad = math.radians(pt[1])
    mx = 111_320.0 * max(math.cos(lat_rad), 0.01)
    my = 110_540.0
    ax = (a[0] - pt[0]) * mx
    ay = (a[1] - pt[1]) * my
    bx = (b[0] - pt[0]) * mx
    by = (b[1] - pt[1]) * my
    vx = bx - ax
    vy = by - ay
    denom = vx * vx + vy * vy
    t = (-(ax * vx + ay * vy) / denom) if denom else 0.0
    t = max(0.0, min(1.0, t))
    dx = ax + t * vx
    dy = ay + t * vy
    return math.hypot(dx, dy)


def nearest_state_roads(pt, state_lines):
    pad_x, pad_y = degree_pad(TOUCH_METERS, pt[1])
    out = {}
    for row in state_lines:
        min_x, min_y, max_x, max_y = row["bbox"]
        if (
            pt[0] < min_x - pad_x
            or pt[0] > max_x + pad_x
            or pt[1] < min_y - pad_y
            or pt[1] > max_y + pad_y
        ):
            continue
        best = None
        line = row["line"]
        for i in range(1, len(line)):
            dist = point_segment_distance_m(pt, line[i - 1], line[i])
            best = dist if best is None else min(best, dist)
            if best <= TOUCH_METERS:
                break
        if best is not None and best <= TOUCH_METERS:
            prior = out.get(row["rn"])
            if prior is None or best < prior["dist"]:
                out[row["rn"]] = {"rn": row["rn"], "name": row["name"], "dist": best}
    return out.values()


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


def update_why(text, two_state, opt_count, verdict):
    line = f"Two State  {'met' if two_state else 'not met'} (links two State Roads)"
    summary = {"green": "Meets criteria", "orange": "Likely meets (1 optional)", "red": "Does not meet"}
    lines = [
        existing
        for existing in text.split("\n")
        if not existing.startswith("Two State") and not existing.startswith("Links two State")
    ]
    inserted = False
    out = []
    for existing in lines:
        if existing.startswith("R-04") and not inserted:
            out.append(line)
            inserted = True
        if existing.lstrip().startswith("→"):
            out.append(f"→ {opt_count} optional met — {summary[verdict]}")
        else:
            out.append(existing)
    if not inserted:
        arrow_at = next((i for i, existing in enumerate(out) if existing.lstrip().startswith("→")), len(out))
        out.insert(arrow_at, line)
    return "\n".join(out)


def update_what(text, two_state):
    line = f"Two State  {'PASS' if two_state else 'fail'} — {'links two State Roads' if two_state else 'does not link two State Roads'}"
    lines = [
        existing
        for existing in text.split("\n")
        if not existing.startswith("Two State") and not existing.startswith("Links two State")
    ]
    inserted = False
    out = []
    for existing in lines:
        if existing.startswith("R-04") and not inserted:
            out.append(line)
            inserted = True
        out.append(existing)
    if not inserted:
        traffic_at = next((i for i, existing in enumerate(out) if existing.startswith("Traffic")), len(out))
        out.insert(traffic_at, line)
    return "\n".join(out)


assessment = read_json("nsw_assessment.geojson")
road_ext = read_json("nsw_road_ext.json")
crit = read_json("nsw_criteria.json")

roads = {}
for feature in assessment["features"]:
    props = feature.get("properties") or {}
    rn = str(props.get("road_number") or "").strip()
    if not rn:
        continue
    road = roads.setdefault(
        rn,
        {
            "rn": rn,
            "cls": props.get("admin_class"),
            "name": props.get("road_name") or "",
            "lines": [],
        },
    )
    for line in lines_of_geometry(feature.get("geometry")):
        if len(line) >= 2:
            road["lines"].append(line)

state_lines = []
for road in roads.values():
    if road["cls"] != "S":
        continue
    for line in road["lines"]:
        state_lines.append({"rn": road["rn"], "name": road["name"], "line": line, "bbox": line_bbox(line)})

computed = {}
for rn, road in roads.items():
    if road["cls"] != "R":
        continue
    touches = {}
    for pt in endpoint_candidates(road["lines"]):
        for state in nearest_state_roads(pt, state_lines):
            prior = touches.get(state["rn"])
            if prior is None or state["dist"] < prior["dist"]:
                touches[state["rn"]] = state
    computed[rn] = {
        "two_state": len(touches) >= 2,
        "touches": sorted(touches.values(), key=lambda row: row["rn"]),
    }

regional = {rn: c for rn, c in crit.items() if c["cls"] == "Regional"}
bad = [
    rn
    for rn, c in regional.items()
    if opt_met(c) != c["optMet"] or verdict_of(c, c["optMet"]) != c["verdict"]
]
if bad:
    log(f"VALIDATION GATE FAILED - {len(bad)} Regional roads do not reproduce: {bad[:10]}")
    sys.exit(1)
log(f"validation gate: verdict rule reproduces {len(regional)}/{len(regional)} Regional roads")

new_ext = {rn: dict(row) for rn, row in road_ext.items()}
flag_promotions = {}
preserved_existing_true = []
for rn, road in roads.items():
    if road["cls"] != "R":
        continue
    old_true = road_ext.get(rn, {}).get("two_state") is True
    computed_true = computed.get(rn, {}).get("two_state") is True
    final_true = old_true or computed_true
    new_ext.setdefault(rn, {})["two_state"] = final_true
    if computed_true and not old_true:
        flag_promotions[rn] = computed[rn]
    if old_true and not computed_true:
        preserved_existing_true.append(rn)

changed = {}
criteria_rows_touched = 0
target_count = 0
for rn, c in crit.items():
    if c["cls"] != "Regional" or c["area"] == "urban":
        continue
    target_count += 1
    two_state = new_ext.get(rn, {}).get("two_state") is True
    old_opt = c["opt"].get("two_state")
    new_opt = dict(c["opt"])
    new_opt["two_state"] = two_state
    new_opt_met = sum(1 for value in new_opt.values() if value is True)
    new_verdict = verdict_of(c, new_opt_met)
    if old_opt != two_state or c["optMet"] != new_opt_met or c["verdict"] != new_verdict:
        criteria_rows_touched += 1
    if c["optMet"] != new_opt_met or c["verdict"] != new_verdict:
        changed[rn] = {
            "two_state": two_state,
            "optMet": new_opt_met,
            "verdict": new_verdict,
            "oldOptMet": c["optMet"],
            "oldVerdict": c["verdict"],
        }

transitions = Counter((row["oldVerdict"], row["verdict"]) for row in changed.values())
two_state_true = sum(
    1
    for rn, c in crit.items()
    if c["cls"] == "Regional" and c["area"] != "urban" and new_ext.get(rn, {}).get("two_state") is True
)

log(f"rural/regional Regional roads checked: {target_count}")
log(f"two-State flags promoted from geometry: {len(flag_promotions)}")
log(f"existing true flags preserved without endpoint confirmation: {len(preserved_existing_true)}")
log(f"two-State optional passes after rebuild: {two_state_true}")
log(f"criteria rows touched: {criteria_rows_touched}")
log("verdict transitions: " + (", ".join(f"{a}->{b}: {n}" for (a, b), n in sorted(transitions.items())) or "none"))

if "0000268" in computed:
    state_ids = ", ".join(
        f"{row['rn']} ({round(row['dist'])}m)" for row in computed["0000268"]["touches"]
    )
    next_row = changed.get("0000268")
    if next_row:
        log(
            "Bungendore-Tarago: "
            f"two_state=True via {state_ids}; optMet {next_row['oldOptMet']}->{next_row['optMet']}, "
            f"verdict {next_row['oldVerdict']}->{next_row['verdict']}"
        )
    else:
        c = crit["0000268"]
        log(f"Bungendore-Tarago unchanged: two_state={new_ext['0000268']['two_state']}, optMet={c['optMet']}, verdict={c['verdict']}")

if flag_promotions:
    log("examples promoted from geometry:")
    for rn in list(flag_promotions)[:12]:
        road = roads.get(rn, {})
        states = ", ".join(row["rn"] for row in flag_promotions[rn]["touches"])
        log(f"  {rn} {road.get('name', '')}: {states}")

if not APPLY:
    log("dry run only - re-run with --apply to write. No files were changed.")
    sys.exit(0)

write_json("nsw_road_ext.json", new_ext)

for rn, c in crit.items():
    if c["cls"] != "Regional" or c["area"] == "urban":
        continue
    c["opt"]["two_state"] = new_ext.get(rn, {}).get("two_state") is True
    c["optMet"] = opt_met(c)
    c["verdict"] = verdict_of(c, c["optMet"])
write_json("nsw_criteria.json", crit)

recat = read_json("nsw_recat.json")
assert len(recat) == len(assessment["features"]), "recat/assessment length mismatch"
seg_changed = 0
for index, feature in enumerate(assessment["features"]):
    rn = str((feature.get("properties") or {}).get("road_number") or "").strip()
    if rn in changed and recat[index] != changed[rn]["verdict"]:
        recat[index] = changed[rn]["verdict"]
        seg_changed += 1
write_json("nsw_recat.json", recat)
log(f"  recat segments changed: {seg_changed}")

exp = read_json("export_rows.json")
cat = {"green": "Meets criteria", "orange": "Likely meets (1 optional)", "red": "Does not meet"}
target_ids = {
    rn for rn, c in crit.items()
    if c["cls"] == "Regional" and c["area"] != "urban"
}
rows_changed = 0
seen_ids = set()
for row in exp["regional"]:
    rn = str(row.get("Road ID", "")).strip()
    if rn not in target_ids:
        continue
    seen_ids.add(rn)
    c = crit[rn]
    two_state = c["opt"].get("two_state") is True
    old_payload = (row.get("Why"), row.get("What (criteria tested)"), row.get("Categorisation"), row.get("_v"))
    row["Why"] = update_why(row["Why"], two_state, c["optMet"], c["verdict"])
    row["What (criteria tested)"] = update_what(row["What (criteria tested)"], two_state)
    row["Categorisation"] = cat[c["verdict"]]
    row["_v"] = c["verdict"]
    new_payload = (row.get("Why"), row.get("What (criteria tested)"), row.get("Categorisation"), row.get("_v"))
    if old_payload != new_payload:
        rows_changed += 1

missing = sorted(target_ids - seen_ids)
assert not missing, f"missing regional export rows: {missing[:10]}"
for tab in ("natsig", "state"):
    assert not any(str(row.get("Road ID", "")).strip() in target_ids for row in exp[tab]), tab
write_json("export_rows.json", exp)
log(f"  export regional rows changed: {rows_changed}")

log("done.")
