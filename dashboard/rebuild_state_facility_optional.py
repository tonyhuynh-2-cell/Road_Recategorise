#!/usr/bin/env python3
"""Evaluate State facility connectivity (S-08/S-11) from road topology."""

from __future__ import annotations

import argparse
import json
import os
import shutil
from collections import Counter
from pathlib import Path

import geopandas as gpd
from pyproj import Transformer
from shapely.geometry import Point

from network_connectivity import (
    CENTRE_CONNECT_M,
    PROJECTED_CRS,
    centre_roles,
    load_abs_centres,
    load_or_build_corridor_matches,
    prepare_routes,
    road_components,
    route_coverage,
)


DASHBOARD = Path(__file__).resolve().parent
DATA = DASHBOARD / "data"
DEFAULT_RAW = Path.home() / "Desktop" / "IPWEA" / "data" / "raw"
MINIMUM_COVERAGE = 0.70
FACILITY_CONNECT_M = 3_000.0
EMPLOYMENT_NETWORK_TOLERANCE_M = 50.0
STATE_DEST_TYPES = {"International Airport", "Major Intermodal", "Major Port"}
EMPLOYMENT_AREA_HA = {"remote": 5.0, "regional": 15.0, "urban": 40.0}
TO_PROJECTED = Transformer.from_crs("EPSG:4326", PROJECTED_CRS, always_xy=True)


def read_json(path: Path):
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, value) -> None:
    backup = path.with_name(path.name + ".preNetworkS08.bak")
    if not backup.exists():
        shutil.copyfile(path, backup)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False)


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


def current_state_dest(criteria: dict) -> bool | None:
    if criteria["cls"] == "State":
        return criteria["opt"].get("dest")
    value = (criteria.get("stateOpt") or {}).get("dest")
    return value if isinstance(value, bool) else criteria["opt"].get("dest")


def assign_centres(component: dict, centres, zone: str) -> None:
    indexes = centres.sindex.query(
        component["geometry"].buffer(CENTRE_CONNECT_M),
        predicate="intersects",
    )
    names = set()
    for index in indexes:
        centre = centres.iloc[index]
        source, town = centre_roles(
            str(centre["kind"]),
            int(centre["population"]),
            zone,
        )
        if source or town:
            names.add(str(centre["name"]))
    component["centre_names"] = names


def facility_candidates(evidence: dict, zone: str) -> list[dict]:
    candidates = []
    for item in evidence.get("hospitals", []):
        candidates.append({**item, "facility_kind": "hospital"})
    for item in evidence.get("dests", []):
        if item.get("ftype") in STATE_DEST_TYPES:
            candidates.append({**item, "facility_kind": "destination"})
    minimum_hectares = EMPLOYMENT_AREA_HA.get(zone, 15.0)
    for item in evidence.get("employment", []):
        if (
            item.get("relation") == "intersects"
            and float(item.get("ha") or 0.0) >= minimum_hectares
        ):
            candidates.append({**item, "facility_kind": "employment"})
    return candidates


def assign_facilities(
    components: list[dict],
    evidence: dict,
    zone: str,
    employment_geometries: dict[str, object] | None = None,
) -> None:
    for component in components:
        component["facilities"] = {}
    for item in facility_candidates(evidence, zone):
        geometry = None
        if item["facility_kind"] == "employment" and employment_geometries:
            geometry = employment_geometries.get(str(item.get("zoneId") or ""))
        if geometry is None:
            if item.get("lon") is None or item.get("lat") is None:
                continue
            x, y = TO_PROJECTED.transform(float(item["lon"]), float(item["lat"]))
            geometry = Point(x, y)
        distances = [geometry.distance(component["geometry"]) for component in components]
        if not distances:
            continue
        component_index = min(range(len(distances)), key=distances.__getitem__)
        maximum_distance = (
            EMPLOYMENT_NETWORK_TOLERANCE_M
            if item["facility_kind"] == "employment"
            else FACILITY_CONNECT_M
        )
        if distances[component_index] > maximum_distance:
            continue
        name = str(item.get("name") or "Facility")
        lga = str(item.get("lga") or "").strip().title()
        display_name = f"{name} ({lga})" if lga and item["facility_kind"] == "employment" else name
        key = (str(item.get("zoneId") or display_name), item["facility_kind"])
        components[component_index]["facilities"][key] = {
            "name": display_name,
            "kind": item["facility_kind"],
            "distance_km": round(distances[component_index] / 1000.0, 2),
            "ha": item.get("ha"),
            "tier": item.get("tier"),
            "type": item.get("ftype") or item.get("cat") or item.get("kind"),
            "zone_id": item.get("zoneId"),
        }


def prepare_sections(path: Path, road_ids: set[str]) -> dict[str, list[dict]]:
    assessment = gpd.read_file(path)
    assessment["road_number"] = assessment["road_number"].astype(str).str.strip()
    assessment = assessment[assessment["road_number"].isin(road_ids)].to_crs(PROJECTED_CRS)
    sections = {road_number: [] for road_number in road_ids}
    for row in assessment.itertuples():
        name = str(getattr(row, "road_name", "") or "").strip()
        if name and row.geometry is not None and not row.geometry.is_empty:
            sections[row.road_number].append({"name": name, "geometry": row.geometry})
    return sections


def assign_section_names(components: list[dict], sections: list[dict]) -> None:
    for component in components:
        component["road_names"] = set()
    for section in sections:
        distances = [section["geometry"].distance(component["geometry"]) for component in components]
        if distances:
            components[min(range(len(distances)), key=distances.__getitem__)]["road_names"].add(
                section["name"]
            )


def evaluate_state_dest(
    route_geometry,
    segments,
    centres,
    evidence: dict,
    zone: str,
    sections: list[dict],
    employment_geometries: dict[str, object] | None = None,
) -> dict:
    components = road_components(segments)
    assign_section_names(components, sections)
    for component in components:
        assign_centres(component, centres, zone)
    assign_facilities(components, evidence or {}, zone, employment_geometries)

    qualifying = [
        component
        for component in components
        if component["centre_names"] and component["facilities"]
    ]
    best = qualifying[0] if qualifying else (components[0] if components else None)
    coverage = route_coverage(route_geometry, segments)
    assessed = coverage >= MINIMUM_COVERAGE
    value = bool(qualifying) if assessed else None
    best_facilities = list((best or {}).get("facilities", {}).values())
    best_facility_kinds = {detail["kind"] for detail in best_facilities}
    all_centres = sorted(
        {name for component in components for name in component["centre_names"]}
    )
    all_facilities = sorted(
        {
            detail["name"]
            for component in components
            for detail in component["facilities"].values()
        }
    )
    component_details = []
    for component in qualifying:
        facilities = sorted(
            component["facilities"].values(),
            key=lambda item: (item["name"], item["kind"]),
        )
        kinds = {detail["kind"] for detail in facilities}
        component_details.append(
            {
                "component_km": round(float(component["km"]), 1),
                "road_names": sorted(component["road_names"]),
                "centre_names": sorted(component["centre_names"]),
                "facility_names": sorted(detail["name"] for detail in facilities),
                "facility_details": facilities,
                "employment_only": kinds == {"employment"},
            }
        )

    return {
        "dest": value,
        "assessed": assessed,
        "coverage": round(coverage, 3),
        "route_km": round(float(route_geometry.length / 1000.0), 1),
        "matched_segment_count": int(len(segments)),
        "matched_km": round(float(segments.geometry.length.sum() / 1000.0), 1),
        "component_km": round(float((best or {}).get("km", 0.0)), 1),
        "component_count": len(components),
        "centre_names": sorted((best or {}).get("centre_names", [])),
        "facility_names": sorted(detail["name"] for detail in best_facilities),
        "facility_details": sorted(best_facilities, key=lambda item: (item["name"], item["kind"])),
        "all_centre_names": all_centres,
        "all_facility_names": all_facilities,
        "qualifying_components": component_details,
        "employment_area_proxy": any(
            detail["kind"] == "employment" for detail in best_facilities
        ),
        "employment_only": best_facility_kinds == {"employment"},
        "economic_value_assessed": False,
    }


def state_metadata(result: dict) -> dict:
    return {
        "dest": result["dest"],
        "dest_component_km": result["component_km"],
        "dest_centre_names": result["centre_names"],
        "dest_facility_names": result["facility_names"],
        "dest_facility_details": result["facility_details"],
        "dest_all_centre_names": result["all_centre_names"],
        "dest_all_facility_names": result["all_facility_names"],
        "dest_qualifying_components": result["qualifying_components"],
        "dest_component_count": result["component_count"],
        "dest_method": "nsw_road_segment_network",
        "dest_network_coverage": result["coverage"],
        "dest_network_segment_count": result["matched_segment_count"],
        "dest_network_km": result["matched_km"],
        "dest_employment_area_proxy": result["employment_area_proxy"],
        "dest_employment_only": result["employment_only"],
        "dest_economic_value_assessed": result["economic_value_assessed"],
    }


def category(verdict: str) -> str:
    return {
        "green": "Meets criteria",
        "orange": "Likely meets (1 optional)",
        "red": "Does not meet",
    }[verdict]


def update_export_lines(row: dict, criteria: dict, passed: bool) -> None:
    why_replacement = f"S-08  {'met' if passed else 'not met'} (facility-to-centre connection)"
    what_replacement = (
        f"S-08  {'PASS' if passed else 'fail'} - qualifying facility/employment area "
        "connected to another centre type"
    )
    why_lines = []
    for line in row["Why"].split("\n"):
        if line.startswith("S-08"):
            why_lines.append(why_replacement)
        elif line.lstrip().startswith(("->", "\u2192")):
            why_lines.append(
                f"-> {criteria['optMet']} optional met - {category(criteria['verdict'])}"
            )
        else:
            why_lines.append(line)
    what_lines = [
        what_replacement if line.startswith("S-08") else line
        for line in row["What (criteria tested)"].split("\n")
    ]
    row["Why"] = "\n".join(why_lines)
    row["What (criteria tested)"] = "\n".join(what_lines)
    row["Categorisation"] = {
        "green": "Meets criteria",
        "orange": "Likely meets (1 of 2 optional)",
        "red": "Does not meet",
    }[criteria["verdict"]]
    row["_v"] = criteria["verdict"]


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
        row = criteria[road_number]
        row["stateOpt"] = dict(row.get("stateOpt") or {})
        row["stateOpt"].update(state_metadata(result))
        if row["cls"] != "State" or result["dest"] is None:
            continue
        old_dest = row["opt"].get("dest")
        old_verdict = row["verdict"]
        row["opt"]["dest"] = result["dest"]
        row["optMet"] = optional_met(row)
        row["verdict"] = verdict_of(row, row["optMet"])
        if old_dest != result["dest"] or old_verdict != row["verdict"]:
            state_changes[road_number] = {
                "old_dest": old_dest,
                "dest": result["dest"],
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
        if road_number not in results or results[road_number]["dest"] is None:
            continue
        update_export_lines(
            row,
            criteria[road_number],
            results[road_number]["dest"] is True,
        )
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
    for required in (road_segments, cache):
        if not required.exists():
            raise FileNotFoundError(required)

    criteria = read_json(DATA / "nsw_criteria.json")
    evidence = read_json(DATA / "nsw_evidence.json")
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
    sections = prepare_sections(DATA / "nsw_assessment.geojson", target_ids)
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
        result = evaluate_state_dest(
            route.geometry,
            matches_by_road.get(road_number, empty_matches),
            centres,
            evidence.get(road_number, {}),
            zones.get(road_number, "regional"),
            sections.get(road_number, []),
        )
        result.update(
            {
                "old_dest": current_state_dest(criteria[road_number]),
                "classification": criteria[road_number]["cls"],
                "area": criteria[road_number]["area"],
                "zone": zones.get(road_number, "regional"),
                "road_names": route.road_names,
            }
        )
        results[road_number] = result

    flips = Counter()
    state_transitions = Counter()
    unresolved = 0
    for road_number, result in results.items():
        old = current_state_dest(criteria[road_number])
        new = result["dest"]
        if new is None:
            unresolved += 1
            continue
        if old != new:
            flips[f"{old}->{new}"] += 1
        row = criteria[road_number]
        if row["cls"] == "State":
            new_count = row["optMet"] - (row["opt"].get("dest") is True) + (new is True)
            new_verdict = verdict_of(row, new_count)
            if row["verdict"] != new_verdict:
                state_transitions[f"{row['verdict']}->{new_verdict}"] += 1

    report = {
        "method": {
            "criterion": "S-08",
            "road_source": "NSW Transport Theme GDA2020 RoadSegment",
            "centre_source": "ABS ASGS 2021 UCL/SUA with 2021 Census G01 population",
            "facility_source": "dashboard/data/nsw_evidence.json",
            "minimum_network_coverage": MINIMUM_COVERAGE,
            "centre_network_tolerance_m": CENTRE_CONNECT_M,
            "facility_network_tolerance_m": FACILITY_CONNECT_M,
            "employment_area_hectares": EMPLOYMENT_AREA_HA,
            "employment_economic_value_available": False,
        },
        "summary": {
            "roads": len(results),
            "assessed": len(results) - unresolved,
            "unresolved": unresolved,
            "score_flips": dict(sorted(flips.items())),
            "state_verdict_transitions": dict(sorted(state_transitions.items())),
        },
        "roads": dict(sorted(results.items())),
    }

    print(json.dumps(report["summary"], indent=2), flush=True)
    if "0000057" in results:
        print("0000057", json.dumps(results["0000057"], indent=2), flush=True)

    state_changes = apply_results(criteria, results) if args.apply else {}
    report["summary"]["state_changes_applied"] = len(state_changes)
    report["state_changes"] = state_changes

    if args.write_report or args.apply:
        output = DATA / "network_state_facility_comparison.json"
        with output.open("w", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
        print(f"wrote {output}", flush=True)
    else:
        print("dry run only; use --write-report to save the comparison", flush=True)


if __name__ == "__main__":
    main()
