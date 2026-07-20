#!/usr/bin/env python3
"""Build measured-only TfNSW ADT evidence for mapped road units."""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import date
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely.geometry import Point
from shapely.ops import unary_union


PROJECTED_CRS = "EPSG:3577"
TRAFFIC_DIR = "nsw_traffic_volume_counts"
YEARLY_FILE = "road_traffic_counts_yearly_summary.csv"
STATION_FILE = "road_traffic_counts_station_reference.csv"
DIRECT_ID_MAX_M = 500.0
NAME_MATCH_MAX_M = 75.0
OVERLAPPING_NAME_MATCH_MAX_M = 15.0
TOTAL_CLASSES = {"ALL VEHICLES", "UNCLASSIFIED"}
ROAD_WORDS = {
    "AVENUE", "BYPASS", "DRIVE", "FREEWAY", "HIGHWAY", "LANE", "MOTORWAY",
    "PARADE", "PLACE", "ROAD", "ROUTE", "STREET", "WAY",
}


def latest_complete_year(today: date | None = None) -> int:
    return (today or date.today()).year - 1


def normalise_road_number(value) -> str:
    number = pd.to_numeric(pd.Series([value]), errors="coerce").iloc[0]
    if pd.isna(number) or int(round(float(number))) < 0:
        return ""
    return str(int(round(float(number)))).zfill(7)


def normalise_name(value) -> str:
    words = re.findall(r"[A-Z0-9]+", str(value or "").upper())
    return " ".join(word for word in words if word not in ROAD_WORDS)


def names_match(station_names: list[str], road_names: list[str]) -> bool:
    station = [normalise_name(value) for value in station_names]
    roads = [normalise_name(value) for value in road_names]
    for left in station:
        if not left:
            continue
        left_tokens = set(left.split())
        for right in roads:
            if not right:
                continue
            right_tokens = set(right.split())
            if left == right or left_tokens <= right_tokens or right_tokens <= left_tokens:
                return True
            union = left_tokens | right_tokens
            if union and len(left_tokens & right_tokens) / len(union) >= 0.6:
                return True
    return False


def _station_key(values: pd.Series) -> pd.Series:
    return values.astype(str).str.replace(r"\.0$", "", regex=True).str.strip()


def _directional_counts(rows: pd.DataFrame, value_name: str) -> pd.DataFrame:
    """Return measured totals, preferring published both-direction rows."""
    keys = ["station_key", "year", "classification_type"]
    both = rows[rows["traffic_direction_name"] == "PRESCRIBED AND COUNTER"].copy()
    both = (
        both.sort_values([*keys, "data_reliability"])
        .groupby(keys, as_index=False)
        .tail(1)[[*keys, "traffic_count"]]
        .rename(columns={"traffic_count": value_name})
    )

    directional = rows[rows["traffic_direction_name"].isin(["PRESCRIBED", "COUNTER"])].copy()
    grouped = directional.groupby(keys)
    summed = grouped.agg(
        direction_count=("traffic_direction_name", "nunique"),
        traffic_count=("traffic_count", "sum"),
    ).reset_index()
    summed = summed[summed["direction_count"] == 2][[*keys, "traffic_count"]]
    summed = summed.rename(columns={"traffic_count": value_name})
    if not both.empty:
        both_keys = pd.MultiIndex.from_frame(both[keys])
        summed_keys = pd.MultiIndex.from_frame(summed[keys])
        summed = summed[~summed_keys.isin(both_keys)]
    return pd.concat([both, summed], ignore_index=True)


def latest_station_observations(summary: pd.DataFrame, complete_year: int) -> pd.DataFrame:
    rows = summary.copy()
    rows["station_key"] = _station_key(rows["station_key"])
    rows["year"] = pd.to_numeric(rows["year"], errors="coerce")
    rows["traffic_count"] = pd.to_numeric(rows["traffic_count"], errors="coerce")
    rows["data_reliability"] = pd.to_numeric(rows.get("data_reliability"), errors="coerce").fillna(-1)
    partial = rows["partial_year"].astype(str).str.lower().isin({"true", "1", "yes"})
    rows = rows[
        (rows["period"] == "ALL DAYS")
        & ~partial
        & (rows["year"] <= complete_year)
        & (rows["traffic_count"] > 0)
    ].copy()

    totals = _directional_counts(rows[rows["classification_type"].isin(TOTAL_CLASSES)], "aadt")
    totals["class_rank"] = (totals["classification_type"] == "ALL VEHICLES").astype(int)
    totals = (
        totals.sort_values(["station_key", "year", "class_rank"])
        .groupby(["station_key", "year"], as_index=False)
        .tail(1)
    )

    heavy = _directional_counts(rows[rows["classification_type"] == "HEAVY VEHICLES"], "heavy_count")
    heavy = heavy[["station_key", "year", "heavy_count"]]
    totals = totals.merge(heavy, on=["station_key", "year"], how="left")
    # An unclassified counter cannot substantiate a vehicle-class percentage.
    totals.loc[totals["classification_type"] != "ALL VEHICLES", "heavy_count"] = pd.NA
    totals["hv_pct"] = (totals["heavy_count"] / totals["aadt"] * 100).round(1)
    totals.loc[(totals["hv_pct"] < 0) | (totals["hv_pct"] > 100), "hv_pct"] = pd.NA
    return (
        totals.sort_values(["station_key", "year", "class_rank"])
        .groupby("station_key", as_index=False)
        .tail(1)
        .reset_index(drop=True)
    )


def select_road_observation(rows: list[dict]) -> dict | None:
    if not rows:
        return None
    selected = max(rows, key=lambda row: (
        int(row["year"]),
        row.get("hv_pct") is not None,
        float(row["aadt"]),
        -float(row.get("dist_m") or 0),
    ))
    station_keys = sorted({str(row["station_key"]) for row in rows})
    result = {
        "aadt": int(round(float(selected["aadt"]))),
        "hv_pct": selected.get("hv_pct"),
        "year": int(selected["year"]),
        "stations": len(station_keys),
        "dist_m": int(round(float(selected.get("dist_m") or 0))),
        "station_key": str(selected["station_key"]),
        "station_id": str(selected.get("station_id") or ""),
        "match_method": selected.get("match_method"),
        "source": "TfNSW NSW Roads Traffic Volume Counts",
        "selection": "newest completed year; classified count preferred; highest ADT tie-break",
        "station_keys": station_keys,
    }
    if result["hv_pct"] is not None and not pd.isna(result["hv_pct"]):
        result["hv_pct"] = round(float(result["hv_pct"]), 1)
    else:
        result["hv_pct"] = None
    return result


def combine_adt_rows(rows: list[dict]) -> dict | None:
    usable = [row for row in rows if row]
    if not usable:
        return None
    selected = max(usable, key=lambda row: (
        int(row["year"]),
        row.get("hv_pct") is not None,
        float(row["aadt"]),
        -float(row.get("dist_m") or 0),
    ))
    result = dict(selected)
    station_keys = sorted({
        key for row in usable for key in row.get("station_keys", [row.get("station_key")]) if key
    })
    result["station_keys"] = station_keys
    result["stations"] = len(station_keys)
    return result


def traffic_pass(criteria: dict, adt: dict | None) -> bool | None:
    if not adt:
        return None
    state = criteria.get("cls") == "State"
    urban = criteria.get("area") == "urban"
    adt_threshold = 10000 if state and urban else 7000 if state else 7000 if urban else 2000
    hv_threshold = 8 if state else 6
    if adt["aadt"] <= adt_threshold:
        return False
    if adt.get("hv_pct") is None:
        return None
    return adt["hv_pct"] > hv_threshold


def apply_traffic_criteria(criteria_rows: dict, adt_rows: dict) -> None:
    for key, criteria in criteria_rows.items():
        result = traffic_pass(criteria, adt_rows.get(key))
        criteria.setdefault("opt", {})["traffic"] = result
        criteria["optMet"] = sum(value is True for value in criteria["opt"].values())
        gate_failed = (
            criteria.get("cls") == "State" and criteria.get("mand", {}).get("pbs1") is False
        ) or (
            criteria.get("cls") == "Regional" and criteria.get("mand", {}).get("bdouble") is False
        )
        criteria["verdict"] = (
            "red" if gate_failed else
            "green" if criteria["optMet"] >= 2 else
            "orange" if criteria["optMet"] == 1 else "red"
        )


def _unit_geometries(features: list[dict], projected_geometries: list) -> gpd.GeoDataFrame:
    grouped = defaultdict(list)
    metadata = {}
    for feature, geometry in zip(features, projected_geometries):
        properties = feature["properties"]
        key = properties.get("road_unit")
        if not key:
            continue
        grouped[key].append(geometry)
        row = metadata.setdefault(key, {
            "road_unit": key,
            "road_number": normalise_road_number(properties.get("road_number")),
            "road_names": set(),
        })
        if properties.get("road_name"):
            row["road_names"].add(str(properties["road_name"]))
    rows = []
    for key, geometries in grouped.items():
        row = metadata[key]
        row["road_names"] = sorted(row["road_names"])
        row["geometry"] = unary_union(geometries)
        rows.append(row)
    return gpd.GeoDataFrame(rows, geometry="geometry", crs=PROJECTED_CRS)


def build_measured_adt(
    features: list[dict],
    projected_geometries: list,
    raw_dir: Path,
    complete_year: int | None = None,
) -> tuple[dict, dict, dict]:
    source_dir = Path(raw_dir) / TRAFFIC_DIR
    yearly_path = source_dir / YEARLY_FILE
    station_path = source_dir / STATION_FILE
    if not yearly_path.exists() or not station_path.exists():
        raise FileNotFoundError(f"TfNSW traffic files not found in {source_dir}")

    summary = pd.read_csv(yearly_path, low_memory=False)
    stations = pd.read_csv(station_path, low_memory=False)
    stations["station_key"] = _station_key(stations["station_key"])
    observations = latest_station_observations(summary, complete_year or latest_complete_year())
    observations = observations.merge(stations, on="station_key", how="inner", suffixes=("", "_station"))
    observations["wgs84_latitude"] = pd.to_numeric(observations["wgs84_latitude"], errors="coerce")
    observations["wgs84_longitude"] = pd.to_numeric(observations["wgs84_longitude"], errors="coerce")
    observations = observations.dropna(subset=["wgs84_latitude", "wgs84_longitude"])
    station_gdf = gpd.GeoDataFrame(
        observations,
        geometry=[Point(xy) for xy in zip(observations.wgs84_longitude, observations.wgs84_latitude)],
        crs="EPSG:4326",
    ).to_crs(PROJECTED_CRS)

    units = _unit_geometries(features, projected_geometries)
    units_by_number = defaultdict(list)
    for index, row in units.iterrows():
        if row["road_number"]:
            units_by_number[row["road_number"]].append(index)

    matched = []
    for _, station in station_gdf.iterrows():
        point = station.geometry
        station_number = normalise_road_number(station.get("road_number"))
        station_names = [
            station.get("road_name"), station.get("common_road_name"), station.get("full_name"),
        ]
        candidate_indexes = units_by_number.get(station_number, [])
        selected_matches = {}
        if candidate_indexes:
            distances = units.loc[candidate_indexes].geometry.distance(point)
            best_index = distances.idxmin()
            distance = float(distances.loc[best_index])
            if distance <= DIRECT_ID_MAX_M:
                selected_matches[best_index] = (distance, "administrative_id_and_geometry")
        if not selected_matches:
            nearby_indexes = list(units.sindex.query(point.buffer(NAME_MATCH_MAX_M), predicate="intersects"))
            nearby = units.iloc[nearby_indexes] if nearby_indexes else units.iloc[[]]
            matches = nearby[nearby["road_names"].map(lambda names: names_match(station_names, names))]
            if matches.empty:
                continue
            distances = matches.geometry.distance(point)
            best_index = distances.idxmin()
            distance = float(distances.loc[best_index])
            if distance > NAME_MATCH_MAX_M:
                continue
            selected_matches[best_index] = (distance, "road_name_and_geometry")

        # A physical road can have multiple assessed administrative records. Preserve the
        # primary ID match, while sharing the observation with tightly overlapping named records.
        overlap_indexes = list(units.sindex.query(
            point.buffer(OVERLAPPING_NAME_MATCH_MAX_M), predicate="intersects",
        ))
        overlap = units.iloc[overlap_indexes] if overlap_indexes else units.iloc[[]]
        overlap = overlap[overlap["road_names"].map(lambda names: names_match(station_names, names))]
        for overlap_index, unit in overlap.iterrows():
            distance = float(unit.geometry.distance(point))
            if distance <= OVERLAPPING_NAME_MATCH_MAX_M and overlap_index not in selected_matches:
                selected_matches[overlap_index] = (distance, "overlapping_road_name_and_geometry")

        for unit_index, (distance, method) in selected_matches.items():
            unit = units.loc[unit_index]
            matched.append({
                "road_unit": unit["road_unit"],
                "source_road_number": unit["road_number"],
                "station_key": station["station_key"],
                "station_id": station.get("station_id"),
                "aadt": float(station["aadt"]),
                "hv_pct": None if pd.isna(station.get("hv_pct")) else float(station["hv_pct"]),
                "year": int(station["year"]),
                "dist_m": distance,
                "match_method": method,
            })

    by_unit = defaultdict(list)
    by_base = defaultdict(list)
    for row in matched:
        by_unit[row["road_unit"]].append(row)
        if row["source_road_number"]:
            by_base[row["source_road_number"]].append(row)
    unit_adt = {key: select_road_observation(rows) for key, rows in by_unit.items()}
    base_adt = {key: select_road_observation(rows) for key, rows in by_base.items()}
    audit = {
        "source": "TfNSW NSW Roads Traffic Volume Counts",
        "latest_complete_year": complete_year or latest_complete_year(),
        "usable_station_observations": len(station_gdf),
        "matched_station_observations": len({row["station_key"] for row in matched}),
        "matched_station_assignments": len(matched),
        "matched_road_units": len(unit_adt),
        "matched_source_roads": len(base_adt),
        "match_methods": pd.Series([row["match_method"] for row in matched]).value_counts().to_dict(),
    }
    return base_adt, unit_adt, audit
