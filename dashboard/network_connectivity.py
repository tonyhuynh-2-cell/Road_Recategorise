#!/usr/bin/env python3
"""Shared road-corridor topology helpers for criteria rebuild scripts."""

from __future__ import annotations

import math
import re
from collections import defaultdict
from pathlib import Path

import geopandas as gpd
import pandas as pd
import pyogrio
from scipy.spatial import cKDTree
from shapely.geometry import Point
from shapely.ops import unary_union


PROJECTED_CRS = "EPSG:3577"
ROAD_SEGMENT_CRS = "EPSG:7844"
MATCH_BUFFER_M = 120.0
ALIGNMENT_M = 100.0
ENDPOINT_SNAP_M = 3.0
CENTRE_CONNECT_M = 200.0

ROAD_TYPE_WORDS = {
    "ACCESS",
    "ALLEY",
    "AVENUE",
    "BOULEVARD",
    "BYPASS",
    "CIRCUIT",
    "CLOSE",
    "COURT",
    "CRESCENT",
    "DRIVE",
    "EXPRESSWAY",
    "FREEWAY",
    "HIGHWAY",
    "LANE",
    "LINK",
    "MOTORWAY",
    "PARADE",
    "PARKWAY",
    "PLACE",
    "ROAD",
    "ROUTE",
    "STREET",
    "TRACK",
    "TRAIL",
    "WAY",
}


def normalise_road_name(value: object) -> str:
    words = re.findall(r"[A-Z0-9]+", str(value or "").upper())
    words = [word for word in words if word not in ROAD_TYPE_WORDS]
    return "".join(words)


def names_match(candidate: object, route_names: set[str]) -> bool:
    candidate_name = normalise_road_name(candidate)
    if len(candidate_name) < 4:
        return False
    return any(
        candidate_name == route_name
        or (len(route_name) >= 6 and candidate_name in route_name)
        or (len(candidate_name) >= 6 and route_name in candidate_name)
        for route_name in route_names
    )


def prepare_routes(assessment_path: Path, road_ids: set[str]) -> gpd.GeoDataFrame:
    assessment = gpd.read_file(assessment_path)
    assessment["road_number"] = assessment["road_number"].astype(str).str.strip()
    assessment = assessment[assessment["road_number"].isin(road_ids)].copy()
    assessment = assessment.to_crs(PROJECTED_CRS)

    names = (
        assessment.dropna(subset=["road_name"])
        .groupby("road_number")["road_name"]
        .agg(lambda values: sorted({str(value) for value in values if str(value).strip()}))
    )
    routes = assessment.dissolve(by="road_number")[["geometry"]]
    routes["road_names"] = [names.get(road_number, []) for road_number in routes.index]
    routes["route_km"] = routes.geometry.length / 1000.0
    return routes


def _candidate_buffers(routes: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    buffers = gpd.GeoDataFrame(
        {"road_number": routes.index.astype(str)},
        geometry=list(routes.geometry.buffer(MATCH_BUFFER_M)),
        crs=PROJECTED_CRS,
    )
    return buffers.to_crs(ROAD_SEGMENT_CRS)


def _aligned_with_route(segment, route_geometry, candidate_name, route_names) -> bool:
    coords = list(segment.coords)
    if len(coords) < 2:
        return False
    end_distance = max(
        Point(coords[0]).distance(route_geometry),
        Point(coords[-1]).distance(route_geometry),
    )
    if names_match(candidate_name, route_names):
        return end_distance <= MATCH_BUFFER_M * 1.5
    return end_distance <= ALIGNMENT_M


def build_corridor_matches(
    road_segments_path: Path,
    routes: gpd.GeoDataFrame,
    cache_path: Path,
    chunk_size: int = 50_000,
) -> gpd.GeoDataFrame:
    buffers = _candidate_buffers(routes)
    route_geometries = routes.geometry.to_dict()
    route_names = {
        road_number: {normalise_road_name(name) for name in row.road_names}
        for road_number, row in routes.iterrows()
    }
    info = pyogrio.read_info(road_segments_path, layer="road_segments")
    total = int(info["features"])
    matched_chunks = []

    for offset in range(0, total, chunk_size):
        segments = pyogrio.read_dataframe(
            road_segments_path,
            layer="road_segments",
            columns=[
                "OBJECTID",
                "roadnamebase",
                "roadnametype",
                "functionhierarchy",
                "roadontype",
                "operationalstatus",
            ],
            skip_features=offset,
            max_features=chunk_size,
        )
        candidates = gpd.sjoin(
            segments,
            buffers[["road_number", "geometry"]],
            how="inner",
            predicate="intersects",
        )
        if candidates.empty:
            continue
        candidates = candidates.drop(columns=["index_right"]).to_crs(PROJECTED_CRS)
        keep = [
            _aligned_with_route(
                row.geometry,
                route_geometries[row.road_number],
                row.roadnamebase,
                route_names[row.road_number],
            )
            for row in candidates.itertuples()
        ]
        candidates = candidates.loc[keep]
        if not candidates.empty:
            matched_chunks.append(candidates)
        print(
            f"road matching: {min(offset + chunk_size, total):,}/{total:,} "
            f"source segments; {sum(len(chunk) for chunk in matched_chunks):,} matches",
            flush=True,
        )

    if not matched_chunks:
        raise RuntimeError("No NSW Road Segment features matched the assessed corridors")

    matched = gpd.GeoDataFrame(
        pd.concat(matched_chunks, ignore_index=True),
        geometry="geometry",
        crs=PROJECTED_CRS,
    )
    matched = matched.drop_duplicates(subset=["road_number", "OBJECTID"])
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    pyogrio.write_dataframe(matched, cache_path, layer="corridor_segments", driver="GPKG")
    return matched


def load_or_build_corridor_matches(
    road_segments_path: Path,
    routes: gpd.GeoDataFrame,
    cache_path: Path,
    rebuild: bool = False,
) -> gpd.GeoDataFrame:
    if cache_path.exists() and not rebuild:
        matched = pyogrio.read_dataframe(cache_path, layer="corridor_segments")
        wanted = set(routes.index.astype(str))
        available = set(matched["road_number"].astype(str))
        if wanted <= available:
            return matched[matched["road_number"].astype(str).isin(wanted)].copy()
    return build_corridor_matches(road_segments_path, routes, cache_path)


class DisjointSet:
    def __init__(self, size: int):
        self.parent = list(range(size))

    def find(self, item: int) -> int:
        while self.parent[item] != item:
            self.parent[item] = self.parent[self.parent[item]]
            item = self.parent[item]
        return item

    def union(self, left: int, right: int) -> None:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root != right_root:
            self.parent[right_root] = left_root


def road_components(segments: gpd.GeoDataFrame) -> list[dict]:
    if segments.empty:
        return []
    geometries = list(segments.geometry)
    endpoints = []
    for geometry in geometries:
        coords = list(geometry.coords)
        endpoints.extend((coords[0], coords[-1]))

    segment_sets = DisjointSet(len(geometries))
    tree = cKDTree(endpoints)
    for left, right in tree.query_pairs(ENDPOINT_SNAP_M):
        segment_sets.union(left // 2, right // 2)

    grouped = defaultdict(list)
    for index in range(len(geometries)):
        grouped[segment_sets.find(index)].append(index)

    components = []
    for indexes in grouped.values():
        component_geometries = [geometries[index] for index in indexes]
        components.append(
            {
                "geometry": unary_union(component_geometries),
                "km": sum(geometry.length for geometry in component_geometries) / 1000.0,
                "segment_count": len(indexes),
            }
        )
    return sorted(components, key=lambda component: component["km"], reverse=True)


def load_abs_centres(raw_dir: Path) -> gpd.GeoDataFrame:
    boundary_path = (
        raw_dir
        / "ASGS_2021_SUA_UCL_SOS_SOSR_GPKG_GDA2020"
        / "ASGS_2021_SUA_UCL_SOS_SOSR_GPKG_GDA2020.gpkg"
    )
    ucl_population_path = (
        raw_dir
        / "abs_ucl_census_profile_2021_nsw"
        / "2021 Census GCP Urban Centres and Localities for NSW"
        / "2021Census_G01_NSW_UCL.csv"
    )
    sua_population_path = (
        raw_dir
        / "abs_sua_census_profile_2021_nsw"
        / "2021Census_G01_NSW_SUA.csv"
    )

    ucl = pyogrio.read_dataframe(boundary_path, layer="UCL_2021_AUST_GDA2020")
    ucl = ucl[ucl["STATE_CODE_2021"].astype(str) == "1"].copy()
    ucl_population = pd.read_csv(
        ucl_population_path,
        usecols=["UCL_CODE_2021", "Tot_P_P"],
        dtype={"UCL_CODE_2021": str},
    )
    ucl_population["join_code"] = ucl_population["UCL_CODE_2021"].str.removeprefix("UCL")
    ucl["join_code"] = ucl["UCL_CODE_2021"].astype(str)
    ucl = ucl.merge(ucl_population[["join_code", "Tot_P_P"]], on="join_code", how="inner")
    ucl = ucl.rename(columns={"UCL_NAME_2021": "name", "Tot_P_P": "population"})
    ucl = ucl[
        ~ucl["name"].str.startswith(
            ("Remainder of", "Migratory", "No usual address"),
            na=False,
        )
    ].copy()
    ucl["kind"] = "UCL"

    sua = pyogrio.read_dataframe(boundary_path, layer="SUA_2021_AUST_GDA2020")
    sua_population = pd.read_csv(
        sua_population_path,
        usecols=["SUA_CODE_2021", "Tot_P_P"],
        dtype={"SUA_CODE_2021": str},
    )
    sua["join_code"] = sua["SUA_CODE_2021"].astype(str)
    sua = sua.merge(sua_population, left_on="join_code", right_on="SUA_CODE_2021", how="inner")
    sua = sua[~sua["SUA_NAME_2021"].str.startswith("Not in any", na=False)].copy()
    sua = sua.rename(columns={"SUA_NAME_2021": "name", "Tot_P_P": "population"})
    sua["kind"] = "SUA"

    centres = gpd.GeoDataFrame(
        pd.concat(
            [
                ucl[["name", "population", "kind", "geometry"]],
                sua[["name", "population", "kind", "geometry"]],
            ],
            ignore_index=True,
        ),
        geometry="geometry",
        crs=ucl.crs,
    )
    centres["population"] = pd.to_numeric(centres["population"], errors="coerce")
    return centres.dropna(subset=["population"]).to_crs(PROJECTED_CRS)


def centre_roles(kind: str, population: int, zone: str) -> tuple[bool, bool]:
    major_threshold = 5_000 if zone == "remote" else 7_000
    town_threshold = 1_000 if zone == "remote" else 2_000
    source = population >= major_threshold
    town = kind == "UCL" and town_threshold <= population < major_threshold
    return source, town


def assign_centres(component: dict, centres: gpd.GeoDataFrame, zone: str) -> None:
    search_geometry = component["geometry"].buffer(CENTRE_CONNECT_M)
    indexes = centres.sindex.query(search_geometry, predicate="intersects")
    sources = set()
    towns = set()
    for index in indexes:
        centre = centres.iloc[index]
        source, town = centre_roles(centre["kind"], int(centre["population"]), zone)
        if source:
            sources.add(str(centre["name"]))
        if town:
            towns.add(str(centre["name"]))
    component["source_centres"] = sorted(sources)
    component["town_centres"] = sorted(towns)


def route_coverage(route_geometry, segments: gpd.GeoDataFrame) -> float:
    if segments.empty or route_geometry.length <= 0:
        return 0.0
    matched_area = unary_union(list(segments.geometry)).buffer(ALIGNMENT_M)
    covered_length = route_geometry.intersection(matched_area).length
    return min(1.0, covered_length / route_geometry.length)


def evaluate_route_ldr(
    route_geometry,
    segments: gpd.GeoDataFrame,
    centres: gpd.GeoDataFrame,
    zone: str,
) -> dict:
    components = road_components(segments)
    for component in components:
        assign_centres(component, centres, zone)

    qualifying = [
        component
        for component in components
        if component["km"] >= 25.0
        and component["source_centres"]
        and component["town_centres"]
    ]
    best = qualifying[0] if qualifying else (components[0] if components else None)
    coverage = route_coverage(route_geometry, segments)
    assessed = coverage >= 0.70
    value = bool(qualifying) if assessed else None
    all_sources = sorted(
        {name for component in components for name in component["source_centres"]}
    )
    all_towns = sorted(
        {name for component in components for name in component["town_centres"]}
    )

    return {
        "ldr": value,
        "assessed": assessed,
        "coverage": round(coverage, 3),
        "route_km": round(float(route_geometry.length / 1000.0), 1),
        "matched_segment_count": int(len(segments)),
        "matched_km": round(float(segments.geometry.length.sum() / 1000.0), 1),
        "component_km": round(float((best or {}).get("km", 0.0)), 1),
        "component_count": len(components),
        "source_centres": list((best or {}).get("source_centres", [])),
        "town_centres": list((best or {}).get("town_centres", [])),
        "all_source_centres": all_sources,
        "all_town_centres": all_towns,
    }
