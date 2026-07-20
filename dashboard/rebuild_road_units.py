#!/usr/bin/env python3
"""Build connected, class-consistent assessment units for the NSW dashboard.

TfNSW ``road_number`` values are administrative identifiers, not guaranteed
single-road identifiers. Some contain disconnected corridors, mixed State and
Regional sections, and different route shields. This script keeps the sourced
identifier as metadata while assigning each displayed segment to a connected
``road_unit`` used by the dashboard.

Existing one-unit roads retain their current assessment verbatim. Administrative
IDs that split into multiple units are reassessed from unit geometry and the
named evidence already available to the dashboard. Road-wide values that cannot
be located within a split ID (notably AADT and road-train/bypass membership) are
left unavailable rather than copied to unrelated corridors.
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
from rebuild_employment_centres import derive_centres, source_path as employment_source_path
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

STATE_CENTRE_TYPES = {"Significant Urban Area", "Regional City", "Major Town"}
REGIONAL_RURAL_CENTRE_TYPES = STATE_CENTRE_TYPES | {"Town Centre"}
REGIONAL_URBAN_CENTRE_TYPES = STATE_CENTRE_TYPES
STATE_DEST_TYPES = {"International Airport", "Major Intermodal", "Major Port"}
REGIONAL_EMPLOYMENT_TIERS = {"Regional", "Major"}


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


def names_by_length(unit: dict, features) -> list[str]:
    lengths = Counter()
    for index in unit["feature_indexes"]:
        name = str(features[index]["properties"].get("road_name") or "").strip()
        if name:
            lengths[name] += unit["feature_lengths"][index]
    return [name for name, _length in sorted(lengths.items(), key=lambda item: (-item[1], item[0]))]


def weighted_flag(unit: dict, features, field: str) -> tuple[bool, float]:
    total = sum(unit["feature_lengths"][index] for index in unit["feature_indexes"])
    passed = sum(
        unit["feature_lengths"][index]
        for index in unit["feature_indexes"]
        if features[index]["properties"].get(field) in (True, 1)
    )
    coverage = passed / total if total else 0.0
    return coverage >= ACCESS_COVERAGE, round(coverage, 3)


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
    """Attach exact zoning polygons, retaining all intersections and a few nearest misses."""
    output = {}
    for key, unit in units.items():
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
                "ha": round(float(row["ha"]), 1),
                "lga": row["LGA_NAME"],
                "lon": round(float(row["lon"]), 5),
                "lat": round(float(row["lat"]), 5),
                "km": round(distance / 1000.0, 3),
                "distance_m": round(distance),
                "relation": "intersects" if distance <= 0.5 else "nearby",
                "source": "NSW Planning EPI Land Zoning polygon",
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
    """Re-run S-08/S-11 where road-number evidence cannot safely be retained."""
    targets = {
        base: rows
        for base, rows in source_units.items()
        if not base.startswith("n:")
        and (
            any(unit["zone"] == "urban" for unit in rows)
            or (len(rows) > 1 and any(unit["zone"] != "urban" for unit in rows))
        )
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
    minimum_hectares = 40.0 if zone == "urban" else 5.0 if zone == "remote" else 15.0
    for item in evidence.get("employment", []):
        if (
            item.get("relation") == "intersects"
            and float(item.get("ha") or 0.0) >= minimum_hectares
        ):
            facilities.append({
                "name": item.get("name"),
                "kind": "employment",
                "ha": item.get("ha"),
                "tier": item.get("tier"),
                "type": item.get("kind"),
            })
    return [item for item in facilities if item.get("name")]


def regional_facilities(evidence: dict) -> list[dict]:
    facilities = []
    for bucket, kind in (("hospitals", "hospital"), ("dests", "destination")):
        for item in evidence.get(bucket, []):
            facilities.append({"name": item.get("name"), "kind": kind, "type": item.get("ftype") or item.get("cat")})
    for item in evidence.get("employment", []):
        if (
            item.get("relation") == "intersects"
            and item.get("tier") in REGIONAL_EMPLOYMENT_TIERS
        ):
            facilities.append({
                "name": item.get("name"),
                "kind": "employment",
                "ha": item.get("ha"),
                "tier": item.get("tier"),
                "type": item.get("kind"),
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


def apply_state_dest(criteria: dict, result: dict) -> dict:
    updated = copy.deepcopy(criteria)
    updated.setdefault("stateOpt", {}).update(state_metadata(result))
    if updated.get("cls") == "State":
        updated.setdefault("opt", {})["dest"] = result.get("dest")
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
    state_centre_pass = len(state_centres) >= 2
    regional_centre_pass = len(regional_centres) >= 2

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
            "dest_economic_value_assessed": False,
        })
    regional_dest_facilities = regional_facilities(evidence)
    regional_dest = facility_metadata(unit, regional_centres, regional_dest_facilities, "dest")

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
        if optional_count(row.get("opt") or {}) != row.get("optMet"):
            raise RuntimeError(f"Optional count does not reproduce for {key}")
        if verdict_of(row) != row.get("verdict"):
            raise RuntimeError(f"Verdict does not reproduce for {key}")
    for base, rows in source_units.items():
        if (
            len(rows) == 1
            and rows[0]["key"] not in network_state_dest
            and criteria[rows[0]["key"]] != legacy_criteria.get(base)
        ):
            raise RuntimeError(f"Single-unit road {base} did not retain its legacy criteria")
        if len(rows) > 1 and any(row["key"] in adt for row in rows):
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
    cowpasture = criteria.get("0000648~S01", {}).get("stateOpt") or {}
    if cowpasture.get("dest") is not False:
        raise RuntimeError("Cowpasture S-11 must not pass from a nearby employment polygon")
    cowpasture_employment = evidence.get("0000648~S01", {}).get("employment", [])
    local_centres = [
        item for item in cowpasture_employment
        if item.get("name") == "Local Centre" and item.get("relation") == "intersects"
    ]
    nearby_heavy = [
        item for item in cowpasture_employment
        if item.get("name") == "Heavy Industrial" and item.get("relation") == "nearby"
    ]
    if not local_centres or not nearby_heavy:
        raise RuntimeError("Cowpasture employment evidence is missing exact polygon relationships")


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
            row["zone"] = legacy_zone.get(base) if total_units == 1 else unit_zone(row, urbanity, newell_segments)
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
    for key, unit in units.items():
        base = unit["source_key"]
        unit_zone_values[key] = unit["zone"]
        if unit["unit_count"] == 1:
            unit_nhvr[key] = copy.deepcopy(legacy_nhvr.get(base, {}))
            if base in legacy_adt:
                unit_adt[key] = copy.deepcopy(legacy_adt[base])
            unit_criteria[key] = apply_state_dest(
                legacy_criteria.get(base, {}),
                unit_state_dest[key],
            ) if key in unit_state_dest else copy.deepcopy(legacy_criteria.get(base, {}))
            continue
        unit_nhvr[key] = {
            "bdouble19": unit["bdouble"],
            "source_scope": "road_unit_segment_flags",
        }
        unit_criteria[key] = build_split_criteria(
            unit,
            unit_evidence.get(key, {}),
            legacy_criteria.get(base, {}),
            unit_nhvr[key],
            unit_ext[key],
            unit["zone"],
            [nltn[index] for index in unit["feature_indexes"]],
            unit_state_dest.get(key),
        )

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
        if unit["unit_count"] == 1 and base in export_lookup and key not in unit_state_dest:
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
        "excluded_micro_component_count": len(excluded_components),
        "excluded_micro_feature_count": sum(len(row["feature_indexes"]) for row in excluded_components),
        "unit_state_facility_assessment": unit_state_dest_audit,
        "split_source_roads": split_ids,
        "units": audit_units,
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
    )

    verdicts = Counter(row.get("verdict") for row in unit_criteria.values())
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
    print("validation: all unit keys, verdicts, segment colours and exports agree")
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
    write_json("nsw_road_units.json", audit)
    write_json("nsw_unit_criteria.json", unit_criteria)
    write_json("nsw_unit_evidence.json", unit_evidence)
    write_json("nsw_unit_nhvr.json", unit_nhvr)
    write_json("nsw_unit_adt.json", unit_adt)
    write_json("nsw_unit_road_ext.json", unit_ext)
    write_json("nsw_unit_zone.json", unit_zone_values)
    write_json("nsw_unit_recat.json", unit_recat)
    write_json("export_unit_rows.json", export_rows)
    print("wrote road-unit dashboard data")


if __name__ == "__main__":
    main()
