#!/usr/bin/env python3
"""Rebuild R-04 from the current official NHVR 19 m B-double network.

The former import assigned access to an entire source feature when any part of
that feature touched the NHVR network. Some source features are several
kilometres long, so a crossing or endpoint touch could incorrectly approve a
whole road. This rebuild measures the length that follows the network instead.

The script is a dry run unless ``--apply`` is supplied. After applying it, run
``rebuild_road_units.py --apply`` so connected assessment units inherit the
fractional segment coverage.
"""

from __future__ import annotations

import argparse
import copy
import json
from collections import Counter, defaultdict
from pathlib import Path

import geopandas as gpd
from shapely import STRtree, union_all


DASHBOARD = Path(__file__).resolve().parent
DATA = DASHBOARD / "data"
DEFAULT_NETWORK = DATA / "geopackages" / "nhvr_hvn_11240521.gpkg"
NETWORK_LAYER = "hvn_road_segments"
PROJECTED_CRS = "EPSG:3577"
DEFAULT_TOLERANCE_M = 50.0
ACCESS_THRESHOLD = 0.80


def read_json(name: str):
    with (DATA / name).open(encoding="utf-8") as handle:
        return json.load(handle)


def write_json(name: str, value, *, indent=None) -> None:
    with (DATA / name).open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=indent)


def approved_network(path: Path) -> gpd.GeoDataFrame:
    network = gpd.read_file(path, layer=NETWORK_LAYER)
    approved = network[
        network["access_code"].astype(str).str.contains("Approved", case=False, na=False)
    ].copy()
    if approved.empty:
        raise RuntimeError(f"No approved NHVR road segments found in {path}")
    return approved[["network_name", "access_description", "geometry"]]


def route_coverage(
    roads: gpd.GeoDataFrame,
    network: gpd.GeoDataFrame,
    tolerance_m: float = DEFAULT_TOLERANCE_M,
) -> list[float]:
    """Return the fraction of each road geometry following the NHVR network."""
    projected_roads = roads.to_crs(PROJECTED_CRS)
    projected_network = network.to_crs(PROJECTED_CRS)
    network_geometries = projected_network.geometry.to_numpy()
    tree = STRtree(network_geometries)
    coverage = []

    for geometry in projected_roads.geometry:
        if geometry is None or geometry.is_empty or geometry.length == 0:
            coverage.append(0.0)
            continue
        search_area = geometry.buffer(tolerance_m)
        indexes = tree.query(search_area, predicate="intersects")
        if not len(indexes):
            coverage.append(0.0)
            continue
        nearby = union_all(network_geometries.take(indexes))
        approved_area = nearby.buffer(tolerance_m)
        covered_m = geometry.intersection(approved_area).length
        coverage.append(min(1.0, max(0.0, covered_m / geometry.length)))
    return coverage


def optional_count(criteria: dict) -> int:
    return sum(value is True for value in criteria.get("opt", {}).values())


def verdict_of(criteria: dict) -> str:
    if criteria.get("cls") == "State" and criteria.get("mand", {}).get("pbs1") is False:
        return "red"
    if criteria.get("cls") == "Regional" and criteria.get("mand", {}).get("bdouble") is False:
        return "red"
    count = optional_count(criteria)
    return "green" if count >= 2 else "orange" if count == 1 else "red"


def category_label(verdict: str) -> str:
    return {
        "green": "Meets criteria",
        "orange": "Likely meets (1 of 2 optional)",
        "red": "Does not meet",
    }[verdict]


def patch_r04_text(text: str, passed: bool, optional_met: int, verdict: str) -> str:
    lines = []
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped.startswith("R-04") and "(mandatory)" in line:
            lines.append(f"R-04  {'met' if passed else 'not met'} (mandatory)")
        elif stripped.startswith("R-04") and ("B-double" in line or "b-double" in line):
            lines.append(f"R-04  {'PASS' if passed else 'fail'} - 19m B-double access")
        elif line.lstrip().startswith("\u2192"):
            lines.append(
                f"\u2192 {optional_met} optional met \u2014 {category_label(verdict)}"
            )
        else:
            lines.append(line)
    return "\n".join(lines)


def aggregate_unit_coverage(assessment: dict, lengths_m: list[float]) -> dict[str, float]:
    totals = defaultdict(float)
    covered = defaultdict(float)
    for index, feature in enumerate(assessment["features"]):
        properties = feature["properties"]
        unit = str(properties.get("road_unit") or "").strip()
        if not unit or properties.get("unit_excluded") in (True, 1):
            continue
        length = lengths_m[index]
        totals[unit] += length
        covered[unit] += length * float(properties.get("bdouble_coverage") or 0.0)
    return {
        unit: covered[unit] / total if total else 0.0
        for unit, total in totals.items()
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--network", type=Path, default=DEFAULT_NETWORK)
    parser.add_argument("--tolerance-m", type=float, default=DEFAULT_TOLERANCE_M)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    if not args.network.exists():
        raise FileNotFoundError(f"NHVR GeoPackage not found: {args.network}")

    assessment = read_json("nsw_assessment.geojson")
    roads = gpd.GeoDataFrame.from_features(assessment["features"], crs="EPSG:4326")
    network = approved_network(args.network)
    network_names = sorted(set(network["network_name"].dropna().astype(str)))
    print(f"network: {', '.join(network_names)}")
    print(f"approved NHVR segments: {len(network):,}")
    print(f"road source features: {len(roads):,}")
    print(f"matching tolerance: {args.tolerance_m:g} m")

    old_flags = [bool(feature["properties"].get("has_bdouble")) for feature in assessment["features"]]
    fractions = route_coverage(roads, network, args.tolerance_m)
    lengths_m = roads.to_crs(PROJECTED_CRS).geometry.length.tolist()
    new_flags = [fraction >= ACCESS_THRESHOLD for fraction in fractions]

    for index, feature in enumerate(assessment["features"]):
        properties = feature["properties"]
        properties["bdouble_coverage"] = round(fractions[index], 6)
        properties["has_bdouble"] = int(new_flags[index])

    unit_coverage = aggregate_unit_coverage(assessment, lengths_m)
    criteria = read_json("nsw_criteria.json")
    previous_criteria = copy.deepcopy(criteria)
    road_changes = []
    new_verdicts = {}
    for key, row in criteria.items():
        if row.get("cls") != "Regional" or key not in unit_coverage:
            new_verdicts[key] = row.get("verdict")
            continue
        old_pass = row.get("mand", {}).get("bdouble") is True
        new_pass = unit_coverage[key] >= ACCESS_THRESHOLD
        row.setdefault("mand", {})["bdouble"] = new_pass
        row["optMet"] = optional_count(row)
        row["verdict"] = verdict_of(row)
        new_verdicts[key] = row["verdict"]
        if old_pass != new_pass or previous_criteria[key].get("verdict") != row["verdict"]:
            road_changes.append((key, old_pass, new_pass, unit_coverage[key], row["verdict"]))

    for feature in assessment["features"]:
        properties = feature["properties"]
        key = str(properties.get("road_unit") or properties.get("road_number") or "").strip()
        if key in new_verdicts:
            properties["status"] = new_verdicts[key]

    recat = read_json("nsw_recat.json")
    if len(recat) != len(assessment["features"]):
        raise RuntimeError("nsw_recat.json and nsw_assessment.geojson are not aligned")
    for index, feature in enumerate(assessment["features"]):
        properties = feature["properties"]
        key = str(properties.get("road_unit") or properties.get("road_number") or "").strip()
        if key in new_verdicts:
            recat[index] = new_verdicts[key]

    nhvr = read_json("nhvr_networks.json")
    for key, fraction in unit_coverage.items():
        if key not in criteria:
            continue
        row = nhvr.setdefault(key, {})
        row["bdouble19"] = fraction >= ACCESS_THRESHOLD
        row["bdouble19Coverage"] = round(fraction, 6)
        row["bdouble19ToleranceM"] = args.tolerance_m

    export_rows = read_json("export_rows.json")
    for row in export_rows.get("regional", []):
        key = str(row.get("Road ID") or "").strip()
        if key not in criteria or key not in unit_coverage:
            continue
        fraction = unit_coverage[key]
        passed = fraction >= ACCESS_THRESHOLD
        verdict = criteria[key]["verdict"]
        row["_v"] = verdict
        row["Categorisation"] = category_label(verdict)
        row["Why"] = patch_r04_text(
            row.get("Why", ""), passed, criteria[key]["optMet"], verdict
        )
        row["What (criteria tested)"] = patch_r04_text(
            row.get("What (criteria tested)", ""), passed, criteria[key]["optMet"], verdict
        )
        hv_lines = row.get("HV Networks (NHVR)", "").split("\n")
        replacement = f"B-double 19m: {'yes' if passed else 'no'} ({fraction:.1%} route coverage)"
        if hv_lines:
            hv_lines[0] = replacement
        else:
            hv_lines = [replacement]
        row["HV Networks (NHVR)"] = "\n".join(hv_lines)

    admin = [feature["properties"].get("admin_class") for feature in assessment["features"]]
    statuses = [feature["properties"].get("status") for feature in assessment["features"]]

    def count(admin_class: str, verdict: str) -> int:
        return sum(
            1 for index, value in enumerate(statuses)
            if admin[index] == admin_class and value == verdict
        )

    stats = {
        "total_roads": len(statuses),
        "green": statuses.count("green"),
        "orange": statuses.count("orange"),
        "red": statuses.count("red"),
        "by_category": {
            "State Road": {
                "total": admin.count("S"),
                "green": count("S", "green"),
                "orange": count("S", "orange"),
                "red": count("S", "red"),
            },
            "Regional Road": {
                "total": admin.count("R"),
                "green": count("R", "green"),
                "orange": count("R", "orange"),
                "red": count("R", "red"),
            },
        },
    }

    changed_features = sum(old != new for old, new in zip(old_flags, new_flags))
    regional_coverages = {
        key: fraction for key, fraction in unit_coverage.items()
        if criteria.get(key, {}).get("cls") == "Regional"
    }
    old_regional_passes = sum(
        previous_criteria[key].get("mand", {}).get("bdouble") is True
        for key in regional_coverages
    )
    new_regional_passes = sum(
        fraction >= ACCESS_THRESHOLD for fraction in regional_coverages.values()
    )
    direction = Counter((old_pass, new_pass) for _key, old_pass, new_pass, _fraction, _verdict in road_changes)
    print(f"source feature access flags changed: {changed_features:,}")
    print(
        f"Regional R-04 passes: {old_regional_passes:,} -> {new_regional_passes:,} "
        f"of {len(regional_coverages):,} assessed roads"
    )
    print(f"Regional road assessments changed: {len(road_changes):,}")
    print(
        "R-04 pass changes: "
        f"pass to fail={direction[(True, False)]:,}, "
        f"fail to pass={direction[(False, True)]:,}"
    )
    print("examples (road, old pass, new pass, coverage, new verdict):")
    for change in road_changes[:15]:
        print(f"  {change[0]} {change[1]} -> {change[2]} {change[3]:.1%} {change[4]}")
    rr7105 = unit_coverage.get("0007105")
    if rr7105 is not None:
        print(f"RR7105 exact B-double coverage: {rr7105:.2%}")
        if rr7105 >= ACCESS_THRESHOLD:
            raise RuntimeError("RR7105 still passes R-04; inspect the source/network alignment")

    if not args.apply:
        print("dry run only; use --apply to write the rebuilt data")
        return

    write_json("nsw_assessment.geojson", assessment)
    write_json("nsw_criteria.json", criteria)
    write_json("nsw_recat.json", recat)
    write_json("nhvr_networks.json", nhvr)
    write_json("export_rows.json", export_rows)
    write_json("nsw_stats.json", stats, indent=2)
    print("wrote exact B-double coverage and Regional R-04 results")


if __name__ == "__main__":
    main()
