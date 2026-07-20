#!/usr/bin/env python3
"""Trace short local-road access paths for size-qualified employment centres.

R-02/R-06 can use a proved local-road connection to a size-qualified employment
centre. S-08/S-11 retain the stricter selected-road intersection rule, but share
this audit so the map can show a real access path without hiding the direct gap.
"""

from __future__ import annotations

import argparse
import heapq
import json
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import geopandas as gpd
import numpy as np
import pyogrio
from scipy.spatial import cKDTree
from shapely.ops import nearest_points

from network_connectivity import (
    DisjointSet,
    ENDPOINT_SNAP_M,
    PROJECTED_CRS,
    ROAD_SEGMENT_CRS,
)
from rebuild_employment_centres import (
    ASSESSMENT_BASIS as EMPLOYMENT_ASSESSMENT_BASIS,
    EMPLOYMENT_AREA_HA,
    derive_centres,
    source_path as employment_source_path,
)


DASHBOARD = Path(__file__).resolve().parent
DATA = DASHBOARD / "data"
DEFAULT_RAW = Path.home() / "Desktop" / "IPWEA" / "data" / "raw"
OUTPUT_NAME = "regional_employment_access.json"
MAX_DIRECT_GAP_M = 1_500.0
MAX_NETWORK_PATH_M = 2_000.0
ROUTE_LINK_TOLERANCE_M = 100.0
EMPLOYMENT_LINK_TOLERANCE_M = 50.0
QUERY_RADIUS_M = MAX_NETWORK_PATH_M + ROUTE_LINK_TOLERANCE_M


def read_json(path: Path):
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, value) -> None:
    with path.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False)


def _line_endpoint_graph(segments: gpd.GeoDataFrame):
    geometries = [geometry for geometry in segments.geometry if geometry is not None and not geometry.is_empty]
    if not geometries:
        return [], {}, []

    coordinates = []
    for geometry in geometries:
        points = list(geometry.coords)
        coordinates.extend((points[0], points[-1]))

    sets = DisjointSet(len(coordinates))
    tree = cKDTree(np.asarray(coordinates))
    for left, right in tree.query_pairs(ENDPOINT_SNAP_M):
        sets.union(left, right)

    roots = [sets.find(index) for index in range(len(coordinates))]
    adjacency = defaultdict(list)
    for index, geometry in enumerate(geometries):
        left = roots[index * 2]
        right = roots[index * 2 + 1]
        length = float(geometry.length)
        adjacency[left].append((right, length))
        adjacency[right].append((left, length))
    return geometries, adjacency, roots


def shortest_access_path(
    route_geometry,
    employment_geometry,
    segments: gpd.GeoDataFrame,
    maximum_path_m: float = MAX_NETWORK_PATH_M,
) -> float | None:
    """Return the shortest continuous street path, or ``None`` if unavailable."""
    geometries, adjacency, roots = _line_endpoint_graph(segments)
    if not geometries:
        return None

    source_costs = {}
    target_costs = {}
    source_measures = {}
    target_measures = {}

    for index, geometry in enumerate(geometries):
        length = float(geometry.length)
        route_distance = float(geometry.distance(route_geometry))
        if route_distance <= ROUTE_LINK_TOLERANCE_M:
            _route_point, segment_point = nearest_points(route_geometry, geometry)
            measure = float(geometry.project(segment_point))
            source_measures[index] = measure
            for node, cost in (
                (roots[index * 2], measure),
                (roots[index * 2 + 1], length - measure),
            ):
                source_costs[node] = min(source_costs.get(node, float("inf")), cost)

        employment_distance = float(geometry.distance(employment_geometry))
        if employment_distance <= EMPLOYMENT_LINK_TOLERANCE_M:
            _employment_point, segment_point = nearest_points(employment_geometry, geometry)
            measure = float(geometry.project(segment_point))
            target_measures[index] = measure
            for node, cost in (
                (roots[index * 2], measure),
                (roots[index * 2 + 1], length - measure),
            ):
                target_costs[node] = min(target_costs.get(node, float("inf")), cost)

    if not source_costs or not target_costs:
        return None

    best = min(
        (
            abs(source_measures[index] - target_measures[index])
            for index in set(source_measures) & set(target_measures)
        ),
        default=float("inf"),
    )
    distances = dict(source_costs)
    queue = [(distance, node) for node, distance in distances.items()]
    heapq.heapify(queue)

    while queue:
        distance, node = heapq.heappop(queue)
        if distance != distances.get(node) or distance >= min(best, maximum_path_m):
            continue
        if node in target_costs:
            best = min(best, distance + target_costs[node])
        for neighbour, edge_length in adjacency.get(node, []):
            candidate = distance + edge_length
            if candidate < distances.get(neighbour, float("inf")) and candidate < min(best, maximum_path_m):
                distances[neighbour] = candidate
                heapq.heappush(queue, (candidate, neighbour))

    return best if best <= maximum_path_m else None


def query_local_segments(road_segments_path: Path, employment_geometry) -> gpd.GeoDataFrame:
    mask = gpd.GeoSeries(
        [employment_geometry.buffer(QUERY_RADIUS_M)],
        crs=PROJECTED_CRS,
    ).to_crs(ROAD_SEGMENT_CRS).iloc[0]
    segments = pyogrio.read_dataframe(
        road_segments_path,
        layer="road_segments",
        columns=["OBJECTID", "operationalstatus"],
        mask=mask,
    )
    segments = segments[segments["operationalstatus"] == 1].copy()
    return segments.to_crs(PROJECTED_CRS)


def _candidate_pairs(evidence: dict, routes: gpd.GeoDataFrame, unit_filter: set[str] | None = None):
    pairs = defaultdict(list)
    direct = {}
    for unit_key, buckets in evidence.items():
        if unit_filter and unit_key not in unit_filter:
            continue
        if unit_key not in routes.index:
            continue
        for item in buckets.get("employment", []):
            zone_id = str(item.get("zoneId") or "")
            if not zone_id or item.get("size_qualifies") is not True:
                continue
            pair_key = (unit_key, zone_id)
            distance_m = float(item.get("distance_m") or 0.0)
            base = {
                "unit": unit_key,
                "zone_id": zone_id,
                "name": item.get("name"),
                "ha": item.get("ha"),
                "size_threshold_ha": item.get("size_threshold_ha"),
                "assessment_basis": item.get("assessment_basis") or EMPLOYMENT_ASSESSMENT_BASIS,
                "source": item.get("source"),
                "direct_gap_m": round(distance_m),
            }
            if item.get("relation") == "intersects":
                direct[pair_key] = {
                    **base,
                    "connected": True,
                    "path_m": 0,
                    "method": "direct_polygon_intersection",
                }
            elif distance_m <= MAX_DIRECT_GAP_M:
                pairs[zone_id].append({**base, "route_geometry": routes.loc[unit_key].geometry})
    return pairs, direct


def generate_results(
    road_segments_path: Path,
    evidence: dict,
    routes: gpd.GeoDataFrame,
    employment_centres: gpd.GeoDataFrame,
    workers: int = 8,
    unit_filter: set[str] | None = None,
) -> dict:
    pairs_by_zone, results = _candidate_pairs(evidence, routes, unit_filter)
    employment_lookup = {
        str(row.zone_id): row.geometry
        for row in employment_centres.itertuples()
        if str(row.zone_id) in pairs_by_zone
    }

    def evaluate_zone(zone_id: str, pairs: list[dict]):
        polygon = employment_lookup.get(zone_id)
        if polygon is None:
            return []
        segments = query_local_segments(road_segments_path, polygon)
        rows = []
        for pair in pairs:
            path_m = shortest_access_path(pair["route_geometry"], polygon, segments)
            rows.append({
                key: value for key, value in {
                    **pair,
                    "connected": path_m is not None,
                    "path_m": round(path_m) if path_m is not None else None,
                    "method": "nsw_road_segment_shortest_path",
                    "local_segment_count": len(segments),
                }.items() if key != "route_geometry"
            })
        return rows

    completed = 0
    with ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        futures = {
            executor.submit(evaluate_zone, zone_id, pairs): zone_id
            for zone_id, pairs in pairs_by_zone.items()
        }
        for future in as_completed(futures):
            for row in future.result():
                results[(row["unit"], row["zone_id"])] = row
            completed += 1
            if completed % 25 == 0 or completed == len(futures):
                print(f"employment access: {completed:,}/{len(futures):,} polygons", flush=True)

    nested = defaultdict(dict)
    for (unit_key, zone_id), row in sorted(results.items()):
        nested[unit_key][zone_id] = row
    return {unit_key: rows for unit_key, rows in nested.items()}


def apply_access_results(evidence: dict, audit: dict) -> int:
    """Attach stored access decisions to the matching employment evidence rows."""
    results = audit.get("results", {})
    applied = 0
    for unit_key, buckets in evidence.items():
        unit_results = results.get(unit_key, {})
        for item in buckets.get("employment", []):
            for field in (
                "network_access",
                "network_access_m",
                "network_access_method",
                "network_access_max_m",
            ):
                item.pop(field, None)
            result = unit_results.get(str(item.get("zoneId") or ""))
            if not result:
                continue
            item["network_access"] = result.get("connected") is True
            item["network_access_m"] = result.get("path_m")
            item["network_access_method"] = result.get("method")
            item["network_access_max_m"] = MAX_NETWORK_PATH_M
            applied += 1
    return applied


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-dir", type=Path, default=DEFAULT_RAW)
    parser.add_argument("--unit-id", action="append", default=[])
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    road_segments = args.raw_dir / "nsw_road_segments_gda2020" / "nsw_road_segments.gpkg"
    if not road_segments.exists():
        raise FileNotFoundError(road_segments)

    assessment = gpd.read_file(DATA / "nsw_assessment.geojson")
    assessment = assessment[assessment["road_unit"].notna()].to_crs(PROJECTED_CRS)
    routes = assessment.dissolve(by="road_unit")[["geometry"]]
    evidence = read_json(DATA / "nsw_unit_evidence.json")
    employment_centres = derive_centres(employment_source_path(args.raw_dir))
    unit_filter = set(args.unit_id) or None
    results = generate_results(
        road_segments,
        evidence,
        routes,
        employment_centres,
        workers=args.workers,
        unit_filter=unit_filter,
    )
    rows = [row for units in results.values() for row in units.values()]
    connected = sum(row.get("connected") is True for row in rows)
    report = {
        "method": {
            "criterion": "R-02/R-06 size-qualified employment-centre access",
            "road_source": "NSW Transport Theme GDA2020 RoadSegment",
            "maximum_direct_gap_m": MAX_DIRECT_GAP_M,
            "maximum_network_path_m": MAX_NETWORK_PATH_M,
            "route_link_tolerance_m": ROUTE_LINK_TOLERANCE_M,
            "employment_link_tolerance_m": EMPLOYMENT_LINK_TOLERANCE_M,
            "employment_area_hectares": EMPLOYMENT_AREA_HA,
            "employment_assessment_basis": EMPLOYMENT_ASSESSMENT_BASIS,
        },
        "summary": {
            "pairs": len(rows),
            "connected": connected,
            "not_connected": len(rows) - connected,
        },
        "results": results,
    }
    print(json.dumps(report["summary"], indent=2), flush=True)
    if "0000237~R02" in results:
        print(json.dumps({"0000237~R02": results["0000237~R02"]}, indent=2), flush=True)
    if args.apply:
        if unit_filter:
            raise RuntimeError("Refusing to overwrite statewide results with --unit-id filtering")
        write_json(DATA / OUTPUT_NAME, report)
        print(f"wrote {DATA / OUTPUT_NAME}", flush=True)
    else:
        print("dry run only; use --apply to write statewide access results", flush=True)


if __name__ == "__main__":
    main()
