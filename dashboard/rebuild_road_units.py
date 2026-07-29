#!/usr/bin/env python3
"""Build connected, class-consistent assessment units for the NSW dashboard.

TfNSW ``road_number`` values are administrative identifiers, not guaranteed
single-road identifiers. Some contain disconnected corridors, mixed State and
Regional sections, and different route shields. This script keeps the sourced
identifier as metadata while assigning each displayed segment to a connected
``road_unit`` used by the dashboard.

Existing one-unit roads retain their prepared optional evidence, but mandatory
PBS Level 1 and B-double gates are always refreshed from measured route
coverage. Administrative IDs that split into multiple units are reassessed from
unit geometry and the named evidence already available to the dashboard.
Road-wide values that cannot be located within a split ID (notably AADT and
road-train/bypass membership) are left unavailable rather than copied to
unrelated corridors.
"""

from __future__ import annotations

import argparse
import copy
import json
import math
from collections import Counter, defaultdict
from pathlib import Path

import geopandas as gpd
import pyogrio
from pyproj import Transformer
from scipy.spatial import cKDTree
from shapely.geometry import LineString, Point
from shapely.ops import nearest_points, unary_union

from network_connectivity import (
    DisjointSet,
    PROJECTED_CRS,
    load_abs_centres,
    load_or_build_corridor_matches,
    prepare_routes,
)
from rebuild_employment_centres import (
    ASSESSMENT_BASIS as EMPLOYMENT_ASSESSMENT_BASIS,
    derive_centres,
    employment_size_qualifies,
    employment_size_threshold,
    source_path as employment_source_path,
)
from rebuild_adt import (
    apply_traffic_criteria,
    build_measured_adt,
    combine_adt_rows,
)
from regional_employment_access import OUTPUT_NAME as REGIONAL_ACCESS_OUTPUT, apply_access_results
from rebuild_state_facility_optional import evaluate_state_dest, state_metadata


DASHBOARD = Path(__file__).resolve().parent
DATA = DASHBOARD / "data"
RAW = Path.home() / "Desktop" / "IPWEA" / "data" / "raw"

UNIT_SNAP_M = 200.0
COMPATIBLE_GAP_M = 1_000.0
MICRO_COMPONENT_KM = 0.35
MICRO_GAP_M = 2_000.0
TWO_STATE_TOUCH_M = 50.0
EVIDENCE_ATTACH_M = 5_000.0
EMPLOYMENT_DISPLAY_M = 3_000.0
EMPLOYMENT_NEARBY_LIMIT = 4
ACCESS_COVERAGE = 0.80
TO_WGS84 = Transformer.from_crs(PROJECTED_CRS, "EPSG:4326", always_xy=True)

# Some TfNSW identifiers intentionally cover unrelated corridors. These remain
# separate even if a future source edit happens to make their names look alike.
DECLARED_KEEP_SEPARATE = {"0000057"}

STATE_CENTRE_TYPES = {"Significant Urban Area", "Regional City", "Major Town"}
REGIONAL_RURAL_CENTRE_TYPES = STATE_CENTRE_TYPES | {"Town Centre"}
REGIONAL_URBAN_CENTRE_TYPES = STATE_CENTRE_TYPES
STATE_DEST_TYPES = {"International Airport", "Major Intermodal", "Major Port"}

# S-10 / R-05 "connects centres" optional — qualifying-centre rule.
# 1. Drop the metropolitan capital bubble: a centre >= CAPITAL_BUBBLE_POP that is NOT a
#    suburb (kind != 'sal') resolves the whole metro to one point (Greater Sydney and the
#    four SUA conurbations >= 100k), so a road inside it could only ever link that single
#    bubble. A capital city is a Nationally-Significant connectivity target, not a
#    State/Regional one — excluded here; the road is judged on the SUBURBS (SAL) it links.
#    No SAL reaches 100k (largest ~51k), so this never drops a real suburb.
# 2. Qualify at the Major-Town floor, per zone (S-10/R-05 say "Major Towns" / "Major Urban
#    Centres"; Major Town = 7,000, 5,000 remote), with a stricter 10,000 Major-Urban-Centre
#    floor inside urban zones.
CAPITAL_BUBBLE_POP = 100_000
CENTRE_CONNECT_FLOOR = {"urban": 10_000, "regional": 7_000, "remote": 5_000}


def connectivity_centre_names(evidence: dict, zone: str) -> set[str]:
    """Distinct qualifying centre names for the S-10/R-05 connectivity option: metro capital
    bubbles removed, remaining centres held to the zone's Major-Town floor."""
    floor = CENTRE_CONNECT_FLOOR.get(zone, 7_000)
    names = set()
    for item in evidence.get("centres", []):
        population = int(item.get("pop") or item.get("population") or 0)
        if population >= CAPITAL_BUBBLE_POP and item.get("kind") != "sal":
            continue
        if population >= floor:
            name = str(item.get("name") or "").strip()
            if name:
                names.add(name)
    return names


def read_json(name: str):
    with (DATA / name).open(encoding="utf-8") as handle:
        return json.load(handle)


def write_json(name: str, value) -> None:
    with (DATA / name).open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False)


def source_key(properties: dict) -> str:
    number = str(properties.get("road_number") or "").strip()
    if number:
        return number
    name = str(properties.get("road_name") or "").strip().lower()
    return f"n:{name}" if name else ""


def lines_of(geometry) -> list:
    if geometry is None or geometry.is_empty:
        return []
    if geometry.geom_type == "LineString":
        return [geometry]
    if geometry.geom_type == "MultiLineString":
        return list(geometry.geoms)
    return []


def effective_ref(properties: dict, automatic_ref, overrides: dict):
    override = overrides.get(str(properties.get("road_number") or ""))
    if override is None and properties.get("road_name"):
        override = overrides.get(str(properties["road_name"]).upper())
    if override is not None:
        return override or None
    return automatic_ref or properties.get("ref") or None


def connected_groups(geometries: list) -> list[list[int]]:
    """Group line features whose endpoints meet within the source-gap tolerance."""
    if not geometries:
        return []
    endpoints = []
    owners = []
    for index, geometry in enumerate(geometries):
        coords = list(geometry.coords)
        endpoints.extend((coords[0], coords[-1]))
        owners.extend((index, index))
    sets = DisjointSet(len(geometries))
    tree = cKDTree(endpoints)
    for left, right in tree.query_pairs(UNIT_SNAP_M):
        sets.union(owners[left], owners[right])
    grouped = defaultdict(list)
    for index in range(len(geometries)):
        grouped[sets.find(index)].append(index)
    return list(grouped.values())


def coalesce_source_components(rows: list[dict], features: list, refs: list) -> list[dict]:
    """Bridge modest source gaps when two components clearly describe one corridor."""
    if len(rows) < 2:
        return rows
    names = []
    route_refs = []
    for row in rows:
        names.append({
            str(features[index]["properties"].get("road_name") or "").strip().upper()
            for index in row["feature_indexes"]
            if str(features[index]["properties"].get("road_name") or "").strip()
        })
        route_refs.append({refs[index] for index in row["feature_indexes"] if refs[index]})

    sets = DisjointSet(len(rows))
    for left in range(len(rows)):
        for right in range(left + 1, len(rows)):
            if rows[left]["admin_class"] != rows[right]["admin_class"]:
                continue
            distance = rows[left]["geometry"].distance(rows[right]["geometry"])
            compatible = bool(names[left] & names[right] or route_refs[left] & route_refs[right])
            micro = min(rows[left]["length_km"], rows[right]["length_km"]) < MICRO_COMPONENT_KM
            if (compatible and distance <= COMPATIBLE_GAP_M) or (micro and compatible and distance <= MICRO_GAP_M):
                sets.union(left, right)

    grouped = defaultdict(list)
    for index in range(len(rows)):
        grouped[sets.find(index)].append(index)
    output = []
    for indexes in grouped.values():
        if len(indexes) == 1:
            output.append(rows[indexes[0]])
            continue
        first = rows[indexes[0]]
        feature_indexes = [
            feature_index
            for index in indexes
            for feature_index in rows[index]["feature_indexes"]
        ]
        lines = [first["features_wgs84"][index] for index in feature_indexes]
        projected = [rows[index]["geometry"] for index in indexes]
        merged = dict(first)
        merged.update({
            "feature_indexes": feature_indexes,
            "geometry": unary_union(projected),
            "length_km": sum(rows[index]["length_km"] for index in indexes),
            "terminal_points": terminal_points([
                geometry
                for index in indexes
                for geometry in lines_of(rows[index]["geometry"])
            ]),
        })
        output.append(merged)
    return output


def terminal_points(geometries: list) -> list[Point]:
    """Return degree-one endpoint clusters, tolerant of small source gaps."""
    if not geometries:
        return []
    endpoints = []
    for geometry in geometries:
        coords = list(geometry.coords)
        endpoints.extend((coords[0], coords[-1]))
    sets = DisjointSet(len(endpoints))
    tree = cKDTree(endpoints)
    for left, right in tree.query_pairs(UNIT_SNAP_M):
        sets.union(left, right)
    clusters = defaultdict(list)
    for index, coordinate in enumerate(endpoints):
        clusters[sets.find(index)].append(coordinate)
    terminal = [values for values in clusters.values() if len(values) == 1]
    selected = terminal or list(clusters.values())
    return [
        Point(
            sum(point[0] for point in values) / len(values),
            sum(point[1] for point in values) / len(values),
        )
        for values in selected
    ]


def newell_longitude(newell_segments: list[tuple], latitude: float) -> float | None:
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


def unit_zone(unit: dict, urbanity: list, newell_segments: list[tuple]) -> str:
    urban_km = 0.0
    rural_km = 0.0
    west_km = 0.0
    east_km = 0.0
    for index in unit["feature_indexes"]:
        length = unit["feature_lengths"][index]
        if index < len(urbanity) and urbanity[index] == "urban":
            urban_km += length
            continue
        rural_km += length
        geometry = unit["features_wgs84"][index]
        middle = geometry.interpolate(0.5, normalized=True)
        boundary_x = newell_longitude(newell_segments, middle.y)
        if boundary_x is not None and middle.x < boundary_x:
            west_km += length
        else:
            east_km += length
    if urban_km > rural_km:
        return "urban"
    return "remote" if west_km > east_km else "regional"


def criteria_area(zone: str) -> str:
    """Map the final road zone to the criteria family's urban/rural switch."""
    return "urban" if zone == "urban" else "rural"


def names_by_length(unit: dict, features) -> list[str]:
    lengths = Counter()
    for index in unit["feature_indexes"]:
        name = str(features[index]["properties"].get("road_name") or "").strip()
        if name:
            lengths[name] += unit["feature_lengths"][index]
    return [name for name, _length in sorted(lengths.items(), key=lambda item: (-item[1], item[0]))]


def weighted_flag(unit: dict, features, field: str) -> tuple[bool, float]:
    total = sum(unit["feature_lengths"][index] for index in unit["feature_indexes"])
    coverage_field = field.removeprefix("has_") + "_coverage"
    passed = 0.0
    for index in unit["feature_indexes"]:
        properties = features[index]["properties"]
        fraction = properties.get(coverage_field)
        if not isinstance(fraction, (int, float)):
            fraction = 1.0 if properties.get(field) in (True, 1) else 0.0
        passed += unit["feature_lengths"][index] * min(1.0, max(0.0, float(fraction)))
    coverage = passed / total if total else 0.0
    passes = coverage > ACCESS_COVERAGE if field == "has_pbs1" else coverage >= ACCESS_COVERAGE
    return passes, round(coverage, 6)


def attach_evidence(source_evidence: dict, units: list[dict]) -> dict[str, dict]:
    output = {unit["key"]: {} for unit in units}
    for bucket, items in (source_evidence or {}).items():
        if not isinstance(items, list):
            continue
        for item in items:
            if item.get("lon") is None or item.get("lat") is None:
                continue
            point = gpd.GeoSeries(
                [Point(float(item["lon"]), float(item["lat"]))], crs="EPSG:4326"
            ).to_crs(PROJECTED_CRS).iloc[0]
            distances = [point.distance(unit["geometry"]) for unit in units]
            if not distances:
                continue
            minimum = min(distances)
            targets = [
                index
                for index, distance in enumerate(distances)
                if distance <= EVIDENCE_ATTACH_M and distance <= minimum + UNIT_SNAP_M
            ]
            if not targets:
                targets = [distances.index(minimum)]
            for index in targets:
                copied = dict(item)
                copied["km"] = round(distances[index] / 1000.0, 1)
                output[units[index]["key"]].setdefault(bucket, []).append(copied)
    return output


def employment_evidence(units: dict[str, dict], centres: gpd.GeoDataFrame) -> dict[str, list[dict]]:
    """Attach exact employment polygons, retaining intersections and nearest misses."""
    output = {}
    for key, unit in units.items():
        size_threshold = employment_size_threshold(unit["zone"])
        indexes = centres.sindex.query(
            unit["geometry"].buffer(EMPLOYMENT_DISPLAY_M),
            predicate="intersects",
        )
        candidates = []
        for index in indexes:
            row = centres.iloc[index]
            distance = float(row.geometry.distance(unit["geometry"]))
            if distance <= EMPLOYMENT_DISPLAY_M:
                candidates.append((distance, row))
        intersecting = [pair for pair in candidates if pair[0] <= 0.5]
        nearby = sorted(
            (pair for pair in candidates if pair[0] > 0.5),
            key=lambda pair: (pair[0], pair[1]["zone_id"]),
        )[:EMPLOYMENT_NEARBY_LIMIT]
        items = []
        for distance, row in sorted(
            intersecting + nearby,
            key=lambda pair: (pair[0], pair[1]["LAY_CLASS"], pair[1]["zone_id"]),
        ):
            item = {
                "zoneId": row["zone_id"],
                "name": row["LAY_CLASS"],
                "code": row["SYM_CODE"],
                "kind": row["kind"],
                "tier": row["tier"],
                "size_band": row["size_band"],
                "ha": round(float(row["ha"]), 1),
                "size_threshold_ha": size_threshold,
                "size_qualifies": employment_size_qualifies(row["ha"], unit["zone"]),
                "assessment_basis": EMPLOYMENT_ASSESSMENT_BASIS,
                "lga": row["LGA_NAME"],
                "lon": round(float(row["lon"]), 5),
                "lat": round(float(row["lat"]), 5),
                "km": round(distance / 1000.0, 3),
                "distance_m": round(distance),
                "relation": "intersects" if distance <= 0.5 else "nearby",
                "source": row["source"],
                "source_id": row["source_id"],
                "official_precinct": bool(row["official_precinct"]),
                "zone_codes": row["zone_codes"],
                "planning_classes": row["planning_classes"],
            }
            if distance > 0.5:
                zone_point, road_point = nearest_points(row.geometry, unit["geometry"])
                zone_lon, zone_lat = TO_WGS84.transform(zone_point.x, zone_point.y)
                road_lon, road_lat = TO_WGS84.transform(road_point.x, road_point.y)
                item["link"] = [
                    [round(zone_lon, 5), round(zone_lat, 5)],
                    [round(road_lon, 5), round(road_lat, 5)],
                ]
            items.append(item)
        output[key] = items
    return output


def assign_network_segments(matches: gpd.GeoDataFrame, units: list[dict]) -> dict[str, gpd.GeoDataFrame]:
    """Partition cached physical segments between the connected units of one source ID."""
    assigned = {unit["key"]: [] for unit in units}
    if matches.empty:
        return {key: matches.copy() for key in assigned}
    buffers = [unit["geometry"].buffer(UNIT_SNAP_M) for unit in units]
    for index, geometry in zip(matches.index, matches.geometry):
        scores = []
        for unit_index, unit in enumerate(units):
            overlap = geometry.intersection(buffers[unit_index]).length
            scores.append((geometry.distance(unit["geometry"]), -overlap, unit["key"]))
        assigned[min(scores)[2]].append(index)
    return {
        key: matches.loc[indexes].copy() if indexes else matches.iloc[0:0].copy()
        for key, indexes in assigned.items()
    }


def unit_sections(unit: dict, features: list, projected_geometries: list) -> list[dict]:
    sections = []
    for index in unit["feature_indexes"]:
        name = str(features[index]["properties"].get("road_name") or "").strip()
        if name:
            sections.append({"name": name, "geometry": projected_geometries[index]})
    return sections


def centre_type(kind: str, population: int, zone: str) -> str | None:
    regional_city = 15_000 if zone == "remote" else 20_000
    major_town = 5_000 if zone == "remote" else 7_000
    town = 1_000 if zone == "remote" else 2_000
    if kind == "SUA" and population >= 130_000:
        return "Significant Urban Area"
    if population >= regional_city:
        return "Regional City"
    if population >= major_town:
        return "Major Town"
    if kind == "UCL" and population >= town:
        return "Town Centre"
    return None


def add_abs_centre_evidence(
    evidence: dict,
    unit: dict,
    centres: gpd.GeoDataFrame,
    names: list[str],
) -> None:
    """Add network-assessed ABS centres that were absent from legacy road evidence."""
    existing = {
        str(item.get("name") or "").strip()
        for item in evidence.get("centres", [])
        if str(item.get("name") or "").strip()
    }
    additions = []
    for name in names:
        if name in existing:
            continue
        candidates = centres[centres["name"].astype(str) == name]
        if candidates.empty:
            continue
        selected = min(
            (row for _index, row in candidates.iterrows()),
            key=lambda row: (row.geometry.distance(unit["geometry"]), row["kind"] != "UCL"),
        )
        population = int(selected["population"])
        kind = str(selected["kind"])
        classification = centre_type(kind, population, unit["zone"])
        if not classification:
            continue
        point = gpd.GeoSeries(
            [selected.geometry.representative_point()], crs=PROJECTED_CRS
        ).to_crs("EPSG:4326").iloc[0]
        additions.append({
            "name": name,
            "kind": "sua" if kind == "SUA" else "town",
            "pop": population,
            "type": classification,
            "lon": round(point.x, 5),
            "lat": round(point.y, 5),
            "km": round(selected.geometry.distance(unit["geometry"]) / 1000.0, 1),
            "source": "ABS ASGS 2021 network intersection",
        })
    if additions:
        evidence.setdefault("centres", []).extend(additions)


def assess_unit_state_dest(
    source_units: dict[str, list[dict]],
    unit_evidence: dict[str, dict],
    raw_dir: Path,
    features: list,
    projected_geometries: list,
    employment_centres: gpd.GeoDataFrame,
) -> tuple[dict[str, dict], dict]:
    """Re-run S-08/S-11 for every numbered connected assessment unit."""
    targets = {
        base: rows
        for base, rows in source_units.items()
        if not base.startswith("n:")
    }
    if not targets:
        return {}, {"source_ids": 0, "units": 0, "segments": 0}

    cache = raw_dir / "derived" / "road_corridor_matches.gpkg"
    road_segments = raw_dir / "nsw_road_segments_gda2020" / "nsw_road_segments.gpkg"
    for required in (cache, road_segments):
        if not required.exists():
            raise FileNotFoundError(required)
    routes = prepare_routes(DATA / "nsw_assessment.geojson", set(targets))
    matches = load_or_build_corridor_matches(
        road_segments,
        routes,
        cache,
    )
    matches["road_number"] = matches["road_number"].astype(str)
    matches = matches[matches["road_number"].isin(targets)].to_crs(PROJECTED_CRS)
    centres = load_abs_centres(raw_dir)
    employment_geometries = {
        str(row.zone_id): row.geometry
        for row in employment_centres.itertuples()
    }
    empty = matches.iloc[0:0].copy()
    results = {}
    assigned_segment_count = 0
    for base, rows in targets.items():
        source_matches = matches[matches["road_number"] == base].copy()
        by_unit = assign_network_segments(source_matches, rows)
        assigned_segment_count += sum(len(group) for group in by_unit.values())
        for unit in rows:
            result = evaluate_state_dest(
                unit["geometry"],
                by_unit.get(unit["key"], empty),
                centres,
                unit_evidence.get(unit["key"], {}),
                unit["zone"],
                unit_sections(unit, features, projected_geometries),
                employment_geometries,
            )
            if not result["assessed"]:
                continue
            results[unit["key"]] = result
            add_abs_centre_evidence(
                unit_evidence[unit["key"]],
                unit,
                centres,
                result["all_centre_names"],
            )
    return results, {
        "source_ids": len(targets),
        "units": len(results),
        "segments": assigned_segment_count,
    }


def centre_names(evidence: dict, allowed_types: set[str]) -> list[str]:
    return sorted({
        str(item.get("name") or "").strip()
        for item in evidence.get("centres", [])
        if item.get("type") in allowed_types and str(item.get("name") or "").strip()
    })


def state_ldr(unit: dict, evidence: dict, zone: str) -> dict:
    major_threshold = 5_000 if zone == "remote" else 7_000
    town_threshold = 1_000 if zone == "remote" else 2_000
    sources = set()
    towns = set()
    for item in evidence.get("centres", []):
        population = int(item.get("pop") or item.get("population") or 0)
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        if population >= major_threshold:
            sources.add(name)
        elif item.get("kind") != "sua" and town_threshold <= population < major_threshold:
            towns.add(name)
    passed = unit["length_km"] >= 25.0 and bool(sources) and bool(towns)
    return {
        "ldr": passed,
        "ldr_km": round(unit["length_km"], 1),
        "ldr_component_km": round(unit["length_km"], 1),
        "ldr_source_centres": sorted(sources),
        "ldr_town_centres": sorted(towns),
        "ldr_all_source_centres": sorted(sources),
        "ldr_all_town_centres": sorted(towns),
        "ldr_component_count": 1,
        "ldr_method": "road_unit_network",
        "ldr_network_coverage": 1.0,
    }


def state_facilities(evidence: dict, zone: str) -> list[dict]:
    facilities = []
    for item in evidence.get("hospitals", []):
        facilities.append({"name": item.get("name"), "kind": "hospital", "type": item.get("cat")})
    for item in evidence.get("dests", []):
        if item.get("ftype") in STATE_DEST_TYPES:
            facilities.append({"name": item.get("name"), "kind": "destination", "type": item.get("ftype")})
    minimum_hectares = employment_size_threshold(zone)
    for item in evidence.get("employment", []):
        if (
            item.get("relation") == "intersects"
            and employment_size_qualifies(item.get("ha"), zone)
        ):
            facilities.append({
                "name": item.get("name"),
                "kind": "employment",
                "ha": item.get("ha"),
                "tier": item.get("tier"),
                "type": item.get("kind"),
                "source": item.get("source"),
                "size_threshold_ha": minimum_hectares,
                "assessment_basis": EMPLOYMENT_ASSESSMENT_BASIS,
            })
    return [item for item in facilities if item.get("name")]


def regional_facilities(evidence: dict, zone: str) -> list[dict]:
    facilities = []
    for bucket, kind in (("hospitals", "hospital"), ("dests", "destination")):
        for item in evidence.get(bucket, []):
            facilities.append({"name": item.get("name"), "kind": kind, "type": item.get("ftype") or item.get("cat")})
    for item in evidence.get("employment", []):
        if (
            (item.get("relation") == "intersects" or item.get("network_access") is True)
            and employment_size_qualifies(item.get("ha"), zone)
        ):
            facilities.append({
                "name": item.get("name"),
                "kind": "employment",
                "ha": item.get("ha"),
                "tier": item.get("tier"),
                "type": item.get("kind"),
                "source": item.get("source"),
                "size_threshold_ha": employment_size_threshold(zone),
                "assessment_basis": EMPLOYMENT_ASSESSMENT_BASIS,
                "access_method": item.get("network_access_method"),
                "access_path_km": (
                    round(float(item["network_access_m"]) / 1000.0, 2)
                    if isinstance(item.get("network_access_m"), (int, float))
                    else None
                ),
            })
    return [item for item in facilities if item.get("name")]


def facility_metadata(unit: dict, centres: list[str], facilities: list[dict], prefix: str) -> dict:
    names = sorted({str(item["name"]) for item in facilities})
    passed = bool(centres and names)
    return {
        prefix: passed,
        f"{prefix}_component_km": round(unit["length_km"], 1),
        f"{prefix}_centre_names": centres,
        f"{prefix}_facility_names": names,
        f"{prefix}_facility_details": facilities,
        f"{prefix}_all_centre_names": centres,
        f"{prefix}_all_facility_names": names,
        f"{prefix}_component_count": 1,
    }


def optional_count(options: dict) -> int:
    return sum(value is True for value in options.values())


def verdict_of(criteria: dict) -> str:
    if criteria["cls"] == "State" and criteria["mand"].get("pbs1") is False:
        return "red"
    if criteria["cls"] == "Regional" and criteria["mand"].get("bdouble") is False:
        return "red"
    return "green" if criteria["optMet"] >= 2 else "orange" if criteria["optMet"] == 1 else "red"


def apply_measured_mandatory_gates(criteria: dict, unit: dict) -> dict:
    """Replace legacy any-segment gates with measured whole-route results."""

    updated = copy.deepcopy(criteria)
    updated.setdefault("mand", {})["pbs1"] = bool(unit["pbs1"])
    updated["mand"]["bdouble"] = bool(unit["bdouble"])
    updated["optMet"] = optional_count(updated.get("opt") or {})
    updated["verdict"] = verdict_of(updated)
    return updated


def apply_state_dest(criteria: dict, result: dict) -> dict:
    updated = copy.deepcopy(criteria)
    updated.setdefault("stateOpt", {}).update(state_metadata(result))
    if updated.get("cls") == "State":
        updated.setdefault("opt", {})["dest"] = result.get("dest")
        updated["optMet"] = optional_count(updated["opt"])
        updated["verdict"] = verdict_of(updated)
    return updated


def apply_regional_dest(criteria: dict, unit: dict, evidence: dict) -> dict:
    """Apply R-02/R-06 from exact centre and network-backed facility evidence."""
    updated = copy.deepcopy(criteria)
    area = "urban" if unit["zone"] == "urban" else "rural"
    allowed_types = REGIONAL_URBAN_CENTRE_TYPES if area == "urban" else REGIONAL_RURAL_CENTRE_TYPES
    centres = centre_names(evidence, allowed_types)
    result = facility_metadata(unit, centres, regional_facilities(evidence, unit["zone"]), "dest")
    result.update({
        "dest_employment_assessment_basis": EMPLOYMENT_ASSESSMENT_BASIS,
        "dest_employment_size_threshold_ha": employment_size_threshold(unit["zone"]),
    })
    updated.setdefault("regionalOpt", {}).update(result)
    if updated.get("cls") == "Regional":
        updated.setdefault("opt", {})["dest"] = result["dest"]
        updated["optMet"] = optional_count(updated["opt"])
        updated["verdict"] = verdict_of(updated)
    return updated


def build_split_criteria(
    unit: dict,
    evidence: dict,
    legacy: dict,
    nhvr: dict,
    road_ext: dict,
    zone: str,
    nltn_values: list,
    network_state_dest: dict | None = None,
) -> dict:
    area = "urban" if zone == "urban" else "rural"
    state_centres = centre_names(evidence, STATE_CENTRE_TYPES)
    regional_types = REGIONAL_URBAN_CENTRE_TYPES if area == "urban" else REGIONAL_RURAL_CENTRE_TYPES
    regional_centres = centre_names(evidence, regional_types)
    # S-10/R-05 "connects centres" now excludes the metro capital bubble and holds centres to the
    # zone's Major-Town floor (connectivity_centre_names). State and Regional share the one rule.
    # state_centres / regional_centres above are kept unchanged: they feed the dest (facility→centre)
    # criterion and the detail-card centre lists, not this connectivity option.
    connectivity_centres = connectivity_centre_names(evidence, zone)
    state_centre_pass = len(connectivity_centres) >= 2
    regional_centre_pass = len(connectivity_centres) >= 2

    ldr = state_ldr(unit, evidence, zone)
    if network_state_dest is not None:
        state_dest = state_metadata(network_state_dest)
    else:
        state_dest_facilities = state_facilities(evidence, zone)
        state_dest = facility_metadata(unit, regional_centres, state_dest_facilities, "dest")
        state_dest.update({
            "dest_method": "road_unit_evidence_fallback",
            "dest_network_coverage": None,
            "dest_qualifying_components": ([{
                "component_km": round(unit["length_km"], 1),
                "road_names": unit["road_names"],
                "centre_names": regional_centres,
                "facility_names": state_dest["dest_facility_names"],
                "facility_details": state_dest_facilities,
                "employment_only": bool(state_dest_facilities) and all(item["kind"] == "employment" for item in state_dest_facilities),
            }] if state_dest["dest"] else []),
            "dest_employment_only": bool(state_dest_facilities) and all(item["kind"] == "employment" for item in state_dest_facilities),
            "dest_employment_assessment_basis": EMPLOYMENT_ASSESSMENT_BASIS,
            "dest_employment_size_threshold_ha": employment_size_threshold(zone),
        })
    regional_dest_facilities = regional_facilities(evidence, zone)
    regional_dest = facility_metadata(unit, regional_centres, regional_dest_facilities, "dest")
    regional_dest.update({
        "dest_employment_assessment_basis": EMPLOYMENT_ASSESSMENT_BASIS,
        "dest_employment_size_threshold_ha": employment_size_threshold(zone),
    })

    traffic = None
    road_train = nhvr.get("roadtrain") if isinstance(nhvr.get("roadtrain"), bool) else None
    two_state = road_ext.get("two_state") if area != "urban" else None
    options = {"centres": None, "dest": None, "hv": None, "ldr": None, "traffic": traffic}
    if unit["admin_class"] == "S":
        options.update({
            "centres": state_centre_pass,
            "dest": state_dest["dest"],
            "ldr": ldr["ldr"] if area != "urban" else None,
        })
    else:
        options.update({
            "centres": regional_centre_pass,
            "dest": regional_dest["dest"],
            "hv": road_train if area != "urban" else None,
        })
        if area != "urban":
            options["two_state"] = two_state

    template_mand = copy.deepcopy((legacy or {}).get("mand") or {})
    template_mand["pbs1"] = unit["pbs1"]
    template_mand["bdouble"] = unit["bdouble"]
    if unit["admin_class"] == "S":
        template_mand["parallel"] = road_ext.get("parallel_state_20")

    row = {
        "area": area,
        "cls": "State" if unit["admin_class"] == "S" else "Regional",
        "opt": options,
        "mand": template_mand,
        "nsr": unit["nltn_coverage"] >= 0.5,
        "stateOpt": {
            "centres": state_centre_pass,
            "centre_names": state_centres,
            **ldr,
            **state_dest,
        },
        "regionalOpt": {
            "centres": regional_centre_pass,
            "centre_names": regional_centres,
            **regional_dest,
        },
        "unitAssessment": {
            "method": "connected_component_and_class",
            "source_road_number": unit["source_road_number"],
            "road_names": unit["road_names"],
            "ambiguous_roadwide_values_omitted": ["AADT", "road train", "bypass", "parallel State road"],
        },
    }
    row["optMet"] = optional_count(options)
    row["verdict"] = verdict_of(row)
    port_air = any(
        item.get("ftype") in STATE_DEST_TYPES for item in evidence.get("dests", [])
    )
    row["natCrit"] = {
        "nltn": unit["nltn_coverage"] >= 0.5,
        "metros": state_centre_pass,
        "portair": port_air,
    }
    row["natOptMet"] = sum(value is True for value in row["natCrit"].values())
    row["nat"] = "green" if row["natOptMet"] >= 2 else "orange" if row["natOptMet"] == 1 else "red"
    return row


def export_reason(criteria: dict) -> tuple[str, str]:
    state = criteria["cls"] == "State"
    urban = criteria["area"] == "urban"
    options = criteria["opt"]
    if state:
        centre_code = "S-10" if urban else "S-07"
        dest_code = "S-11" if urban else "S-08"
        why = [
            f"{centre_code}  {'met' if options.get('centres') else 'not met'} (centres)",
        ]
        what = [
            f"{centre_code}  {'PASS' if options.get('centres') else 'fail'} - connects qualifying centres",
        ]
        if not urban:
            why.append(f"LDR  {'met' if options.get('ldr') else 'not met'} (long-distance rural centre-to-town route)")
            what.append(f"LDR  {'PASS' if options.get('ldr') else 'fail'} - unnumbered State long-distance rural centre-to-town route")
        why.extend([
            f"{dest_code}  {'met' if options.get('dest') else 'not met'} (facility-to-centre connection)",
            f"S-09  {'met' if criteria['mand'].get('pbs1') else 'not met'} (mandatory)",
        ])
        what.extend([
            f"{dest_code}  {'PASS' if options.get('dest') else 'fail'} - qualifying facility/employment area connected to another centre type",
            f"S-09  {'PASS' if criteria['mand'].get('pbs1') else 'fail'} - PBS Level 1",
        ])
    else:
        centre_code = "R-05" if urban else "R-01"
        dest_code = "R-06" if urban else "R-02"
        why = [
            f"{centre_code}  {'met' if options.get('centres') else 'not met'} (centres)",
            f"{dest_code}  {'met' if options.get('dest') else 'not met'} (facilities / employment)",
        ]
        what = [
            f"{centre_code}  {'PASS' if options.get('centres') else 'fail'} - connects qualifying centres",
            f"{dest_code}  {'PASS' if options.get('dest') else 'fail'} - qualifying facility/employment centre connected to a centre",
        ]
        if not urban:
            why.extend([
                f"R-03  {'met' if options.get('hv') is True else 'not assessed' if options.get('hv') is None else 'not met'} (road train network)",
                f"Two State  {'met' if options.get('two_state') else 'not met'} (links two State Roads)",
            ])
            what.extend([
                f"R-03  {'PASS' if options.get('hv') is True else 'not assessed' if options.get('hv') is None else 'fail'} - road train access",
                f"Two State  {'PASS' if options.get('two_state') else 'fail'} - links two State Roads",
            ])
        why.append(f"R-04  {'met' if criteria['mand'].get('bdouble') else 'not met'} (mandatory)")
        what.append(f"R-04  {'PASS' if criteria['mand'].get('bdouble') else 'fail'} - 19m B-double access")
    traffic = options.get("traffic")
    why.append(f"Traffic  {'met' if traffic is True else 'not assessed' if traffic is None else 'not met'}")
    what.append(f"Traffic  {'PASS' if traffic is True else 'not assessed' if traffic is None else 'fail'} - AADT and heavy-vehicle thresholds")
    category = {"green": "Meets criteria", "orange": "Likely meets (1 optional)", "red": "Does not meet"}[criteria["verdict"]]
    why.append(f"-> {criteria['optMet']} optional met - {category}")
    return "\n".join(why), "\n".join(what)


def lga_names(units: dict[str, dict], raw_dir: Path) -> dict[str, str]:
    path = raw_dir / "abs_lga_boundaries_2025" / "LGA_2025_AUST_GDA2020.shp"
    if not path.exists():
        return {}
    lgas = gpd.read_file(path).to_crs(PROJECTED_CRS)
    name_column = next(column for column in lgas.columns if "NAME" in column.upper())
    output = {}
    for key, unit in units.items():
        indexes = lgas.sindex.query(unit["geometry"], predicate="intersects")
        names = sorted({str(lgas.iloc[index][name_column]) for index in indexes})
        output[key] = "; ".join(names)
    return output


def declared_group_reason(base: str, rows: list[dict]) -> str | None:
    """Return the auditable reason connected units represent one declared road."""
    if base in DECLARED_KEEP_SEPARATE or len(rows) < 2:
        return None
    classes = {row["admin_class"] for row in rows}
    if len(classes) != 1:
        return None
    road_number = rows[0].get("source_road_number") or ""
    if rows[0]["admin_class"] == "S" and road_number.isdigit():
        number = int(road_number)
        if 1 <= number <= 31:
            return "official State Highway number"
    if road_number.isdigit():
        return "same classified road number and current class"
    return None


def merge_evidence(rows: list[dict]) -> dict:
    """Merge section evidence into one declared-road evidence set without duplicates."""
    output = {}
    for evidence in rows:
        for bucket, items in (evidence or {}).items():
            if not isinstance(items, list):
                continue
            merged = output.setdefault(bucket, {})
            for item in items:
                key = (
                    str(item.get("zoneId") or item.get("source_id") or ""),
                    str(item.get("kind") or item.get("ftype") or item.get("cat") or ""),
                    str(item.get("name") or ""),
                    str(item.get("lon") or ""),
                    str(item.get("lat") or ""),
                )
                current = merged.get(key)
                distance = item.get("distance_m")
                if not isinstance(distance, (int, float)):
                    distance = float(item.get("km") or 0) * 1000.0
                current_distance = math.inf
                if current is not None:
                    current_distance = current.get("distance_m")
                    if not isinstance(current_distance, (int, float)):
                        current_distance = float(current.get("km") or 0) * 1000.0
                if current is None or distance < current_distance:
                    merged[key] = copy.deepcopy(item)
                elif item.get("endpoint"):
                    current["endpoint"] = True
    return {
        bucket: sorted(items.values(), key=lambda item: (
            str(item.get("name") or ""),
            float(item.get("distance_m") or (float(item.get("km") or 0) * 1000.0)),
        ))
        for bucket, items in output.items()
    }


def combined_boolean(values: list) -> bool | None:
    known = [value for value in values if isinstance(value, bool)]
    if any(value is False for value in known):
        return False
    if known and len(known) == len(values):
        return True
    return None


def build_declared_roads(
    source_units: dict[str, list[dict]],
    units: dict[str, dict],
    features: list,
    unit_criteria: dict,
    unit_evidence: dict,
    unit_nhvr: dict,
    unit_adt: dict,
    unit_ext: dict,
    legacy_criteria: dict,
    legacy_nhvr: dict,
    legacy_adt: dict,
    legacy_ext: dict,
    legacy_zone: dict,
    urbanity: list,
    newell_segments: list[tuple],
) -> tuple[dict, dict, dict, dict, dict, dict, dict, dict]:
    """Build the official-road assessment layer above connected map sections."""
    roads = {}
    criteria = {}
    evidence = {}
    nhvr = {}
    adt = {}
    road_ext = {}
    zones = {}
    section_to_road = {}

    for base, source_rows in source_units.items():
        ordered = sorted(source_rows, key=lambda row: row["unit_ordinal"])
        reason = declared_group_reason(base, ordered)
        groups = [(base, ordered, reason)] if reason else [
            (row["key"], [row], "connected section retained as its own assessment")
            for row in ordered
        ]
        for key, members, group_reason in groups:
            feature_indexes = sorted({
                index for member in members for index in member["feature_indexes"]
            })
            combined = {
                "key": key,
                "source_key": base,
                "source_road_number": members[0]["source_road_number"],
                "admin_class": members[0]["admin_class"],
                "feature_indexes": feature_indexes,
                "geometry": unary_union([member["geometry"] for member in members]),
                "length_km": sum(member["length_km"] for member in members),
                "feature_lengths": members[0]["feature_lengths"],
                "features_wgs84": members[0]["features_wgs84"],
                "road_names": [],
                "primary_name": "",
                "refs": sorted({ref for member in members for ref in member["refs"]}),
                "zones": sorted({member["zone"] for member in members}),
                "member_units": [member["key"] for member in members],
                "section_count": len(members),
                "group_reason": group_reason,
                "pbs1_coverage": round(
                    sum(member["length_km"] * member["pbs1_coverage"] for member in members)
                    / sum(member["length_km"] for member in members), 6
                ),
                "bdouble_coverage": round(
                    sum(member["length_km"] * member["bdouble_coverage"] for member in members)
                    / sum(member["length_km"] for member in members), 6
                ),
                "nltn_coverage": round(
                    sum(member["length_km"] * member["nltn_coverage"] for member in members)
                    / sum(member["length_km"] for member in members), 6
                ),
            }
            combined["zone"] = unit_zone(combined, urbanity, newell_segments)
            combined["pbs1"] = combined["pbs1_coverage"] > ACCESS_COVERAGE
            combined["bdouble"] = combined["bdouble_coverage"] >= ACCESS_COVERAGE
            combined["road_names"] = names_by_length(combined, features)
            combined["primary_name"] = combined["road_names"][0] if combined["road_names"] else ""
            roads[key] = combined
            zones[key] = combined["zone"]
            for ordinal, member in enumerate(members, 1):
                section_to_road[member["key"]] = key
                for index in member["feature_indexes"]:
                    properties = features[index]["properties"]
                    properties["declared_road"] = key
                    properties["declared_primary_name"] = combined["primary_name"]
                    properties["declared_section_count"] = len(members)
                    properties["declared_section_ordinal"] = ordinal

            if len(members) > 1:
                row = copy.deepcopy(legacy_criteria.get(base) or {})
                if not row:
                    raise RuntimeError(f"Declared road {key} has no road-level criteria")
                row.pop("unitAssessment", None)
                row.setdefault("mand", {})["pbs1"] = combined["pbs1"]
                row["mand"]["bdouble"] = combined["bdouble"]
                row["optMet"] = optional_count(row.get("opt") or {})
                row["verdict"] = verdict_of(row)
            else:
                row = copy.deepcopy(unit_criteria[members[0]["key"]])
            row["declaredAssessment"] = {
                "method": "official road above connected map sections",
                "group_reason": group_reason,
                "source_road_number": combined["source_road_number"],
                "member_units": combined["member_units"],
                "section_results": [
                    {
                        "unit": member["key"],
                        "name": member["primary_name"],
                        "length_km": round(member["length_km"], 1),
                        "zone": member["zone"],
                        "verdict": unit_criteria[member["key"]].get("verdict"),
                    }
                    for member in members
                ],
            }
            criteria[key] = row
            evidence[key] = merge_evidence([
                unit_evidence.get(member["key"], {}) for member in members
            ])

            if len(members) > 1:
                nhvr_row = copy.deepcopy(legacy_nhvr.get(base, {}))
                nhvr_row["pbs1"] = combined["pbs1"]
                nhvr_row["pbs1Coverage"] = combined["pbs1_coverage"]
                nhvr_row["bdouble19"] = combined["bdouble"]
                nhvr_row["bdouble19Coverage"] = combined["bdouble_coverage"]
                nhvr_row["source_scope"] = "declared_road_all_sections"
                nhvr[key] = nhvr_row
                measured = combine_adt_rows([
                    unit_adt.get(member["key"]) for member in members
                ])
                if measured:
                    adt[key] = measured
                road_ext[key] = copy.deepcopy(legacy_ext.get(base, {}))
            else:
                member_key = members[0]["key"]
                nhvr[key] = copy.deepcopy(unit_nhvr.get(member_key, {}))
                if member_key in unit_adt:
                    adt[key] = copy.deepcopy(unit_adt[member_key])
                road_ext[key] = copy.deepcopy(unit_ext.get(member_key, {}))

    # A declared road's evidence is the union of its mapped sections. If that road's
    # old criteria row belongs to a different urban/rural family than its freshly
    # derived zone, rebuild the row from the final geometry and merged evidence.
    # Facility options remain component-safe: at least one mapped section must have
    # passed the corresponding facility connection test.
    for key, road in roads.items():
        row = criteria[key]
        expected_area = criteria_area(road["zone"])
        if row.get("area") == expected_area:
            continue
        old_assessment = copy.deepcopy(row.get("declaredAssessment") or {})
        old_options = copy.deepcopy(row.get("opt") or {})
        rebuilt = build_split_criteria(
            road,
            evidence[key],
            row,
            nhvr[key],
            road_ext[key],
            road["zone"],
            [],
        )
        member_rows = [unit_criteria[unit_key] for unit_key in road["member_units"]]
        if rebuilt.get("cls") == "State":
            component_dest = any(
                (member.get("stateOpt") or {}).get("dest") is True
                for member in member_rows
            )
            rebuilt.setdefault("stateOpt", {})["dest"] = component_dest
            rebuilt.setdefault("opt", {})["dest"] = component_dest
        else:
            component_dest = any(
                (member.get("regionalOpt") or {}).get("dest") is True
                for member in member_rows
            )
            rebuilt.setdefault("regionalOpt", {})["dest"] = component_dest
            rebuilt.setdefault("opt", {})["dest"] = component_dest
        if "traffic" in old_options:
            rebuilt.setdefault("opt", {})["traffic"] = old_options["traffic"]
        rebuilt["optMet"] = optional_count(rebuilt.get("opt") or {})
        rebuilt["verdict"] = verdict_of(rebuilt)
        rebuilt["declaredAssessment"] = old_assessment
        rebuilt["declaredAssessment"]["criteria_family_rebuilt_from_zone"] = True
        criteria[key] = rebuilt

    return roads, criteria, evidence, nhvr, adt, road_ext, zones, section_to_road


def validate_outputs(
    features: list,
    units: dict[str, dict],
    source_units: dict[str, list[dict]],
    criteria: dict,
    evidence: dict,
    nhvr: dict,
    road_ext: dict,
    zones: dict,
    recat: list,
    exports: dict,
    adt: dict,
    legacy_criteria: dict,
    legacy_recat: list,
    network_state_dest: dict[str, dict],
    regional_dest_changed: set[str],
) -> None:
    unit_keys = set(units)
    for label, mapping in (
        ("criteria", criteria),
        ("evidence", evidence),
        ("NHVR", nhvr),
        ("road extensions", road_ext),
        ("zones", zones),
    ):
        if set(mapping) != unit_keys:
            missing = sorted(unit_keys - set(mapping))[:5]
            extra = sorted(set(mapping) - unit_keys)[:5]
            raise RuntimeError(f"{label} unit-key mismatch; missing={missing}, extra={extra}")
    if len(recat) != len(features):
        raise RuntimeError("Unit recategorisation length differs from assessment geometry")
    for index, feature in enumerate(features):
        properties = feature["properties"]
        key = properties.get("road_unit")
        if properties.get("unit_excluded"):
            if key:
                raise RuntimeError(f"Excluded feature {index} still has road unit {key!r}")
            if recat[index] != legacy_recat[index]:
                raise RuntimeError(f"Excluded feature {index} did not retain its source verdict")
            continue
        if key not in unit_keys:
            raise RuntimeError(f"Feature {index} has unknown road unit {key!r}")
        if recat[index] != criteria[key].get("verdict"):
            raise RuntimeError(f"Feature {index} recategorisation disagrees with {key}")
    for key, row in criteria.items():
        expected_area = criteria_area(zones[key])
        if row.get("area") != expected_area:
            raise RuntimeError(
                f"Unit criteria family disagrees with zone for {key}: "
                f"zone={zones[key]!r}, area={row.get('area')!r}"
            )
        if optional_count(row.get("opt") or {}) != row.get("optMet"):
            raise RuntimeError(f"Optional count does not reproduce for {key}")
        if verdict_of(row) != row.get("verdict"):
            raise RuntimeError(f"Verdict does not reproduce for {key}")
    for base, rows in source_units.items():
        if len(rows) == 1 and rows[0]["key"] not in network_state_dest:
            key = rows[0]["key"]
            current = copy.deepcopy(criteria[key])
            legacy = copy.deepcopy(legacy_criteria.get(base) or {})
            current.pop("regionalOpt", None)
            legacy.pop("regionalOpt", None)
            for candidate in (current, legacy):
                candidate.setdefault("opt", {}).pop("traffic", None)
                candidate["optMet"] = optional_count(candidate["opt"])
                candidate["verdict"] = verdict_of(candidate)
            if key not in regional_dest_changed and current != legacy:
                raise RuntimeError(f"Single-unit road {base} changed outside Regional evidence")
        if len(rows) > 1:
            for row in rows:
                measured = adt.get(row["key"])
                if measured and measured.get("match_method") not in {
                    "administrative_id_and_geometry",
                    "road_name_and_geometry",
                    "overlapping_road_name_and_geometry",
                }:
                    raise RuntimeError(f"Split road {base} retained ambiguous road-wide AADT")
    for key, result in network_state_dest.items():
        state_opt = criteria[key].get("stateOpt") or {}
        if state_opt.get("dest") != result.get("dest"):
            raise RuntimeError(f"Unit State facility result did not transfer for {key}")
        if state_opt.get("dest_method") != "nsw_road_segment_network":
            raise RuntimeError(f"Unit State facility method missing for {key}")
        evidence_names = {
            str(item.get("name") or "")
            for item in evidence[key].get("centres", [])
        }
        if not set(result.get("all_centre_names") or []) <= evidence_names:
            raise RuntimeError(f"Unit State facility centre evidence is incomplete for {key}")
    exported_keys = {
        row.get("_key")
        for tab in ("state", "regional")
        for row in exports.get(tab, [])
    }
    if exported_keys != unit_keys:
        raise RuntimeError("Unit export rows do not match dashboard road units")
    expected_57 = {
        ("R", "WEST WYALONG-CONDOBOLIN", ()),
        ("R", "TULLAMORE-NYNGAN", ()),
        ("S", "GOLDFIELDS", ("B85",)),
    }
    actual_57 = {
        (unit["admin_class"], unit["primary_name"], tuple(unit["refs"]))
        for unit in source_units.get("0000057", [])
    }
    if actual_57 != expected_57:
        raise RuntimeError(f"Road 0000057 unit regression: {sorted(actual_57)}")
    kamilaroi = criteria.get("0000029~S01", {}).get("stateOpt") or {}
    if kamilaroi.get("dest") is not True:
        raise RuntimeError("Kamilaroi unit 0000029~S01 must pass network-backed S-08")
    if not {"Bourke", "Walgett"} <= set(kamilaroi.get("dest_centre_names") or []):
        raise RuntimeError("Kamilaroi S-08 is missing Bourke/Walgett centre evidence")
    if not {"Bourke District Hospital", "Walgett Health Service"} <= set(
        kamilaroi.get("dest_facility_names") or []
    ):
        raise RuntimeError("Kamilaroi S-08 is missing its connected hospitals")
    grenfell_orange = criteria.get("0000237~R02", {})
    if (grenfell_orange.get("regionalOpt") or {}).get("dest") is not True:
        raise RuntimeError("Grenfell-Orange unit 0000237~R02 must pass network-backed R-02")
    grenfell_access = [
        item for item in evidence.get("0000237~R02", {}).get("employment", [])
        if item.get("size_qualifies") is True and item.get("network_access") is True
    ]
    if not grenfell_access:
        raise RuntimeError("Grenfell-Orange R-02 is missing its local-road employment access path")
    cowpasture = criteria.get("0000648~S01", {}).get("stateOpt") or {}
    if cowpasture.get("dest") is not True:
        raise RuntimeError("Cowpasture S-11 must pass from the intersecting official ELDM precinct")
    cowpasture_employment = evidence.get("0000648~S01", {}).get("employment", [])
    hoxton_park = [
        item for item in cowpasture_employment
        if item.get("source_id") == "GS234"
        and item.get("official_precinct") is True
        and item.get("relation") == "intersects"
        and item.get("size_qualifies") is True
    ]
    nearby_wetherill_park = [
        item for item in cowpasture_employment
        if item.get("source_id") == "GS144" and item.get("relation") == "nearby"
    ]
    if not hoxton_park or not nearby_wetherill_park:
        raise RuntimeError("Cowpasture employment evidence is missing exact ELDM polygon relationships")


def validate_declared_outputs(
    features: list,
    roads: dict,
    criteria: dict,
    evidence: dict,
    nhvr: dict,
    road_ext: dict,
    zones: dict,
    recat: list,
    exports: dict,
    section_to_road: dict,
) -> None:
    road_keys = set(roads)
    for label, mapping in (
        ("criteria", criteria),
        ("evidence", evidence),
        ("NHVR", nhvr),
        ("road extensions", road_ext),
        ("zones", zones),
    ):
        if set(mapping) != road_keys:
            raise RuntimeError(f"Declared {label} keys do not match declared roads")
    if len(recat) != len(features):
        raise RuntimeError("Declared recategorisation length differs from assessment geometry")
    for index, feature in enumerate(features):
        properties = feature["properties"]
        if properties.get("unit_excluded"):
            continue
        key = properties.get("declared_road")
        if key not in road_keys:
            raise RuntimeError(f"Feature {index} has unknown declared road {key!r}")
        if section_to_road.get(properties.get("road_unit")) != key:
            raise RuntimeError(f"Feature {index} section-to-road mapping disagrees")
        if recat[index] != criteria[key].get("verdict"):
            raise RuntimeError(f"Feature {index} declared verdict disagrees with {key}")
    for key, row in criteria.items():
        expected_area = criteria_area(zones[key])
        if row.get("area") != expected_area:
            raise RuntimeError(
                f"Declared criteria family disagrees with zone for {key}: "
                f"zone={zones[key]!r}, area={row.get('area')!r}"
            )
        if optional_count(row.get("opt") or {}) != row.get("optMet"):
            raise RuntimeError(f"Declared optional count does not reproduce for {key}")
        if verdict_of(row) != row.get("verdict"):
            raise RuntimeError(f"Declared verdict does not reproduce for {key}")
    exported_keys = {
        row.get("_key")
        for tab in ("state", "regional")
        for row in exports.get(tab, [])
    }
    if exported_keys != road_keys:
        raise RuntimeError("Declared export rows do not match declared roads")

    kamilaroi = roads.get("0000029") or {}
    if kamilaroi.get("member_units") != [
        "0000029~S01", "0000029~S02", "0000029~S03", "0000029~S04"
    ]:
        raise RuntimeError("Kamilaroi must be one declared road with four mapped sections")
    if criteria.get("0000029", {}).get("verdict") != "green":
        raise RuntimeError("Kamilaroi declared-road assessment must meet the criteria")

    road_57 = {
        section_to_road.get("0000057~R01"),
        section_to_road.get("0000057~R02"),
        section_to_road.get("0000057~S01"),
    }
    if road_57 != {"0000057~R01", "0000057~R02", "0000057~S01"}:
        raise RuntimeError("Road 0000057 distinct-corridor safeguard regressed")

    mr_241 = roads.get("0000241") or {}
    if mr_241.get("section_count") != 3:
        raise RuntimeError("MR 241 must be one declared Regional road with three mapped sections")

    grenfell_orange = roads.get("0000237") or {}
    if grenfell_orange.get("section_count") != 2:
        raise RuntimeError("Grenfell-Orange must be one declared Regional road")
    grenfell_criteria = criteria.get("0000237", {})
    if (grenfell_criteria.get("regionalOpt") or {}).get("dest") is not True:
        raise RuntimeError("Grenfell-Orange declared-road R-02 must pass")
    if grenfell_criteria.get("verdict") != "red":
        raise RuntimeError("Grenfell-Orange must fail the road-wide B-double gate")

    dungog = criteria.get("0000101", {})
    if zones.get("0000101") != "regional" or dungog.get("area") != "rural":
        raise RuntimeError("Dungog MR 101 must use the Regional-zone R-01/R-02 criteria family")
    if (dungog.get("regionalOpt") or {}).get("centres") is not True:
        raise RuntimeError("Dungog MR 101 must pass its recomputed R-01 centre connection")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-dir", type=Path, default=RAW)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    assessment = read_json("nsw_assessment.geojson")
    features = assessment["features"]
    for feature in features:
        properties = feature["properties"]
        for field in (
            "road_unit",
            "unit_primary_name",
            "unit_count",
            "unit_ordinal",
            "unit_excluded",
            "unit_excluded_reason",
            "declared_road",
            "declared_primary_name",
            "declared_section_count",
            "declared_section_ordinal",
        ):
            properties.pop(field, None)
    refs = read_json("nsw_refs.json")
    urbanity = read_json("nsw_urbanity.json")
    nltn = read_json("nsw_nltn.json")
    recat = read_json("nsw_recat.json")
    overrides = read_json("ref_overrides.json")
    legacy_criteria = read_json("nsw_criteria.json")
    legacy_evidence = read_json("nsw_evidence.json")
    legacy_nhvr = read_json("nhvr_networks.json")
    legacy_adt = read_json("nsw_adt.json")
    legacy_ext = read_json("nsw_road_ext.json")
    legacy_zone = read_json("nsw_zone.json")
    legacy_export = read_json("export_rows.json")

    if not (len(features) == len(refs) == len(urbanity) == len(nltn) == len(recat)):
        raise RuntimeError("Parallel per-segment files have different lengths")

    roads = gpd.GeoDataFrame.from_features(assessment, crs="EPSG:4326")
    roads_projected = roads.to_crs(PROJECTED_CRS)
    projected_geometries = list(roads_projected.geometry)
    wgs84_geometries = list(roads.geometry)
    feature_lengths = {index: geometry.length / 1000.0 for index, geometry in enumerate(projected_geometries)}

    effective_refs = [
        effective_ref(features[index]["properties"], refs[index], overrides)
        for index in range(len(features))
    ]
    newell_segments = []
    for index, feature in enumerate(features):
        properties = feature["properties"]
        if effective_refs[index] != "A39" and "NEWELL" not in str(properties.get("road_name") or "").upper():
            continue
        for line in lines_of(wgs84_geometries[index]):
            coords = list(line.coords)
            newell_segments.extend(zip(coords[:-1], coords[1:]))

    grouped_indexes = defaultdict(list)
    for index, feature in enumerate(features):
        base = source_key(feature["properties"])
        if base:
            grouped_indexes[(base, feature["properties"].get("admin_class") or "")].append(index)

    provisional = defaultdict(list)
    for (base, admin_class), indexes in grouped_indexes.items():
        geometries = [projected_geometries[index] for index in indexes]
        for member_indexes in connected_groups(geometries):
            feature_indexes = [indexes[member] for member in member_indexes]
            lines = [projected_geometries[index] for index in feature_indexes]
            geometry = unary_union(lines)
            provisional[base].append({
                "source_key": base,
                "source_road_number": base if not base.startswith("n:") else "",
                "admin_class": admin_class,
                "feature_indexes": feature_indexes,
                "geometry": geometry,
                "length_km": sum(feature_lengths[index] for index in feature_indexes),
                "terminal_points": terminal_points(lines),
                "feature_lengths": feature_lengths,
                "features_wgs84": wgs84_geometries,
            })

    provisional = {
        base: coalesce_source_components(rows, features, effective_refs)
        for base, rows in provisional.items()
    }

    # A few administrative IDs contain tiny disconnected ramps, junction links or
    # digitising leftovers. They remain in the source geometry, but do not become
    # independent assessments when that ID also has a substantial component.
    excluded_components = []
    filtered_provisional = {}
    for base, rows in provisional.items():
        if len(rows) <= 1:
            filtered_provisional[base] = rows
            continue
        kept = [row for row in rows if row["length_km"] >= MICRO_COMPONENT_KM]
        if not kept:
            kept = [max(rows, key=lambda row: row["length_km"])]
        kept_ids = {id(row) for row in kept}
        excluded = [row for row in rows if id(row) not in kept_ids]
        for row in excluded:
            excluded_components.append(row)
            for index in row["feature_indexes"]:
                properties = features[index]["properties"]
                properties["unit_excluded"] = 1
                properties["unit_excluded_reason"] = "disconnected component under 0.35 km"
        filtered_provisional[base] = kept
    provisional = filtered_provisional

    units = {}
    source_units = defaultdict(list)
    for base, rows in provisional.items():
        total_units = len(rows)
        class_counts = Counter(row["admin_class"] for row in rows)
        class_seen = Counter()
        ordered = sorted(rows, key=lambda row: (
            row["admin_class"],
            -row["geometry"].centroid.y,
            row["geometry"].centroid.x,
        ))
        for unit_ordinal, row in enumerate(ordered, 1):
            class_seen[row["admin_class"]] += 1
            if total_units == 1:
                key = base
            else:
                key = f"{base}~{row['admin_class']}{class_seen[row['admin_class']]:02d}"
            row["key"] = key
            row["unit_count"] = total_units
            row["unit_ordinal"] = unit_ordinal
            row["class_unit_count"] = class_counts[row["admin_class"]]
            row["road_names"] = names_by_length(row, features)
            row["primary_name"] = row["road_names"][0] if row["road_names"] else ""
            row["refs"] = sorted({effective_refs[index] for index in row["feature_indexes"] if effective_refs[index]})
            row["nltn_coverage"] = round(
                sum(feature_lengths[index] for index in row["feature_indexes"] if nltn[index]) / row["length_km"], 3
            ) if row["length_km"] else 0.0
            row["pbs1"], row["pbs1_coverage"] = weighted_flag(row, features, "has_pbs1")
            row["bdouble"], row["bdouble_coverage"] = weighted_flag(row, features, "has_bdouble")
            # Always derive the zone from the final component geometry. The legacy
            # road-wide zone can disagree with ABS Section-of-State after splits or
            # source refreshes and must never choose the criteria family.
            row["zone"] = unit_zone(row, urbanity, newell_segments)
            units[key] = row
            source_units[base].append(row)
            for index in row["feature_indexes"]:
                properties = features[index]["properties"]
                properties["road_unit"] = key
                properties["unit_primary_name"] = row["primary_name"]
                properties["unit_count"] = total_units
                properties["unit_ordinal"] = unit_ordinal

    state_units = [unit for unit in units.values() if unit["admin_class"] == "S"]
    unit_ext = {}
    for key, unit in units.items():
        if unit["unit_count"] == 1:
            unit_ext[key] = copy.deepcopy(legacy_ext.get(unit["source_key"], {}))
            continue
        row = {}
        if unit["admin_class"] == "R":
            touches = {}
            for endpoint in unit["terminal_points"]:
                for state in state_units:
                    if endpoint.distance(state["geometry"]) <= TWO_STATE_TOUCH_M:
                        touches[state["key"]] = {
                            "unit": state["key"],
                            "road_number": state["source_road_number"],
                            "name": state["primary_name"],
                        }
            row["two_state"] = len(touches) >= 2
            row["two_state_touches"] = sorted(touches.values(), key=lambda item: item["unit"])
        unit_ext[key] = row

    unit_evidence = {}
    for base, rows in source_units.items():
        if len(rows) == 1:
            unit_evidence[rows[0]["key"]] = copy.deepcopy(legacy_evidence.get(base, {}))
        else:
            unit_evidence.update(attach_evidence(legacy_evidence.get(base, {}), rows))

    employment_centres = derive_centres(employment_source_path(args.raw_dir))
    exact_employment = employment_evidence(units, employment_centres)
    for key in units:
        unit_evidence[key]["employment"] = exact_employment[key]
    regional_access = read_json(REGIONAL_ACCESS_OUTPUT)
    regional_access_applied = apply_access_results(unit_evidence, regional_access)

    unit_state_dest, unit_state_dest_audit = assess_unit_state_dest(
        source_units,
        unit_evidence,
        args.raw_dir,
        features,
        projected_geometries,
        employment_centres,
    )

    unit_nhvr = {}
    unit_adt = {}
    unit_zone_values = {}
    unit_criteria = {}
    regional_dest_changed = set()
    for key, unit in units.items():
        base = unit["source_key"]
        unit_zone_values[key] = unit["zone"]
        if unit["unit_count"] == 1:
            unit_nhvr[key] = copy.deepcopy(legacy_nhvr.get(base, {}))
            unit_nhvr[key]["pbs1"] = unit["pbs1"]
            unit_nhvr[key]["pbs1Coverage"] = unit["pbs1_coverage"]
            unit_nhvr[key]["bdouble19"] = unit["bdouble"]
            unit_nhvr[key]["bdouble19Coverage"] = unit["bdouble_coverage"]
            if base in legacy_adt:
                unit_adt[key] = copy.deepcopy(legacy_adt[base])
            legacy_row = copy.deepcopy(legacy_criteria.get(base, {}))
            if legacy_row.get("area") != criteria_area(unit["zone"]):
                own_criteria = build_split_criteria(
                    unit,
                    unit_evidence.get(key, {}),
                    legacy_row,
                    unit_nhvr[key],
                    unit_ext[key],
                    unit["zone"],
                    [nltn[index] for index in unit["feature_indexes"]],
                    unit_state_dest.get(key),
                )
                own_criteria.setdefault("unitAssessment", {})["criteria_family_rebuilt_from_zone"] = True
            else:
                own_criteria = apply_state_dest(
                    legacy_row,
                    unit_state_dest[key],
                ) if key in unit_state_dest else legacy_row
        else:
            unit_nhvr[key] = {
                "pbs1": unit["pbs1"],
                "pbs1Coverage": unit["pbs1_coverage"],
                "bdouble19": unit["bdouble"],
                "bdouble19Coverage": unit["bdouble_coverage"],
                "source_scope": "road_unit_segment_flags",
            }
            own_criteria = build_split_criteria(
                unit,
                unit_evidence.get(key, {}),
                legacy_criteria.get(base, {}),
                unit_nhvr[key],
                unit_ext[key],
                unit["zone"],
                [nltn[index] for index in unit["feature_indexes"]],
                unit_state_dest.get(key),
            )
        own_criteria = apply_measured_mandatory_gates(own_criteria, unit)
        before_dest = (own_criteria.get("regionalOpt") or {}).get("dest")
        before_verdict = own_criteria.get("verdict")
        unit_criteria[key] = apply_measured_mandatory_gates(apply_regional_dest(
            own_criteria,
            unit,
            unit_evidence.get(key, {}),
        ), unit)
        if (
            before_dest != (unit_criteria[key].get("regionalOpt") or {}).get("dest")
            or before_verdict != unit_criteria[key].get("verdict")
        ):
            regional_dest_changed.add(key)

    # Rebuild measured traffic evidence from the raw TfNSW station files. This
    # replaces the legacy road-wide "busiest historical count" values with the
    # newest completed-year observation located to each connected road unit.
    base_adt, unit_adt, adt_audit = build_measured_adt(
        features,
        projected_geometries,
        args.raw_dir,
    )
    apply_traffic_criteria(unit_criteria, unit_adt)

    unit_recat = []
    for index, feature in enumerate(features):
        key = feature["properties"].get("road_unit")
        unit_recat.append(unit_criteria[key].get("verdict", recat[index]) if key else recat[index])

    lgas = lga_names(units, args.raw_dir)
    export_lookup = {}
    for tab in ("state", "regional"):
        for row in legacy_export.get(tab, []):
            export_lookup[str(row.get("Road ID") or "").strip()] = row
    export_rows = {"natsig": copy.deepcopy(legacy_export.get("natsig", [])), "state": [], "regional": []}
    category = {"green": "Meets criteria", "orange": "Likely meets (1 optional)", "red": "Does not meet"}
    zone_label = {"urban": "Urban", "regional": "Regional", "remote": "Remote (west of Newell Hwy)"}
    for key, unit in sorted(units.items(), key=lambda item: (item[1]["admin_class"], item[1]["primary_name"], item[0])):
        criteria = unit_criteria.get(key)
        if not criteria:
            continue
        base = unit["source_key"]
        if (
            unit["unit_count"] == 1
            and base in export_lookup
            and key not in unit_state_dest
            and key not in regional_dest_changed
            and (legacy_criteria.get(base, {}).get("mand") or {}).get("pbs1") is unit["pbs1"]
            and (legacy_criteria.get(base, {}).get("mand") or {}).get("bdouble") is unit["bdouble"]
        ):
            row = copy.deepcopy(export_lookup[base])
            row["_key"] = key
        else:
            evidence = unit_evidence.get(key, {})
            connected = []
            for bucket in ("centres", "hospitals", "dests", "employment"):
                connected.extend(str(item.get("name")) for item in evidence.get(bucket, []) if item.get("name"))
            why, what = export_reason(criteria)
            nhvr = unit_nhvr.get(key, {})
            adt = unit_adt.get(key)
            aliases = unit["road_names"][1:4]
            road_name = unit["primary_name"] or ("State road" if unit["admin_class"] == "S" else "Regional road")
            if aliases:
                road_name += " (also " + ", ".join(aliases) + (", ..." if len(unit["road_names"]) > 4 else "") + ")"
            row = {
                "Road Name": road_name,
                "Connects To": "; ".join(dict.fromkeys(connected)),
                "Categorisation": category[criteria["verdict"]],
                "Why": why,
                "What (criteria tested)": what,
                "HV Networks (NHVR)": "\n".join([
                    "B-double 19m: " + ("yes" if nhvr.get("bdouble19") is True else "no" if nhvr.get("bdouble19") is False else "not assessed"),
                    "Road train (32m): " + ("yes" if nhvr.get("roadtrain") is True else "no" if nhvr.get("roadtrain") is False else "not assessed for this unit"),
                    "HV bypass: " + ("yes" if nhvr.get("bypass") is True else "no" if nhvr.get("bypass") is False else "not assessed for this unit"),
                ]),
                "AADT (TfNSW)": (f"{adt['aadt']:,} veh/day ({adt['year']})" if adt else "Not located to this road unit"),
                "Zone": zone_label.get(unit["zone"], ""),
                "Road ID": unit["source_road_number"] or base,
                "LGA(s) Touched": lgas.get(key, ""),
                "Length (km)": round(unit["length_km"], 1),
                "_v": criteria["verdict"],
                "_key": key,
            }
        target = "state" if unit["admin_class"] == "S" else "regional"
        export_rows[target].append(row)

    (
        declared_roads,
        declared_criteria,
        declared_evidence,
        declared_nhvr,
        declared_adt,
        declared_ext,
        declared_zones,
        section_to_road,
    ) = build_declared_roads(
        source_units,
        units,
        features,
        unit_criteria,
        unit_evidence,
        unit_nhvr,
        unit_adt,
        unit_ext,
        legacy_criteria,
        legacy_nhvr,
        legacy_adt,
        legacy_ext,
        legacy_zone,
        urbanity,
        newell_segments,
    )
    apply_traffic_criteria(declared_criteria, declared_adt)
    declared_recat = []
    for index, feature in enumerate(features):
        key = feature["properties"].get("declared_road")
        declared_recat.append(
            declared_criteria[key].get("verdict", recat[index]) if key else recat[index]
        )

    declared_lgas = lga_names(declared_roads, args.raw_dir)
    unit_export_lookup = {
        row.get("_key"): row
        for tab in ("state", "regional")
        for row in export_rows.get(tab, [])
    }
    declared_exports = {
        "natsig": copy.deepcopy(legacy_export.get("natsig", [])),
        "state": [],
        "regional": [],
    }
    for key, road in sorted(
        declared_roads.items(),
        key=lambda item: (item[1]["admin_class"], item[1]["primary_name"], item[0]),
    ):
        road_criteria = declared_criteria[key]
        if road["section_count"] == 1 and road["member_units"][0] in unit_export_lookup:
            row = copy.deepcopy(unit_export_lookup[road["member_units"][0]])
            row["_key"] = key
            row["Mapped Sections"] = 1
        else:
            road_evidence = declared_evidence.get(key, {})
            connected = []
            for bucket in ("centres", "hospitals", "dests", "employment"):
                connected.extend(
                    str(item.get("name"))
                    for item in road_evidence.get(bucket, [])
                    if item.get("name")
                )
            why, what = export_reason(road_criteria)
            road_nhvr = declared_nhvr.get(key, {})
            road_adt = declared_adt.get(key)
            aliases = road["road_names"][1:4]
            road_name = road["primary_name"] or (
                "State road" if road["admin_class"] == "S" else "Regional road"
            )
            if aliases:
                road_name += " (also " + ", ".join(aliases) + (
                    ", ..." if len(road["road_names"]) > 4 else ""
                ) + ")"
            displayed_zones = "; ".join(
                zone_label.get(value, value.title()) for value in road["zones"]
            )
            row = {
                "Road Name": road_name,
                "Connects To": "; ".join(dict.fromkeys(connected)),
                "Categorisation": category[road_criteria["verdict"]],
                "Why": why,
                "What (criteria tested)": what,
                "HV Networks (NHVR)": "\n".join([
                    "B-double 19m: " + ("yes" if road_nhvr.get("bdouble19") is True else "no" if road_nhvr.get("bdouble19") is False else "not assessed"),
                    "Road train (32m): " + ("yes" if road_nhvr.get("roadtrain") is True else "no" if road_nhvr.get("roadtrain") is False else "not assessed"),
                    "HV bypass: " + ("yes" if road_nhvr.get("bypass") is True else "no" if road_nhvr.get("bypass") is False else "not assessed"),
                ]),
                "AADT (TfNSW)": (
                    f"{road_adt['aadt']:,} veh/day ({road_adt['year']})"
                    if road_adt else "Not located to this declared road"
                ),
                "Zone": displayed_zones,
                "Road ID": road["source_road_number"] or road["source_key"],
                "LGA(s) Touched": declared_lgas.get(key, ""),
                "Length (km)": round(road["length_km"], 1),
                "Mapped Sections": road["section_count"],
                "_v": road_criteria["verdict"],
                "_key": key,
            }
        target = "state" if road["admin_class"] == "S" else "regional"
        declared_exports[target].append(row)

    audit_units = {}
    for key, unit in units.items():
        audit_units[key] = {
            "source_road_number": unit["source_road_number"],
            "admin_class": unit["admin_class"],
            "primary_name": unit["primary_name"],
            "road_names": unit["road_names"],
            "route_refs": unit["refs"],
            "length_km": round(unit["length_km"], 1),
            "zone": unit["zone"],
            "feature_count": len(unit["feature_indexes"]),
            "source_unit_count": unit["unit_count"],
            "source_unit_ordinal": unit["unit_ordinal"],
            "pbs1_coverage": unit["pbs1_coverage"],
            "bdouble_coverage": unit["bdouble_coverage"],
            "nltn_coverage": unit["nltn_coverage"],
        }
        if key in unit_state_dest:
            audit_units[key]["s08_network_coverage"] = unit_state_dest[key]["coverage"]
            audit_units[key]["s08_network_segment_count"] = unit_state_dest[key]["matched_segment_count"]
    split_ids = {base: [unit["key"] for unit in rows] for base, rows in source_units.items() if len(rows) > 1}
    audit = {
        "method": "road number + connected component within 200 m + current classification",
        "minimum_component_km": MICRO_COMPONENT_KM,
        "source_road_count": len(source_units),
        "road_unit_count": len(units),
        "split_source_road_count": len(split_ids),
        "employment_access_pairs_applied": regional_access_applied,
        "regional_destination_results_changed": len(regional_dest_changed),
        "excluded_micro_component_count": len(excluded_components),
        "excluded_micro_feature_count": sum(len(row["feature_indexes"]) for row in excluded_components),
        "unit_state_facility_assessment": unit_state_dest_audit,
        "traffic_assessment": adt_audit,
        "split_source_roads": split_ids,
        "units": audit_units,
    }

    declared_audit_roads = {}
    for key, road in declared_roads.items():
        declared_audit_roads[key] = {
            "source_road_number": road["source_road_number"],
            "admin_class": road["admin_class"],
            "primary_name": road["primary_name"],
            "road_names": road["road_names"],
            "route_refs": road["refs"],
            "length_km": round(road["length_km"], 1),
            "zone": road["zone"],
            "zones": road["zones"],
            "section_count": road["section_count"],
            "group_reason": road["group_reason"],
            "pbs1_coverage": road["pbs1_coverage"],
            "bdouble_coverage": road["bdouble_coverage"],
            "nltn_coverage": road["nltn_coverage"],
            "sections": [
                {
                    "unit": unit_key,
                    "name": units[unit_key]["primary_name"],
                    "road_names": units[unit_key]["road_names"],
                    "route_refs": units[unit_key]["refs"],
                    "length_km": round(units[unit_key]["length_km"], 1),
                    "zone": units[unit_key]["zone"],
                    "verdict": unit_criteria[unit_key]["verdict"],
                }
                for unit_key in road["member_units"]
            ],
        }
    declared_audit = {
        "method": "official road above connected map sections",
        "grouping_rules": [
            "all mapped sections of the same State Highway number (HW1-HW31)",
            "same classified road number and current class",
            "explicit keep-separate exceptions for known reused identifiers",
        ],
        "declared_road_count": len(declared_roads),
        "connected_section_count": len(units),
        "grouped_declared_road_count": sum(
            road["section_count"] > 1 for road in declared_roads.values()
        ),
        "section_to_road": section_to_road,
        "roads": declared_audit_roads,
    }

    validate_outputs(
        features,
        units,
        source_units,
        unit_criteria,
        unit_evidence,
        unit_nhvr,
        unit_ext,
        unit_zone_values,
        unit_recat,
        export_rows,
        unit_adt,
        legacy_criteria,
        recat,
        unit_state_dest,
        regional_dest_changed,
    )
    validate_declared_outputs(
        features,
        declared_roads,
        declared_criteria,
        declared_evidence,
        declared_nhvr,
        declared_ext,
        declared_zones,
        declared_recat,
        declared_exports,
        section_to_road,
    )

    verdicts = Counter(row.get("verdict") for row in unit_criteria.values())
    declared_verdicts = Counter(row.get("verdict") for row in declared_criteria.values())
    print(f"source roads: {len(source_units):,}")
    print(f"road units: {len(units):,}")
    print(f"source IDs split: {len(split_ids):,}")
    print(
        f"micro components excluded: {len(excluded_components):,} "
        f"({sum(len(row['feature_indexes']) for row in excluded_components):,} features)"
    )
    print(
        "unit S-08/S-11 network assessments: "
        f"{unit_state_dest_audit['units']:,} units across "
        f"{unit_state_dest_audit['source_ids']:,} source IDs"
    )
    print(f"unit verdicts: {dict(verdicts)}")
    print(
        "measured ADT: "
        f"{len(unit_adt):,} units from {adt_audit['matched_station_observations']:,} "
        f"matched TfNSW stations across {adt_audit['matched_station_assignments']:,} "
        f"road assignments (through {adt_audit['latest_complete_year']})"
    )
    print(f"ADT match methods: {adt_audit['match_methods']}")
    print(
        f"declared roads: {len(declared_roads):,} "
        f"({declared_audit['grouped_declared_road_count']:,} span multiple mapped sections)"
    )
    print(f"declared roads with measured ADT: {len(declared_adt):,}")
    print(f"declared-road verdicts: {dict(declared_verdicts)}")
    print("validation: unit and declared-road keys, verdicts, segment colours and exports agree")
    for base in ("0000057",):
        print(f"{base} units:")
        for unit in source_units.get(base, []):
            criteria = unit_criteria[unit["key"]]
            print(
                f"  {unit['key']} {unit['admin_class']} {unit['primary_name']} "
                f"refs={unit['refs']} names={unit['road_names']} {unit['length_km']:.1f} km "
                f"zone={unit['zone']} verdict={criteria.get('verdict')}"
            )

    if not args.apply:
        print("dry run only; use --apply to write unit data")
        return

    write_json("nsw_assessment.geojson", assessment)
    write_json("nsw_adt.json", base_adt)
    write_json("nsw_road_units.json", audit)
    write_json("nsw_unit_criteria.json", unit_criteria)
    write_json("nsw_unit_evidence.json", unit_evidence)
    write_json("nsw_unit_nhvr.json", unit_nhvr)
    write_json("nsw_unit_adt.json", unit_adt)
    write_json("nsw_unit_road_ext.json", unit_ext)
    write_json("nsw_unit_zone.json", unit_zone_values)
    write_json("nsw_unit_recat.json", unit_recat)
    write_json("export_unit_rows.json", export_rows)
    write_json("nsw_declared_roads.json", declared_audit)
    write_json("nsw_declared_criteria.json", declared_criteria)
    write_json("nsw_declared_evidence.json", declared_evidence)
    write_json("nsw_declared_nhvr.json", declared_nhvr)
    write_json("nsw_declared_adt.json", declared_adt)
    write_json("nsw_declared_road_ext.json", declared_ext)
    write_json("nsw_declared_zone.json", declared_zones)
    write_json("nsw_declared_recat.json", declared_recat)
    write_json("export_declared_rows.json", declared_exports)
    print("wrote connected-section and declared-road dashboard data")


if __name__ == "__main__":
    main()
