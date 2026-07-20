#!/usr/bin/env python3
"""Build size-assessed employment centres from ELDM precincts and EPI zoning."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import urlencode

import geopandas as gpd
import pandas as pd
from shapely import make_valid
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon, mapping
from shapely.ops import unary_union


DASHBOARD = Path(__file__).resolve().parent
DATA = DASHBOARD / "data"
DEFAULT_RAW = Path.home() / "Desktop" / "IPWEA" / "data" / "raw"
SOURCE_NAME = "nsw_planning_employment_zones.geojson"
ELDM_DIR_NAME = "eldm-precinct-shapefiles-2025"
SOURCE_URL = (
    "https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/"
    "EPI_Primary_Planning_Layers/MapServer/2/query"
)
PROJECTED_CRS = "EPSG:3577"
MINIMUM_AREA_HA = 5.0
OUTLINE_SIMPLIFY_M = 2.0
EMPLOYMENT_AREA_HA = {"remote": 5.0, "regional": 15.0, "urban": 40.0}
ASSESSMENT_BASIS = "Client-approved land-area-only employment-centre rule"
EPI_SOURCE = "NSW Planning EPI Land Zoning polygon"
ELDM_SOURCE = "NSW Employment Lands Development Monitor 2025 precinct"
COMMERCIAL_CODES = {
    "B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "E1", "E2", "MU1"
}
INDUSTRIAL_CODES = {"E3", "E4", "E5", "IN1", "IN2", "IN3", "IN4"}
EMPLOYMENT_CODES = sorted(COMMERCIAL_CODES | INDUSTRIAL_CODES)


def source_path(raw_dir: Path) -> Path:
    return raw_dir / SOURCE_NAME


def eldm_path(raw_dir: Path) -> Path:
    return raw_dir / ELDM_DIR_NAME


def employment_size_threshold(zone: str) -> float:
    return EMPLOYMENT_AREA_HA.get(str(zone or "").lower(), 15.0)


def employment_size_qualifies(area_ha: float, zone: str) -> bool:
    return float(area_ha or 0.0) >= employment_size_threshold(zone)


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


def epi_zone_id(row) -> str:
    point = row.geometry.representative_point()
    identity = "|".join([
        str(row.LGA_NAME),
        str(row.SYM_CODE),
        str(row.LAY_CLASS),
        str(round(point.x)),
        str(round(point.y)),
    ])
    return "emp-" + hashlib.sha1(identity.encode("utf-8")).hexdigest()[:12]


def _legacy_tier(area: float) -> str:
    """Retained in output compatibility only; scoring never reads this field."""
    return "Major" if area >= 40.0 else "Regional" if area >= 15.0 else "Local"


def _size_band(area: float) -> str:
    return "40+ ha" if area >= 40.0 else "15-39.9 ha" if area >= 15.0 else "5-14.9 ha"


def derive_epi_centres(path: Path) -> tuple[gpd.GeoDataFrame, gpd.GeoDataFrame]:
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
    centres["kind"] = centres["SYM_CODE"].map(
        lambda code: "Commercial" if code in COMMERCIAL_CODES else "Industrial"
    )
    centres["source"] = EPI_SOURCE
    centres["source_id"] = ""
    centres["official_precinct"] = False
    centres["status"] = "Zoned"
    centres["region"] = ""
    centres["zone_codes"] = centres["SYM_CODE"].map(lambda value: [value])
    centres["planning_classes"] = centres["LAY_CLASS"].map(lambda value: [value])
    return centres, zones


def _eldm_zone_context(geometry, zones: gpd.GeoDataFrame) -> tuple[str, list[str], list[str]]:
    indexes = zones.sindex.query(geometry, predicate="intersects")
    if len(indexes) == 0:
        return "Employment", [], []
    matches = zones.iloc[indexes].copy()
    matches["overlap_area"] = matches.geometry.intersection(geometry).area
    matches = matches[matches["overlap_area"] > 0]
    commercial = float(matches.loc[matches["SYM_CODE"].isin(COMMERCIAL_CODES), "overlap_area"].sum())
    industrial = float(matches.loc[matches["SYM_CODE"].isin(INDUSTRIAL_CODES), "overlap_area"].sum())
    kind = "Industrial" if industrial > commercial else "Commercial" if commercial > industrial else "Employment"
    codes = sorted({str(value) for value in matches["SYM_CODE"] if str(value).strip()})
    classes = sorted({str(value) for value in matches["LAY_CLASS"] if str(value).strip()})
    return kind, codes, classes


def load_eldm_centres(directory: Path, zones: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    columns = [
        "LGA_NAME", "SYM_CODE", "LAY_CLASS", "kind", "ha", "source", "source_id",
        "official_precinct", "status", "region", "zone_codes", "planning_classes", "zone_id", "geometry",
    ]
    if not directory.exists():
        return gpd.GeoDataFrame(columns=columns, geometry="geometry", crs=PROJECTED_CRS)
    paths = sorted(
        path for path in directory.glob("ELDM_Precincts_*_2025.shp")
        if "PotentialFuture" not in path.name
    )
    if not paths:
        return gpd.GeoDataFrame(columns=columns, geometry="geometry", crs=PROJECTED_CRS)

    frames = []
    required = {"Name", "ELDM_ID", "Region", "LGA", "Status", "AREA_2025", "geometry"}
    for path in paths:
        frame = gpd.read_file(path)
        if not required <= set(frame.columns):
            raise RuntimeError(f"ELDM source {path.name} is missing {sorted(required - set(frame.columns))}")
        frames.append(frame.to_crs(PROJECTED_CRS))
    precincts = gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs=PROJECTED_CRS)
    precincts["geometry"] = precincts.geometry.map(polygonal)
    precincts = precincts.dropna(subset=["geometry"])
    precincts = precincts[
        precincts["Status"].fillna("").astype(str).str.casefold().eq("zoned")
        & (pd.to_numeric(precincts["AREA_2025"], errors="coerce") >= MINIMUM_AREA_HA)
    ].copy()

    records = []
    for row in precincts.itertuples():
        kind, codes, classes = _eldm_zone_context(row.geometry, zones)
        source_id = str(row.ELDM_ID).strip()
        name = str(row.Name).strip() or source_id
        records.append({
            "LGA_NAME": str(row.LGA).strip(),
            "SYM_CODE": "/".join(codes),
            "LAY_CLASS": f"{name} Employment Precinct",
            "kind": kind,
            "ha": float(row.AREA_2025),
            "source": ELDM_SOURCE,
            "source_id": source_id,
            "official_precinct": True,
            "status": "Zoned",
            "region": str(row.Region).strip(),
            "zone_codes": codes,
            "planning_classes": classes,
            "zone_id": "eldm-" + source_id.lower(),
            "geometry": row.geometry,
        })
    centres = gpd.GeoDataFrame(records, geometry="geometry", crs=PROJECTED_CRS)
    if not centres.empty and not centres["zone_id"].is_unique:
        raise RuntimeError("ELDM employment-precinct identifiers are not unique")
    return centres


def remove_eldm_overlap(epi_centres: gpd.GeoDataFrame, eldm_centres: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    if eldm_centres.empty:
        residual = epi_centres.copy()
    else:
        covered = eldm_centres.geometry.union_all()
        residual = epi_centres.copy()
        residual["geometry"] = residual.geometry.map(lambda geometry: polygonal(geometry.difference(covered)))
        residual = residual.dropna(subset=["geometry"]).explode(index_parts=False).reset_index(drop=True)
    residual["geometry"] = residual.geometry.map(polygonal)
    residual = residual.dropna(subset=["geometry"])
    residual["ha"] = residual.geometry.area / 10_000.0
    residual = residual[residual["ha"] >= MINIMUM_AREA_HA].copy()
    residual["zone_id"] = residual.apply(epi_zone_id, axis=1)
    return residual


def derive_centres(path: Path, eldm_dir: Path | None = None) -> gpd.GeoDataFrame:
    epi_centres, zones = derive_epi_centres(path)
    directory = eldm_dir if eldm_dir is not None else eldm_path(path.parent)
    eldm_centres = load_eldm_centres(directory, zones)
    epi_centres = remove_eldm_overlap(epi_centres, eldm_centres)
    centres = gpd.GeoDataFrame(
        pd.concat([eldm_centres, epi_centres], ignore_index=True),
        geometry="geometry",
        crs=PROJECTED_CRS,
    )
    centres["tier"] = centres["ha"].map(_legacy_tier)
    centres["size_band"] = centres["ha"].map(_size_band)
    if not centres["zone_id"].is_unique:
        raise RuntimeError("Employment-centre identifiers are not unique")

    points = gpd.GeoSeries(centres.geometry.representative_point(), crs=PROJECTED_CRS).to_crs("EPSG:4326")
    centres["lon"] = points.x
    centres["lat"] = points.y
    return centres.sort_values(
        ["official_precinct", "LGA_NAME", "LAY_CLASS", "SYM_CODE", "zone_id"],
        ascending=[False, True, True, True, True],
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
        "sizeBand": row.size_band,
        "ha": round(float(row.ha), 1),
        "lga": row.LGA_NAME,
        "lon": round(float(row.lon), 5),
        "lat": round(float(row.lat), 5),
        "source": row.source,
        "sourceId": row.source_id,
        "officialPrecinct": bool(row.official_precinct),
        "status": row.status,
        "region": row.region,
        "zoneCodes": row.zone_codes,
        "planningClasses": row.planning_classes,
        "assessmentBasis": ASSESSMENT_BASIS,
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
    directory = eldm_path(raw_dir)
    centres = derive_centres(path, directory)
    print(f"employment source polygons: {len(gpd.read_file(path)):,}")
    official = int(centres["official_precinct"].sum())
    print(f"current ELDM precincts >= {MINIMUM_AREA_HA:g} ha: {official:,}")
    print(f"EPI fallback centres >= {MINIMUM_AREA_HA:g} ha: {len(centres) - official:,}")
    print(f"employment centres >= {MINIMUM_AREA_HA:g} ha: {len(centres):,}")
    if args.apply:
        write_outputs(centres)
        print("wrote employment centre summaries and map outlines")
    else:
        print("dry run only; use --apply to write dashboard data")


if __name__ == "__main__":
    main()
