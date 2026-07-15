# -*- coding: utf-8 -*-
"""
Rebuild the State long-distance rural route optional criterion.

The current TfNSW criteria guide lists this as an unnumbered State Road
optional criterion in Remote and Regional Areas:

  Connects from either a Metropolitan Centre, Regional City, Major Town or
  Major Urban Centre to Town Centres along a long-distance rural route.

That is more specific than "route length >= 25 km". This script keeps the
25 km long-distance threshold, but also requires named centre evidence:

  * a State-tier source centre (metro/regional city/major town/major urban)
  * a Town Centre destination
  * both on the same connected geometry component of at least 25 km

For current State roads, the result is written to opt.ldr and optMet/verdict
are rebuilt. Urban State roads have opt.ldr cleared because LDR is not in the
urban State criteria set. For Regional roads tested as State roads, the result
is written to stateOpt.ldr so the cross-test can score it without changing the
road's own Regional verdict.

Written files:
  nsw_criteria.json - opt.ldr for State roads, stateOpt.ldr for cross-tests
  nsw_recat.json    - per-segment verdicts for changed State roads
  export_rows.json  - State export rows and criteria summary text

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
BAK = ".preStateLdr.bak"
LDR_MIN_KM = 25.0
CONNECT_KM = 0.2

STATE_SOURCE_TYPES = {
    "Capital City",
    "Metropolitan Centre",
    "Regional City",
    "Major Town",
    "Major Urban Centre",
}


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


def dist_km(a, b):
    mid_lat = math.radians((a[1] + b[1]) / 2.0)
    dx = (a[0] - b[0]) * math.cos(mid_lat)
    dy = a[1] - b[1]
    return math.hypot(dx, dy) * 111.32


def line_length_km(coords):
    return sum(dist_km(coords[i - 1], coords[i]) for i in range(1, len(coords)))


def geometry_lines(geom):
    if not geom:
        return []
    if geom.get("type") == "LineString":
        return [geom.get("coordinates") or []]
    if geom.get("type") == "MultiLineString":
        return [line for line in (geom.get("coordinates") or []) if line]
    return []


def point_line_dist_km(point, line):
    if not line:
        return float("inf")
    return min(dist_km(point, coord) for coord in line)


def opt_met(c):
    return sum(1 for value in c["opt"].values() if value is True)


def verdict_of(c, optional_met):
    if c["cls"] == "Regional" and c["mand"].get("bdouble") is False:
        return "red"
    if c["cls"] == "State" and c["mand"].get("pbs1") is False:
        return "red"
    if optional_met >= 2:
        return "green"
    if optional_met == 1:
        return "orange"
    return "red"


def major_threshold(zone):
    return 5000 if zone == "remote" else 7000


def town_threshold(zone):
    return 1000 if zone == "remote" else 2000


def centre_roles(rn, centre, zones):
    ctype = centre.get("type")
    pop = centre.get("pop") or 0
    zone = zones.get(rn)
    source = ctype in STATE_SOURCE_TYPES or centre.get("big") is True
    town = ctype == "Town Centre"

    # Significant Urban Areas in the evidence table need population-tier
    # interpretation for this criterion.
    if ctype == "Significant Urban Area":
        if pop >= major_threshold(zone):
            source = True
        elif pop >= town_threshold(zone):
            town = True

    return source, town


def road_components(lines):
    if not lines:
        return []
    parent = list(range(len(lines)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    ends = [(line[0], line[-1]) for line in lines]
    for i in range(len(lines)):
        for j in range(i + 1, len(lines)):
            if min(dist_km(a, b) for a in ends[i] for b in ends[j]) <= CONNECT_KM:
                union(i, j)

    groups = defaultdict(list)
    for i in range(len(lines)):
        groups[find(i)].append(i)

    comps = []
    for ids in groups.values():
        comp_lines = [lines[i] for i in ids]
        comps.append({
            "lines": comp_lines,
            "km": sum(line_length_km(line) for line in comp_lines),
            "source": set(),
            "town": set(),
        })
    return sorted(comps, key=lambda c: c["km"], reverse=True)


def assign_centres_to_components(rn, comps, evidence_row, zones):
    centres = (evidence_row or {}).get("centres") or []
    for centre in centres:
        name = str(centre.get("name") or "").strip()
        if not name or centre.get("lon") is None or centre.get("lat") is None:
            continue
        source, town = centre_roles(rn, centre, zones)
        if not source and not town:
            continue
        point = [centre["lon"], centre["lat"]]
        best = None
        best_dist = float("inf")
        for comp in comps:
            comp_dist = min(point_line_dist_km(point, line) for line in comp["lines"])
            if comp_dist < best_dist:
                best = comp
                best_dist = comp_dist
        if best is None:
            continue
        if source:
            best["source"].add(name)
        if town:
            best["town"].add(name)


def evaluate_ldr(rn, lines, evidence_row, zones):
    comps = road_components(lines)
    total_km = sum(comp["km"] for comp in comps)
    assign_centres_to_components(rn, comps, evidence_row, zones)
    all_sources = sorted({name for comp in comps for name in comp["source"]})
    all_towns = sorted({name for comp in comps for name in comp["town"]})

    qualifying = [
        comp for comp in comps
        if comp["km"] >= LDR_MIN_KM and comp["source"] and comp["town"]
    ]
    best = qualifying[0] if qualifying else (comps[0] if comps else None)
    passed = bool(qualifying)

    info = {
        "ldr": passed,
        "ldr_km": round(total_km, 1),
        "ldr_component_km": round((best or {}).get("km", 0.0), 1),
        "ldr_source_centres": sorted((best or {}).get("source", [])),
        "ldr_town_centres": sorted((best or {}).get("town", [])),
        "ldr_all_source_centres": all_sources,
        "ldr_all_town_centres": all_towns,
        "ldr_component_count": len(comps),
    }
    return info


def state_export_summary(verdict):
    return {
        "green": "Meets criteria",
        "orange": "Likely meets (1 optional)",
        "red": "Does not meet",
    }[verdict]


def state_export_category(verdict):
    return {
        "green": "Meets criteria",
        "orange": "Likely meets (1 of 2 optional)",
        "red": "Does not meet",
    }[verdict]


def replace_or_insert_ldr(lines, prefix, ldr, insert_after_prefix):
    new_line = f"{prefix}  {'met' if ldr else 'not met'} (long-distance rural centre-to-town route)"
    out = []
    inserted = False
    replaced = False
    for line in lines:
        if line.startswith(prefix):
            out.append(new_line)
            inserted = True
            replaced = True
            continue
        out.append(line)
        if not inserted and line.startswith(insert_after_prefix):
            out.append(new_line)
            inserted = True
    if not inserted:
        out.append(new_line)
    return out, replaced or inserted


def replace_or_insert_ldr_what(lines, ldr, insert_after_prefix):
    new_line = (
        "LDR  "
        + ("PASS" if ldr else "fail")
        + " - unnumbered State long-distance rural centre-to-town route"
    )
    out = []
    inserted = False
    replaced = False
    for line in lines:
        if line.startswith("LDR"):
            out.append(new_line)
            inserted = True
            replaced = True
            continue
        out.append(line)
        if not inserted and line.startswith(insert_after_prefix):
            out.append(new_line)
            inserted = True
    if not inserted:
        out.append(new_line)
    return out, replaced or inserted


crit = read_json("nsw_criteria.json")
evid = read_json("nsw_evidence.json")
zones = read_json("nsw_zone.json")
assessment = read_json("nsw_assessment.geojson")

bad = [
    rn for rn, c in crit.items()
    if opt_met(c) != c["optMet"] or verdict_of(c, c["optMet"]) != c["verdict"]
]
if bad:
    log(f"VALIDATION GATE FAILED - {len(bad)} roads do not reproduce: {bad[:10]}")
    sys.exit(1)
log(f"validation gate: verdict rule reproduces {len(crit)}/{len(crit)} roads")

road_lines = defaultdict(list)
road_names = defaultdict(set)
for feature in assessment["features"]:
    props = feature.get("properties") or {}
    rn = str(props.get("road_number") or "").strip()
    if not rn:
        continue
    for line in geometry_lines(feature.get("geometry")):
        if len(line) >= 2:
            road_lines[rn].append(line)
    if props.get("road_name"):
        road_names[rn].add(str(props["road_name"]))

derived = {
    rn: evaluate_ldr(rn, road_lines.get(rn, []), evid.get(rn), zones)
    for rn in crit
    if crit[rn]["area"] != "urban"
}

state_changed = {}
state_info_changed = {}
regional_cross_changed = {}

for rn, c in crit.items():
    if c["area"] == "urban":
        if c["cls"] == "State" and c["opt"].get("ldr") is not None:
            new_opt = dict(c["opt"])
            new_opt["ldr"] = None
            new_opt_met = sum(1 for value in new_opt.values() if value is True)
            new_verdict = verdict_of(c, new_opt_met)
            state_changed[rn] = {
                "oldLdr": c["opt"].get("ldr"),
                "ldr": None,
                "oldOptMet": c["optMet"],
                "optMet": new_opt_met,
                "oldVerdict": c["verdict"],
                "verdict": new_verdict,
                "info": None,
            }
        continue
    info = derived[rn]
    old_state_opt = c.get("stateOpt") or {}
    if any(old_state_opt.get(key) != value for key, value in info.items()):
        if c["cls"] == "Regional":
            regional_cross_changed[rn] = info
        else:
            state_info_changed[rn] = info

    if c["cls"] != "State":
        continue
    old_ldr = c["opt"].get("ldr")
    new_ldr = info["ldr"]
    new_opt = dict(c["opt"])
    new_opt["ldr"] = new_ldr
    new_opt_met = sum(1 for value in new_opt.values() if value is True)
    new_verdict = verdict_of(c, new_opt_met)
    if old_ldr != new_ldr or c["optMet"] != new_opt_met or c["verdict"] != new_verdict:
        state_changed[rn] = {
            "oldLdr": old_ldr,
            "ldr": new_ldr,
            "oldOptMet": c["optMet"],
            "optMet": new_opt_met,
            "oldVerdict": c["verdict"],
            "verdict": new_verdict,
            "info": info,
        }

state_flips = Counter((row["oldLdr"], row["ldr"]) for row in state_changed.values())
state_transitions = Counter((row["oldVerdict"], row["verdict"]) for row in state_changed.values())
cross_flips = Counter((crit[rn].get("stateOpt") or {}).get("ldr") != row["ldr"] for rn, row in regional_cross_changed.items())


def split(pred):
    old = Counter(c["verdict"] for rn, c in crit.items() if pred(rn, c))
    new = Counter(
        state_changed[rn]["verdict"] if rn in state_changed else c["verdict"]
        for rn, c in crit.items()
        if pred(rn, c)
    )
    return old, new


def fmt(counter):
    return f"{counter['green']}/{counter['orange']}/{counter['red']} (g/o/r)"


all_old, all_new = split(lambda _rn, _c: True)
state_old, state_new = split(lambda _rn, c: c["cls"] == "State")
nonurban_state_old, nonurban_state_new = split(lambda _rn, c: c["cls"] == "State" and c["area"] != "urban")

log(f"non-urban State roads checked: {sum(1 for c in crit.values() if c['cls'] == 'State' and c['area'] != 'urban')}")
log(f"urban State roads with non-applicable LDR cleared: {sum(1 for rn, row in state_changed.items() if crit[rn]['area'] == 'urban')}")
log(f"non-urban Regional cross-test roads checked: {sum(1 for c in crit.values() if c['cls'] == 'Regional' and c['area'] != 'urban')}")
log(f"State opt.ldr changes: {len(state_changed)}")
log("State LDR flips: " + (", ".join(f"{a}->{b}: {n}" for (a, b), n in sorted(state_flips.items(), key=lambda item: str(item[0]))) or "none"))
log("State verdict transitions: " + (", ".join(f"{a}->{b}: {n}" for (a, b), n in sorted(state_transitions.items())) or "none"))
log(f"Regional stateOpt rows with updated metadata/value: {len(regional_cross_changed)} (value flips={cross_flips[True]})")
log(f"named-road split:          {fmt(all_old)} -> {fmt(all_new)}")
log(f"State-only split:          {fmt(state_old)} -> {fmt(state_new)}")
log(f"non-urban State split:     {fmt(nonurban_state_old)} -> {fmt(nonurban_state_new)}")

for rn in ("0000105", "0000208"):
    if rn in derived:
        info = derived[rn]
        label = " / ".join(sorted(road_names.get(rn, [])))
        log(
            f"{rn} {label}: LDR={info['ldr']} total={info['ldr_km']} km "
            f"component={info['ldr_component_km']} km source={info['ldr_source_centres']} "
            f"town={info['ldr_town_centres']} components={info['ldr_component_count']}"
        )

if not APPLY:
    log("dry run only - re-run with --apply to write. No files were changed.")
    sys.exit(0)

for rn, row in state_changed.items():
    c = crit[rn]
    c["opt"]["ldr"] = row["ldr"]
    c["optMet"] = row["optMet"]
    c["verdict"] = row["verdict"]

for rn, info in derived.items():
    if crit[rn]["cls"] in {"State", "Regional"}:
        crit[rn]["stateOpt"] = dict(crit[rn].get("stateOpt") or {})
        crit[rn]["stateOpt"].update(info)

write_json("nsw_criteria.json", crit)

recat = read_json("nsw_recat.json")
assert len(recat) == len(assessment["features"]), "recat/assessment length mismatch"
seg_changed = 0
for index, feature in enumerate(assessment["features"]):
    rn = str(feature["properties"].get("road_number") or "").strip()
    if rn in state_changed and recat[index] != state_changed[rn]["verdict"]:
        recat[index] = state_changed[rn]["verdict"]
        seg_changed += 1
write_json("nsw_recat.json", recat)
log(f"  recat segments changed: {seg_changed}")

exp = read_json("export_rows.json")
rows_changed = 0
state_rows = {str(row.get("Road ID", "")).strip(): row for row in exp["state"]}
state_export_targets = {
    rn for rn, c in crit.items()
    if c["cls"] == "State" and rn in state_rows and (c["area"] != "urban" or rn in state_changed)
}
for rn in state_export_targets:
    c = crit[rn]
    row = state_rows[rn]
    ldr = c["opt"].get("ldr") is True
    if c["area"] != "urban":
        why_lines, why_ok = replace_or_insert_ldr(row["Why"].split("\n"), "LDR", ldr, "S-07")
        what_lines, what_ok = replace_or_insert_ldr_what(row["What (criteria tested)"].split("\n"), ldr, "S-07")
    else:
        why_lines, why_ok = row["Why"].split("\n"), False
        what_lines, what_ok = row["What (criteria tested)"].split("\n"), False
    for i, line in enumerate(why_lines):
        if line.lstrip().startswith("->") or line.lstrip().startswith("\u2192"):
            why_lines[i] = f"\u2192 {c['optMet']} optional met - {state_export_summary(c['verdict'])}"
    row["Why"] = "\n".join(why_lines)
    row["What (criteria tested)"] = "\n".join(what_lines)
    row["Categorisation"] = state_export_category(c["verdict"])
    row["_v"] = c["verdict"]
    rows_changed += 1 if (why_ok or what_ok) else 0

write_json("export_rows.json", exp)
log(f"  export state rows touched: {rows_changed}")

log("done.")
