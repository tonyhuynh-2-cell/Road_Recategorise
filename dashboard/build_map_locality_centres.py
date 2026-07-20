#!/usr/bin/env python3
"""Build the statewide SAL centre-point layer used by the dashboard map.

The ABS point service supplies locality names and representative coordinates;
the checked-in 2021 Census G01 table supplies population.  We retain every NSW
SAL with at least 1,000 residents because that is the guide's lowest (remote)
Town Centre population floor.  The browser progressively reveals smaller
places as the user zooms in.
"""

import csv
import json
import ssl
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen


HERE = Path(__file__).resolve().parent
POP_CSV = HERE.parent / "POI" / "Census_Population" / "2021Census_G01_NSW_SAL.csv"
OUTPUT = HERE / "data" / "nsw_locality_centres.geojson"
SERVICE = "https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/SAL/MapServer/2/query"
MIN_POPULATION = 1_000
PAGE_SIZE = 2_000


def ssl_context():
    """Use certifi on macOS Python installations whose system CA store is incomplete."""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def population_by_code():
    with POP_CSV.open(encoding="utf-8-sig", newline="") as handle:
        rows = csv.DictReader(handle)
        return {
            row["SAL_CODE_2021"].replace("SAL", ""): int(row["Tot_P_P"] or 0)
            for row in rows
        }


def fetch_nsw_points():
    features = []
    offset = 0
    while True:
        query = urlencode({
            "where": "state_code_2021 = '1'",
            "outFields": "sal_code_2021,sal_name_2021,state_code_2021",
            "returnGeometry": "true",
            "outSR": "4326",
            "resultOffset": offset,
            "resultRecordCount": PAGE_SIZE,
            "f": "geojson",
        })
        with urlopen(f"{SERVICE}?{query}", timeout=60, context=ssl_context()) as response:
            page = json.load(response)
        batch = page.get("features", [])
        features.extend(batch)
        if len(batch) < PAGE_SIZE:
            return features
        offset += len(batch)


def point_coordinates(geometry):
    coordinates = (geometry or {}).get("coordinates")
    if not coordinates:
        return None
    if (geometry or {}).get("type") == "MultiPoint":
        return coordinates[0] if coordinates else None
    return coordinates


def size_band(population):
    if population >= 20_000:
        return "regional_city"
    if population >= 7_000:
        return "major_town"
    if population >= 2_000:
        return "regional_town"
    return "remote_town"


def build():
    populations = population_by_code()
    output_features = []
    seen = set()
    for feature in fetch_nsw_points():
        props = feature.get("properties") or {}
        code = str(props.get("sal_code_2021") or "")
        population = populations.get(code, 0)
        coordinates = point_coordinates(feature.get("geometry"))
        if code in seen or population < MIN_POPULATION or not coordinates:
            continue
        seen.add(code)
        output_features.append({
            "type": "Feature",
            "properties": {
                "sal_code": code,
                "name": props.get("sal_name_2021") or "Unnamed locality",
                "population": population,
                "size_band": size_band(population),
                "source": "ABS SAL 2021 + Census 2021 G01",
            },
            "geometry": {"type": "Point", "coordinates": coordinates},
        })

    output_features.sort(key=lambda f: (-f["properties"]["population"], f["properties"]["name"]))
    result = {
        "type": "FeatureCollection",
        "metadata": {
            "minimum_population": MIN_POPULATION,
            "feature_count": len(output_features),
            "service": SERVICE.rsplit("/query", 1)[0],
            "population_table": str(POP_CSV.relative_to(HERE.parent)),
        },
        "features": output_features,
    }
    OUTPUT.write_text(json.dumps(result, ensure_ascii=True, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Wrote {len(output_features):,} locality centres to {OUTPUT}")


if __name__ == "__main__":
    build()
