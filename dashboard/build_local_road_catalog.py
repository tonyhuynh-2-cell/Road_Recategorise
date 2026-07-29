#!/usr/bin/env python3
"""Build an offline statewide catalogue of NSW roads classified LocalRoad.

The source is the NSW Transport Theme RoadSegment layer. The output deliberately
separates sourced facts from assessment inferences:

* every operational functionhierarchy=6 segment is retained;
* connected segments with the same full name become one road;
* unnamed segments remain individual, auditable candidates;
* available centre/facility criteria are assessed;
* mandatory heavy-vehicle gates are measured against the complete NHVR routes;
* optional criteria without statewide evidence stay explicitly unknown.

Geometry is written in small grid chunks for zoom-gated browser loading. The
manifest and catalogue contain the statewide counts and per-road audit record.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

import geopandas as gpd
import pandas as pd
import pyogrio
from shapely import STRtree, line_merge, union_all
from shapely.geometry import LineString, Point, box, mapping


LOCAL_FUNCTION_HIERARCHY = 6
OPERATIONAL_STATUS = 1
SOURCE_CRS = "EPSG:7844"
METRIC_CRS = "EPSG:3577"
ENDPOINT_TOLERANCE_M = 1.0
EVIDENCE_DISTANCE_M = 1_200.0
MINIMUM_CONNECTION_SPAN_M = 500.0
BDOUBLE_TOLERANCE_M = 100.0
PBS1_TOLERANCE_M = 50.0
HEAVY_VEHICLE_ACCESS_THRESHOLD = 0.80
CHUNK_DEGREES = 0.25
GEOMETRY_SIMPLIFY_M = 2.0

FUNCTION_HIERARCHY_LABEL = "LocalRoad"
SOURCE_NAME = "NSW Transport Theme GDA2020 RoadSegment"
BDOUBLE_NETWORK_NAME = "NSW- 19m B-Double Over 50t"
PBS1_NETWORK_NAME = "NSW- PBS Aggregate GML - Level 1"
DEFAULT_PBS1_PATH = Path(
    "/Users/hishamtoryalay/Desktop/IPWEA/data/raw/nhvr_hvn_11240619.gpkg"
)

UNKNOWN_REGIONAL = [
    "R-03 road-train access",
    "traffic volume / heavy-vehicle percentage",
    "two-State-road connectivity where applicable",
]
UNKNOWN_STATE = [
    "traffic volume / heavy-vehicle percentage",
    "long-distance route test where applicable",
]


class UnionFind:
    def __init__(self, size: int) -> None:
        self.parent = list(range(size))
        self.rank = [0] * size

    def find(self, item: int) -> int:
        parent = self.parent
        while parent[item] != item:
            parent[item] = parent[parent[item]]
            item = parent[item]
        return item

    def union(self, left: int, right: int) -> None:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root == right_root:
            return
        if self.rank[left_root] < self.rank[right_root]:
            left_root, right_root = right_root, left_root
        self.parent[right_root] = left_root
        if self.rank[left_root] == self.rank[right_root]:
            self.rank[left_root] += 1


def clean_part(value: object) -> str:
    if value is None or pd.isna(value):
        return ""
    return re.sub(r"\s+", " ", str(value).strip())


def display_name(base: object, road_type: object, suffix: object) -> str:
    return " ".join(part for part in (clean_part(base), clean_part(road_type), clean_part(suffix)) if part)


def normalise_name(value: str) -> str:
    return re.sub(r"[^A-Z0-9]+", " ", value.upper()).strip()


def stable_road_id(name_key: str, topo_ids: Sequence[int]) -> str:
    seed = name_key + "|" + ",".join(str(value) for value in sorted(topo_ids))
    return "local-" + hashlib.sha1(seed.encode("utf-8")).hexdigest()[:16]


def endpoint_key(point, tolerance: float = ENDPOINT_TOLERANCE_M) -> tuple[int, int]:
    return (round(point.x / tolerance), round(point.y / tolerance))


def connected_groups(
    names: Sequence[str],
    geometries: Sequence[LineString],
    named: Sequence[bool],
    tolerance: float = ENDPOINT_TOLERANCE_M,
) -> list[list[int]]:
    """Group same-name lines sharing a quantised endpoint.

    Unnamed lines intentionally stay individual. Joining unnamed lines through
    intersections can collapse an entire suburb into a fictitious single road.
    """

    union_find = UnionFind(len(geometries))
    endpoints: dict[tuple[str, int, int], int] = {}

    for index, geometry in enumerate(geometries):
        if not named[index] or geometry is None or geometry.is_empty:
            continue
        coords = list(geometry.coords)
        for point in (Point(coords[0]), Point(coords[-1])):
            x_key, y_key = endpoint_key(point, tolerance)
            key = (names[index], x_key, y_key)
            previous = endpoints.get(key)
            if previous is None:
                endpoints[key] = index
            else:
                union_find.union(previous, index)

    grouped: dict[int, list[int]] = defaultdict(list)
    for index in range(len(geometries)):
        grouped[union_find.find(index)].append(index)
    return list(grouped.values())


def merge_group_geometry(geometries: Iterable[LineString]):
    merged = line_merge(union_all(list(geometries)))
    return merged


def dedupe_names(values: Iterable[str]) -> list[str]:
    """De-duplicate town/SUA aliases using the same compound-name rule as the UI."""

    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        tokens = []
        for token in re.split(r"\s+[-–]\s+", value):
            token = re.sub(r"\s*\([^)]*\)\s*$", "", token).strip()
            canonical = normalise_name(token)
            if canonical:
                tokens.append(canonical)
        if any(token in seen for token in tokens):
            continue
        seen.update(tokens)
        result.append(value)
    return result


def terminal_points(
    geometries: Iterable[LineString],
    tolerance: float = ENDPOINT_TOLERANCE_M,
) -> list[Point]:
    """Return degree-one endpoints for a connected road, including branch ends."""

    endpoints: dict[tuple[int, int], list[Point]] = defaultdict(list)
    for geometry in geometries:
        if geometry is None or geometry.is_empty:
            continue
        coords = list(geometry.coords)
        for coordinate in (coords[0], coords[-1]):
            point = Point(coordinate)
            endpoints[endpoint_key(point, tolerance)].append(point)
    terminal = [points for points in endpoints.values() if len(points) == 1]
    selected = terminal or list(endpoints.values())
    return [
        Point(
            sum(point.x for point in points) / len(points),
            sum(point.y for point in points) / len(points),
        )
        for points in selected
    ]


def terminal_matches(
    terminals: Sequence[Point],
    points: gpd.GeoDataFrame,
    distance_m: float = EVIDENCE_DISTANCE_M,
) -> list[tuple[int, str]]:
    """Assign each terminal to its nearest evidence point within the threshold."""

    matches: list[tuple[int, str]] = []
    if points.empty:
        return matches
    for terminal_index, terminal in enumerate(terminals):
        indexes = list(
            points.sindex.query(
                terminal.buffer(distance_m),
                predicate="intersects",
            )
        )
        if not indexes:
            continue
        nearest = min(indexes, key=lambda index: terminal.distance(points.geometry.iloc[index]))
        matches.append((terminal_index, str(points.iloc[nearest]["name"])))
    return matches


def connected_terminal_names(
    terminals: Sequence[Point],
    points: gpd.GeoDataFrame,
    distance_m: float = EVIDENCE_DISTANCE_M,
) -> list[str]:
    """Return distinct evidence names reached from separate road terminals."""

    if not has_connection_span(terminals):
        return []
    return dedupe_names(name for _terminal, name in terminal_matches(terminals, points, distance_m))


def has_connection_span(
    terminals: Sequence[Point],
    minimum_span_m: float = MINIMUM_CONNECTION_SPAN_M,
) -> bool:
    """Reject overlapping-catchment matches on very short road candidates."""

    return any(
        left.distance(right) >= minimum_span_m
        for index, left in enumerate(terminals)
        for right in terminals[index + 1 :]
    )


def facility_connection_names(
    terminals: Sequence[Point],
    facilities: gpd.GeoDataFrame,
    centres: gpd.GeoDataFrame,
    distance_m: float = EVIDENCE_DISTANCE_M,
) -> list[str]:
    """Return facilities connected to a centre through a different road terminal."""

    if not has_connection_span(terminals):
        return []
    facility_matches = terminal_matches(terminals, facilities, distance_m)
    centre_matches = terminal_matches(terminals, centres, distance_m)
    names = {
        facility_name
        for facility_terminal, facility_name in facility_matches
        if any(centre_terminal != facility_terminal for centre_terminal, _name in centre_matches)
    }
    return sorted(names)


class NetworkCoverage:
    """Measure how much road geometry follows a complete approved route network."""

    def __init__(self, geometries: Sequence, tolerance_m: float = PBS1_TOLERANCE_M) -> None:
        self.geometries = list(geometries)
        self.tolerance_m = tolerance_m
        self.tree = STRtree(self.geometries)

    def fraction(self, geometry) -> float:
        if geometry is None or geometry.is_empty or geometry.length <= 0:
            return 0.0
        indexes = self.tree.query(
            geometry.buffer(self.tolerance_m),
            predicate="intersects",
        )
        if not len(indexes):
            return 0.0
        nearby = union_all([self.geometries[index] for index in indexes])
        covered = geometry.intersection(
            nearby.buffer(self.tolerance_m)
        ).length
        return min(1.0, max(0.0, covered / geometry.length))


def available_outcome(
    regional_centres: int,
    state_centres: int,
    regional_facilities: int,
    state_facilities: int,
    bdouble: bool,
    pbs1: bool,
) -> dict:
    regional_met = int(regional_centres >= 2) + int(regional_facilities >= 1)
    state_met = int(state_centres >= 2) + int(state_facilities >= 1)

    if state_met >= 2 and pbs1:
        status = "potential_state"
        label = "State Road — passes PBS Level 1 gate and 2 available optional criteria"
    elif regional_met >= 2 and bdouble:
        status = "potential_regional"
        label = "Regional Road — passes B-double gate and 2 available optional criteria"
    elif regional_met == 1 and bdouble:
        status = "likely_regional"
        label = "Provisional Regional Road — B-double gate passes; 1 of 2 optional criteria"
    elif state_met == 1 and pbs1:
        status = "likely_state"
        label = "Provisional State Road — PBS Level 1 gate passes; 1 of 2 optional criteria"
    else:
        status = "local_available"
        label = "Local Road — no higher category demonstrated by available criteria"

    return {
        "status": status,
        "label": label,
        "regional_available_optional_met": regional_met,
        "state_available_optional_met": state_met,
        "regional_mandatory_gate": bdouble,
        "state_mandatory_gate": pbs1,
        "unknown_regional": UNKNOWN_REGIONAL,
        "unknown_state": UNKNOWN_STATE,
    }


def load_segments(source: Path, limit: int | None = None) -> gpd.GeoDataFrame:
    frame = pyogrio.read_dataframe(
        source,
        layer="road_segments",
        columns=[
            "OBJECTID",
            "topoid",
            "roadnamebase",
            "roadnametype",
            "roadnamesuffix",
            "surface",
            "urbanity",
        ],
        where=(
            f"operationalstatus = {OPERATIONAL_STATUS} "
            f"AND functionhierarchy = {LOCAL_FUNCTION_HIERARCHY}"
        ),
        max_features=limit,
    )
    if frame.crs is None:
        frame = frame.set_crs(SOURCE_CRS)
    frame["display_name"] = [
        display_name(base, road_type, suffix)
        for base, road_type, suffix in zip(
            frame["roadnamebase"], frame["roadnametype"], frame["roadnamesuffix"]
        )
    ]
    frame["name_key"] = frame["display_name"].map(normalise_name)
    frame["is_named"] = frame["name_key"] != ""
    return frame


def load_centres(data_dir: Path) -> tuple[gpd.GeoDataFrame, gpd.GeoDataFrame]:
    towns = gpd.read_file(data_dir / "nsw_towns.geojson")
    towns = towns[towns.geometry.notna()].copy()
    towns["name"] = towns["name"].fillna("Centre")
    towns["town_type"] = towns["town_type"].fillna("")

    sua_payload = json.loads((data_dir / "sua_outlines.json").read_text())
    sua_rows = [
        {"name": row.get("name") or "Urban area", "town_type": "Significant Urban Area", "geometry": row["centroid"]}
        for row in sua_payload
        if row.get("centroid")
    ]
    sua = gpd.GeoDataFrame(
        [{**row, "geometry": gpd.points_from_xy([row["geometry"][0]], [row["geometry"][1]])[0]} for row in sua_rows],
        crs="EPSG:4326",
    )
    all_centres = pd.concat(
        [towns[["name", "town_type", "geometry"]].to_crs("EPSG:4326"), sua],
        ignore_index=True,
    )
    all_centres = gpd.GeoDataFrame(all_centres, geometry="geometry", crs="EPSG:4326")
    state_centres = all_centres[
        all_centres["town_type"].isin(["Regional City", "Major Town", "Significant Urban Area"])
    ].copy()
    return all_centres.to_crs(METRIC_CRS), state_centres.to_crs(METRIC_CRS)


def load_facilities(data_dir: Path) -> gpd.GeoDataFrame:
    evidence = json.loads((data_dir / "nsw_evidence.json").read_text())
    rows: dict[tuple[str, float, float], dict] = {}

    def add(item: dict, facility_type: str) -> None:
        if item.get("lon") is None or item.get("lat") is None:
            return
        if facility_type == "employment" and float(item.get("ha") or 0) < 40:
            return
        key = (
            str(item.get("name") or "Facility"),
            round(float(item["lon"]), 5),
            round(float(item["lat"]), 5),
        )
        rows[key] = {
            "name": key[0],
            "facility_type": facility_type,
            "lon": float(item["lon"]),
            "lat": float(item["lat"]),
        }

    for road_evidence in evidence.values():
        for item in road_evidence.get("hospitals", []):
            add(item, "hospital")
        for item in road_evidence.get("dests", []):
            add(item, item.get("ftype") or "destination")
        for item in road_evidence.get("employment", []):
            add(item, "employment")

    values = list(rows.values())
    frame = gpd.GeoDataFrame(
        values,
        geometry=gpd.points_from_xy(
            [row["lon"] for row in values], [row["lat"] for row in values]
        ),
        crs="EPSG:4326",
    )
    return frame.to_crs(METRIC_CRS)


def load_approved_network(
    path: Path,
    network_name: str,
    tolerance_m: float,
) -> NetworkCoverage:
    network = pyogrio.read_dataframe(
        path,
        layer="hvn_road_segments",
        columns=["network_name", "access_code"],
        where="access_code LIKE 'Approved%'",
    )
    network = network[network["network_name"] == network_name]
    if network.empty:
        raise RuntimeError(f"No approved {network_name} segments found in {path}")
    metric_geometry = network.to_crs(METRIC_CRS).geometry
    return NetworkCoverage(
        metric_geometry[metric_geometry.notna()].tolist(),
        tolerance_m,
    )


def load_bdouble_network(data_dir: Path) -> NetworkCoverage:
    path = data_dir / "geopackages" / "nhvr_hvn_11240521.gpkg"
    return load_approved_network(path, BDOUBLE_NETWORK_NAME, BDOUBLE_TOLERANCE_M)


def load_pbs1_network(path: Path) -> NetworkCoverage:
    return load_approved_network(path, PBS1_NETWORK_NAME, PBS1_TOLERANCE_M)


@dataclass
class RoadRecord:
    road_id: str
    name: str
    named: bool
    segment_count: int
    length_km: float
    urbanity: str
    surface: int
    regional_centres: list[str]
    state_centres: list[str]
    regional_facilities: list[str]
    state_facilities: list[str]
    bdouble_coverage: float
    pbs1_coverage: float
    assessment: dict
    geometry: object

    def catalogue_dict(self) -> dict:
        assessment = self.assessment
        return {
            "id": self.road_id,
            "name": self.name,
            "named": self.named,
            "segment_count": self.segment_count,
            "length_km": round(self.length_km, 3),
            "urbanity": self.urbanity,
            "surface": self.surface,
            "regional_centres": self.regional_centres[:8],
            "state_centres": self.state_centres[:8],
            "regional_facilities": self.regional_facilities[:8],
            "state_facilities": self.state_facilities[:8],
            "bdouble_coverage": round(self.bdouble_coverage, 4),
            "pbs1_coverage": round(self.pbs1_coverage, 4),
            "assessment": {
                "status": assessment["status"],
                "label": assessment["label"],
                "regional_available_optional_met": assessment[
                    "regional_available_optional_met"
                ],
                "state_available_optional_met": assessment[
                    "state_available_optional_met"
                ],
                "regional_mandatory_gate": assessment["regional_mandatory_gate"],
                "state_mandatory_gate": assessment["state_mandatory_gate"],
            },
        }


def build_records(
    segments: gpd.GeoDataFrame,
    regional_centres: gpd.GeoDataFrame,
    state_centres: gpd.GeoDataFrame,
    facilities: gpd.GeoDataFrame,
    bdouble_network: NetworkCoverage,
    pbs1_network: NetworkCoverage,
) -> list[RoadRecord]:
    metric = segments.to_crs(METRIC_CRS)
    groups = connected_groups(
        metric["name_key"].tolist(),
        metric.geometry.tolist(),
        metric["is_named"].tolist(),
    )
    records: list[RoadRecord] = []

    for group_number, indexes in enumerate(groups, start=1):
        rows = metric.iloc[indexes]
        geometry = merge_group_geometry(rows.geometry.tolist())
        terminals = terminal_points(rows.geometry.tolist())
        named = bool(rows["is_named"].iloc[0])
        name = rows["display_name"].iloc[0] if named else "Unnamed local-road segment"
        topo_ids = [int(value) for value in rows["topoid"].fillna(rows["OBJECTID"]).tolist()]
        road_id = stable_road_id(rows["name_key"].iloc[0] or "UNNAMED", topo_ids)
        regional_names = connected_terminal_names(terminals, regional_centres)
        state_names = connected_terminal_names(terminals, state_centres)
        regional_facility_names = facility_connection_names(
            terminals, facilities, regional_centres
        )
        state_facility_names = facility_connection_names(
            terminals, facilities, state_centres
        )
        bdouble_coverage = bdouble_network.fraction(geometry)
        pbs1_coverage = pbs1_network.fraction(geometry)
        assessment = available_outcome(
            len(regional_names),
            len(state_names),
            len(regional_facility_names),
            len(state_facility_names),
            bdouble_coverage >= HEAVY_VEHICLE_ACCESS_THRESHOLD,
            pbs1_coverage > HEAVY_VEHICLE_ACCESS_THRESHOLD,
        )
        records.append(
            RoadRecord(
                road_id=road_id,
                name=name,
                named=named,
                segment_count=len(rows),
                length_km=float(geometry.length / 1000.0),
                urbanity=Counter(rows["urbanity"].fillna("")).most_common(1)[0][0],
                surface=int(Counter(rows["surface"].fillna(0).astype(int)).most_common(1)[0][0]),
                regional_centres=regional_names,
                state_centres=state_names,
                regional_facilities=regional_facility_names,
                state_facilities=state_facility_names,
                bdouble_coverage=bdouble_coverage,
                pbs1_coverage=pbs1_coverage,
                assessment=assessment,
                geometry=geometry,
            )
        )
        if group_number % 10_000 == 0:
            print(f"Assessed {group_number:,}/{len(groups):,} local roads", flush=True)

    return records


def write_outputs(records: list[RoadRecord], output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    chunks_dir = output_dir / "local_road_chunks"
    chunks_dir.mkdir(parents=True, exist_ok=True)
    for pattern in ("*.geojson", "*.geojson.gz"):
        for stale_chunk in chunks_dir.glob(pattern):
            stale_chunk.unlink()

    catalogue = [record.catalogue_dict() for record in records]
    with gzip.open(output_dir / "local_roads_catalog.json.gz", "wt", encoding="utf-8", compresslevel=9) as stream:
        json.dump(catalogue, stream, separators=(",", ":"))
    uncompressed_catalogue = output_dir / "local_roads_catalog.json"
    if uncompressed_catalogue.exists():
        uncompressed_catalogue.unlink()

    status_counts = Counter(record.assessment["status"] for record in records)
    status_length_km: dict[str, float] = defaultdict(float)
    for record in records:
        status_length_km[record.assessment["status"]] += record.length_km
    manifest = {
        "schema_version": 1,
        "source": SOURCE_NAME,
        "source_filter": {
            "operationalstatus": {"code": OPERATIONAL_STATUS, "label": "Operational"},
            "functionhierarchy": {
                "code": LOCAL_FUNCTION_HIERARCHY,
                "label": FUNCTION_HIERARCHY_LABEL,
            },
        },
        "assessment_scope": (
            "Terminal-based centre/facility connections plus measured NHVR PBS Level 1 "
            "and 19 m B-double route coverage; unavailable optional criteria remain unknown"
        ),
        "connection_method": {
            "description": "Distinct evidence assigned to separate road terminal points",
            "maximum_terminal_distance_m": EVIDENCE_DISTANCE_M,
            "minimum_terminal_span_m": MINIMUM_CONNECTION_SPAN_M,
        },
        "bdouble_method": {
            "source": BDOUBLE_NETWORK_NAME,
            "access_filter": "Approved or Approved with Conditions",
            "alignment_tolerance_m": BDOUBLE_TOLERANCE_M,
            "minimum_route_coverage": HEAVY_VEHICLE_ACCESS_THRESHOLD,
        },
        "pbs1_method": {
            "source": PBS1_NETWORK_NAME,
            "access_filter": "Approved or Approved with Conditions",
            "alignment_tolerance_m": PBS1_TOLERANCE_M,
            "minimum_route_coverage": HEAVY_VEHICLE_ACCESS_THRESHOLD,
        },
        "unknown_criteria": {
            "regional": UNKNOWN_REGIONAL,
            "state": UNKNOWN_STATE,
        },
        "road_count": len(records),
        "named_road_count": sum(record.named for record in records),
        "unnamed_road_count": sum(not record.named for record in records),
        "segment_count": sum(record.segment_count for record in records),
        "length_km": round(sum(record.length_km for record in records), 1),
        "status_counts": dict(sorted(status_counts.items())),
        "status_length_km": {
            key: round(value, 1) for key, value in sorted(status_length_km.items())
        },
        "geometry": {
            "chunk_degrees": CHUNK_DEGREES,
            "minimum_scale_metres": 2_000,
            "directory": "data/local_road_chunks",
        },
    }

    chunk_features: dict[str, list[dict]] = defaultdict(list)
    source_geometries = gpd.GeoSeries([record.geometry for record in records], crs=METRIC_CRS)
    display_geometries = source_geometries.simplify(GEOMETRY_SIMPLIFY_M).to_crs("EPSG:4326")
    for record, geometry in zip(records, display_geometries):
        min_x, min_y, max_x, max_y = geometry.bounds
        x0, x1 = math.floor(min_x / CHUNK_DEGREES), math.floor(max_x / CHUNK_DEGREES)
        y0, y1 = math.floor(min_y / CHUNK_DEGREES), math.floor(max_y / CHUNK_DEGREES)
        properties = {
            "id": record.road_id,
            "name": record.name,
            "status": record.assessment["status"],
            "label": record.assessment["label"],
            "length_km": round(record.length_km, 3),
            "regional_available_optional_met": record.assessment[
                "regional_available_optional_met"
            ],
            "state_available_optional_met": record.assessment[
                "state_available_optional_met"
            ],
            "regional_centres": record.regional_centres[:4],
            "state_centres": record.state_centres[:4],
            "regional_facilities": record.regional_facilities[:4],
            "state_facilities": record.state_facilities[:4],
            "bdouble_coverage": round(record.bdouble_coverage, 4),
            "pbs1_coverage": round(record.pbs1_coverage, 4),
            "bdouble": record.assessment["regional_mandatory_gate"],
            "pbs1": record.assessment["state_mandatory_gate"],
        }
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                clipped = geometry.intersection(
                    box(
                        x * CHUNK_DEGREES,
                        y * CHUNK_DEGREES,
                        (x + 1) * CHUNK_DEGREES,
                        (y + 1) * CHUNK_DEGREES,
                    )
                )
                if clipped.is_empty:
                    continue
                chunk_features[f"{x}_{y}"].append(
                    {
                        "type": "Feature",
                        "properties": properties,
                        "geometry": mapping(clipped),
                    }
                )

    manifest["geometry"]["chunks"] = sorted(chunk_features)
    for key, features in chunk_features.items():
        with gzip.open(chunks_dir / f"{key}.geojson.gz", "wt", encoding="utf-8", compresslevel=9) as stream:
            json.dump(
                {"type": "FeatureCollection", "features": features},
                stream,
                separators=(",", ":"),
            )
    (output_dir / "local_roads_manifest.json").write_text(
        json.dumps(manifest, separators=(",", ":"))
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--segments",
        type=Path,
        default=Path(
            "/Users/hishamtoryalay/Desktop/IPWEA/data/raw/"
            "nsw_road_segments_gda2020/nsw_road_segments.gpkg"
        ),
    )
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).parent / "data")
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).parent / "data")
    parser.add_argument(
        "--pbs1-network",
        type=Path,
        default=DEFAULT_PBS1_PATH,
        help="NHVR GeoPackage containing the NSW PBS Level 1 network",
    )
    parser.add_argument("--limit", type=int, help="Build a deterministic source subset for development")
    args = parser.parse_args()

    segments = load_segments(args.segments, args.limit)
    print(
        f"Loaded {len(segments):,} operational {FUNCTION_HIERARCHY_LABEL} segments "
        f"({segments['is_named'].sum():,} named)",
        flush=True,
    )
    regional_centres, state_centres = load_centres(args.data_dir)
    facilities = load_facilities(args.data_dir)
    bdouble_network = load_bdouble_network(args.data_dir)
    pbs1_network = load_pbs1_network(args.pbs1_network)
    records = build_records(
        segments,
        regional_centres,
        state_centres,
        facilities,
        bdouble_network,
        pbs1_network,
    )
    write_outputs(records, args.output_dir)
    print(
        f"Wrote {len(records):,} local-road assessments to {args.output_dir}",
        flush=True,
    )


if __name__ == "__main__":
    main()
