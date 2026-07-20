#!/usr/bin/env python3
"""Build commercial and industrial centre polygons from NSW Planning zoning."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import urlencode

import geopandas as gpd
from shapely import make_valid
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon, mapping
from shapely.ops import unary_union


DASHBOARD = Path(__file__).resolve().parent
DATA = DASHBOARD / "data"
DEFAULT_RAW = Path.home() / "Desktop" / "IPWEA" / "data" / "raw"
SOURCE_NAME = "nsw_planning_employment_zones.geojson"
SOURCE_URL = (
    "https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/"
    "EPI_Primary_Planning_Layers/MapServer/2/query"
)
PROJECTED_CRS = "EPSG:3577"
MINIMUM_AREA_HA = 5.0
OUTLINE_SIMPLIFY_M = 2.0
COMMERCIAL_CODES = {
    "B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "E1", "E2", "MU1"
}
INDUSTRIAL_CODES = {"E3", "E4", "E5", "IN1", "IN2", "IN3", "IN4"}
EMPLOYMENT_CODES = sorted(COMMERCIAL_CODES | INDUSTRIAL_CODES)


def source_path(raw_dir: Path) -> Path:
    return raw_dir / SOURCE_NAME


def fetch_source(path: Path) -> None:
    where = "SYM_CODE IN ({})".format(
        ",".join(f"'{code}'" for code in EMPLOYMENT_CODES)
    )
    query = urlencode({
        "f": "geojson",
        "where": where,
        "outFields": "OBJECTID,LGA_NAME,SYM_CODE,LAY_CLASS",
        "returnGeometry": "true",
        "outSR": "4326",
        "orderByFields": "OBJECTID",
    })
    payload = subprocess.run(
        ["curl", "--fail", "--silent", "--show-error", f"{SOURCE_URL}?{query}"],
        check=True,
        capture_output=True,
    ).stdout
    parsed = json.loads(payload)
    if parsed.get("type") != "FeatureCollection" or not parsed.get("features"):
        raise RuntimeError("NSW Planning query did not return employment-zone polygons")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)


def polygonal(geometry):
    if geometry is None or geometry.is_empty:
        return None
    geometry = make_valid(geometry)
    if isinstance(geometry, (Polygon, MultiPolygon)):
        return geometry
    if isinstance(geometry, GeometryCollection):
        polygons = [part for part in geometry.geoms if isinstance(part, (Polygon, MultiPolygon))]
        return unary_union(polygons) if polygons else None
    return None


def zone_id(row) -> str:
    point = row.geometry.representative_point()
    identity = "|".join([
        str(row.LGA_NAME),
        str(row.SYM_CODE),
        str(row.LAY_CLASS),
        str(round(point.x)),
        str(round(point.y)),
    ])
    return "emp-" + hashlib.sha1(identity.encode("utf-8")).hexdigest()[:12]


def derive_centres(path: Path) -> gpd.GeoDataFrame:
    zones = gpd.read_file(path).to_crs(PROJECTED_CRS)
    required = {"LGA_NAME", "SYM_CODE", "LAY_CLASS", "geometry"}
    if not required <= set(zones.columns):
        raise RuntimeError(f"Employment-zone source is missing {sorted(required - set(zones.columns))}")
    zones["LGA_NAME"] = zones["LGA_NAME"].fillna("").astype(str).str.strip()
    zones["SYM_CODE"] = zones["SYM_CODE"].fillna("").astype(str).str.strip()
    zones["LAY_CLASS"] = zones["LAY_CLASS"].fillna("").astype(str).str.strip()
    zones = zones[zones["SYM_CODE"].isin(EMPLOYMENT_CODES)].copy()
    zones["geometry"] = zones.geometry.map(polygonal)
    zones = zones.dropna(subset=["geometry"])

    centres = (
        zones.dissolve(by=["LGA_NAME", "SYM_CODE", "LAY_CLASS"])
        .explode(index_parts=False)
        .reset_index()
    )
    centres["geometry"] = centres.geometry.map(polygonal)
    centres = centres.dropna(subset=["geometry"])
    centres["ha"] = centres.geometry.area / 10_000.0
    centres = centres[centres["ha"] >= MINIMUM_AREA_HA].copy()
    centres["kind"] = centres["SYM_CODE"].map(
        lambda code: "Commercial" if code in COMMERCIAL_CODES else "Industrial"
    )
    centres["tier"] = centres["ha"].map(
        lambda area: "Major" if area >= 40.0 else "Regional" if area >= 15.0 else "Local"
    )
    centres["zone_id"] = centres.apply(zone_id, axis=1)
    if not centres["zone_id"].is_unique:
        raise RuntimeError("Employment-zone identifiers are not unique")

    points = gpd.GeoSeries(centres.geometry.representative_point(), crs=PROJECTED_CRS).to_crs("EPSG:4326")
    centres["lon"] = points.x
    centres["lat"] = points.y
    return centres.sort_values(
        ["LGA_NAME", "LAY_CLASS", "SYM_CODE", "zone_id"],
        kind="stable",
    ).reset_index(drop=True)


def rounded(value):
    if isinstance(value, (list, tuple)):
        return [rounded(item) for item in value]
    if isinstance(value, float):
        return round(value, 5)
    return value


def summary_row(row) -> dict:
    return {
        "zoneId": row.zone_id,
        "name": row.LAY_CLASS,
        "code": row.SYM_CODE,
        "kind": row.kind,
        "tier": row.tier,
        "ha": round(float(row.ha), 1),
        "lga": row.LGA_NAME,
        "lon": round(float(row.lon), 5),
        "lat": round(float(row.lat), 5),
    }


def write_outputs(centres: gpd.GeoDataFrame) -> None:
    summaries = [summary_row(row) for row in centres.itertuples()]
    outlines = {}
    for row in centres.itertuples():
        geometry = row.geometry.simplify(OUTLINE_SIMPLIFY_M, preserve_topology=True)
        geometry = gpd.GeoSeries([geometry], crs=PROJECTED_CRS).to_crs("EPSG:4326").iloc[0]
        outlines[row.zone_id] = {
            "bbox": rounded(list(geometry.bounds)),
            "geometry": rounded(mapping(geometry)),
        }
    (DATA / "employment_centres.json").write_text(
        json.dumps(summaries, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    (DATA / "employment_centre_outlines.json").write_text(
        json.dumps(outlines, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-dir", type=Path)
    parser.add_argument("--fetch", action="store_true")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    raw_dir = args.raw_dir or Path(os.environ.get("ROAD_RECAT_RAW_DATA", DEFAULT_RAW))
    path = source_path(raw_dir)
    if args.fetch:
        fetch_source(path)
    if not path.exists():
        raise FileNotFoundError(path)
    centres = derive_centres(path)
    print(f"employment source polygons: {len(gpd.read_file(path)):,}")
    print(f"employment centres >= {MINIMUM_AREA_HA:g} ha: {len(centres):,}")
    if args.apply:
        write_outputs(centres)
        print("wrote employment centre summaries and map outlines")
    else:
        print("dry run only; use --apply to write dashboard data")


if __name__ == "__main__":
    main()
