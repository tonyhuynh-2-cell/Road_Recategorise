#!/usr/bin/env python3
"""Compare the current LDR result with NSW Road Segment topology and ABS centres."""

from __future__ import annotations

import argparse
import json
import os
import shutil
from collections import Counter
from pathlib import Path

from network_connectivity import (
    evaluate_route_ldr,
    load_abs_centres,
    load_or_build_corridor_matches,
    prepare_routes,
)


DASHBOARD = Path(__file__).resolve().parent
DATA = DASHBOARD / "data"
DEFAULT_RAW = Path.home() / "Desktop" / "IPWEA" / "data" / "raw"


def read_json(path: Path):
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def current_ldr(criteria: dict) -> bool | None:
    if criteria["cls"] == "State":
        return criteria["opt"].get("ldr")
    return (criteria.get("stateOpt") or {}).get("ldr")


def optional_met(criteria: dict) -> int:
    return sum(value is True for value in criteria["opt"].values())


def verdict_of(criteria: dict, count: int) -> str:
    if criteria["cls"] == "Regional" and criteria["mand"].get("bdouble") is False:
        return "red"
    if criteria["cls"] == "State" and criteria["mand"].get("pbs1") is False:
        return "red"
    if count >= 2:
        return "green"
    if count == 1:
        return "orange"
    return "red"


def write_json(path: Path, value) -> None:
    backup = path.with_name(path.name + ".preNetworkLdr.bak")
    if not backup.exists():
        shutil.copyfile(path, backup)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False)


def network_metadata(result: dict) -> dict:
    return {
        "ldr": result["ldr"],
        "ldr_km": result["route_km"],
        "ldr_component_km": result["component_km"],
        "ldr_source_centres": result["source_centres"],
        "ldr_town_centres": result["town_centres"],
        "ldr_all_source_centres": result["all_source_centres"],
        "ldr_all_town_centres": result["all_town_centres"],
        "ldr_component_count": result["component_count"],
        "ldr_method": "nsw_road_segment_network",
        "ldr_network_coverage": result["coverage"],
        "ldr_network_segment_count": result["matched_segment_count"],
        "ldr_network_km": result["matched_km"],
    }


def replace_ldr_line(lines: list[str], prefix: str, passed: bool, after: str) -> list[str]:
    replacement = f"{prefix}  {'met' if passed else 'not met'} (long-distance rural centre-to-town route)"
    output = []
    inserted = False
    for line in lines:
        if line.startswith(prefix):
            output.append(replacement)
            inserted = True
            continue
        output.append(line)
        if not inserted and line.startswith(after):
            output.append(replacement)
            inserted = True
    if not inserted:
        output.append(replacement)
    return output


def replace_ldr_test_line(lines: list[str], passed: bool) -> list[str]:
    replacement = (
        f"LDR  {'PASS' if passed else 'fail'} - "
        "unnumbered State long-distance rural centre-to-town route"
    )
    output = []
    inserted = False
    for line in lines:
        if line.startswith("LDR"):
            output.append(replacement)
            inserted = True
            continue
        output.append(line)
        if not inserted and line.startswith("S-07"):
            output.append(replacement)
            inserted = True
    if not inserted:
        output.append(replacement)
    return output


def apply_results(criteria: dict, results: dict) -> dict:
    baseline_errors = [
        road_number
        for road_number, row in criteria.items()
        if optional_met(row) != row["optMet"]
        or verdict_of(row, row["optMet"]) != row["verdict"]
    ]
    if baseline_errors:
        raise RuntimeError(f"Criteria validation failed before apply: {baseline_errors[:10]}")

    state_changes = {}
    for road_number, result in results.items():
        if result["ldr"] is None:
            continue
        row = criteria[road_number]
        old_ldr = current_ldr(row)
        row["stateOpt"] = dict(row.get("stateOpt") or {})
        row["stateOpt"].update(network_metadata(result))
        if row["cls"] != "State":
            continue
        row["opt"]["ldr"] = result["ldr"]
        row["optMet"] = optional_met(row)
        old_verdict = row["verdict"]
        row["verdict"] = verdict_of(row, row["optMet"])
        if old_ldr != result["ldr"] or old_verdict != row["verdict"]:
            state_changes[road_number] = {
                "old_ldr": old_ldr,
                "ldr": result["ldr"],
                "old_verdict": old_verdict,
                "verdict": row["verdict"],
            }

    write_json(DATA / "nsw_criteria.json", criteria)

    assessment = read_json(DATA / "nsw_assessment.geojson")
    recategorisation = read_json(DATA / "nsw_recat.json")
    if len(assessment["features"]) != len(recategorisation):
        raise RuntimeError("Assessment and recategorisation lengths differ")
    for index, feature in enumerate(assessment["features"]):
        road_number = str(feature["properties"].get("road_number") or "").strip()
        if road_number in state_changes:
            recategorisation[index] = state_changes[road_number]["verdict"]
    write_json(DATA / "nsw_recat.json", recategorisation)

    exports = read_json(DATA / "export_rows.json")
    for row in exports["state"]:
        road_number = str(row.get("Road ID") or "").strip()
        if road_number not in results or results[road_number]["ldr"] is None:
            continue
        criteria_row = criteria[road_number]
        passed = results[road_number]["ldr"] is True
        row["Why"] = "\n".join(
            replace_ldr_line(row["Why"].split("\n"), "LDR", passed, "S-07")
        )
        row["What (criteria tested)"] = "\n".join(
            replace_ldr_test_line(row["What (criteria tested)"].split("\n"), passed)
        )
        why_lines = row["Why"].split("\n")
        for index, line in enumerate(why_lines):
            if line.lstrip().startswith(("->", "\u2192")):
                why_lines[index] = (
                    f"-> {criteria_row['optMet']} optional met - "
                    + {
                        "green": "Meets criteria",
                        "orange": "Likely meets (1 optional)",
                        "red": "Does not meet",
                    }[criteria_row["verdict"]]
                )
        row["Why"] = "\n".join(why_lines)
        row["Categorisation"] = {
            "green": "Meets criteria",
            "orange": "Likely meets (1 of 2 optional)",
            "red": "Does not meet",
        }[criteria_row["verdict"]]
        row["_v"] = criteria_row["verdict"]
    write_json(DATA / "export_rows.json", exports)
    return state_changes


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-dir", type=Path)
    parser.add_argument("--rebuild-cache", action="store_true")
    parser.add_argument("--road-id", action="append", default=[])
    parser.add_argument("--write-report", action="store_true")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    raw_dir = args.raw_dir or Path(os.environ.get("ROAD_RECAT_RAW_DATA", DEFAULT_RAW))
    road_segments = raw_dir / "nsw_road_segments_gda2020" / "nsw_road_segments.gpkg"
    cache = raw_dir / "derived" / "road_corridor_matches.gpkg"
    for required in (raw_dir, road_segments):
        if not required.exists():
            raise FileNotFoundError(required)

    criteria = read_json(DATA / "nsw_criteria.json")
    zones = read_json(DATA / "nsw_zone.json")
    target_ids = {
        road_number
        for road_number, row in criteria.items()
        if row["area"] != "urban"
    }
    if args.road_id:
        target_ids &= set(args.road_id)
    if not target_ids:
        raise RuntimeError("No matching non-urban roads were selected")

    routes = prepare_routes(DATA / "nsw_assessment.geojson", target_ids)
    centres = load_abs_centres(raw_dir)
    matches = load_or_build_corridor_matches(
        road_segments,
        routes,
        cache,
        rebuild=args.rebuild_cache,
    )
    matches["road_number"] = matches["road_number"].astype(str)
    matches_by_road = {
        road_number: group.copy()
        for road_number, group in matches.groupby("road_number", sort=False)
    }
    empty_matches = matches.iloc[0:0].copy()

    results = {}
    for road_number, route in routes.iterrows():
        route_matches = matches_by_road.get(road_number, empty_matches)
        result = evaluate_route_ldr(
            route.geometry,
            route_matches,
            centres,
            zones.get(road_number, "regional"),
        )
        result.update(
            {
                "old_ldr": current_ldr(criteria[road_number]),
                "classification": criteria[road_number]["cls"],
                "area": criteria[road_number]["area"],
                "zone": zones.get(road_number, "regional"),
                "road_names": route.road_names,
            }
        )
        results[road_number] = result

    flips = Counter()
    unresolved = 0
    for road_number, result in results.items():
        old = current_ldr(criteria[road_number])
        new = result["ldr"]
        if new is None:
            unresolved += 1
        elif old != new:
            flips[f"{old}->{new}"] += 1

    report = {
        "method": {
            "road_source": "NSW Transport Theme GDA2020 RoadSegment",
            "centre_source": "ABS ASGS 2021 UCL/SUA with 2021 Census G01 population",
            "minimum_coverage": 0.70,
            "minimum_component_km": 25.0,
        },
        "summary": {
            "roads": len(results),
            "assessed": len(results) - unresolved,
            "unresolved": unresolved,
            "flips": dict(sorted(flips.items())),
        },
        "roads": dict(sorted(results.items())),
    }

    print(json.dumps(report["summary"], indent=2), flush=True)
    for road_number in ("0000057", "0000105", "0000208"):
        if road_number in results:
            print(road_number, json.dumps(results[road_number], indent=2), flush=True)

    state_changes = apply_results(criteria, results) if args.apply else {}
    report["summary"]["state_changes_applied"] = len(state_changes)
    report["state_changes"] = state_changes

    if args.write_report or args.apply:
        output = DATA / "network_ldr_comparison.json"
        with output.open("w", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
        print(f"wrote {output}", flush=True)
    else:
        print("dry run only; use --write-report to save the comparison", flush=True)


if __name__ == "__main__":
    main()
