#!/usr/bin/env python3
"""Download the public NSW RoadSegment FeatureServer layer as a GeoPackage."""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import geopandas as gpd
import requests
from pyogrio import write_dataframe


LAYER_URL = (
    "https://portal.spatial.nsw.gov.au/server/rest/services/"
    "NSW_Transport_Theme_multiCRS/FeatureServer/5/query"
)
FIELDS = ",".join(
    (
        "OBJECTID",
        "topoid",
        "roadnamebase",
        "roadnametype",
        "roadnamesuffix",
        "functionhierarchy",
        "roadontype",
        "surface",
        "lanecount",
        "operationalstatus",
        "urbanity",
        "Shape__Length",
    )
)


def fetch_batch(session: requests.Session, last_object_id: int, batch_size: int) -> dict:
    params = {
        "f": "geojson",
        "where": f"OBJECTID > {last_object_id}",
        "outFields": FIELDS,
        "orderByFields": "OBJECTID ASC",
        "resultRecordCount": batch_size,
        "returnGeometry": "true",
        "outSR": "7844",
    }
    for attempt in range(1, 6):
        try:
            response = session.get(LAYER_URL, params=params, timeout=180)
            response.raise_for_status()
            payload = response.json()
            if "error" in payload:
                raise RuntimeError(payload["error"])
            return payload
        except (requests.RequestException, RuntimeError) as error:
            if attempt == 5:
                raise
            wait_seconds = attempt * 3
            print(
                f"Request after OBJECTID {last_object_id:,} failed ({error}); "
                f"retrying in {wait_seconds}s",
                flush=True,
            )
            time.sleep(wait_seconds)

    raise RuntimeError("Unreachable")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--batch-size", type=int, default=2_000)
    parser.add_argument(
        "--max-batches",
        type=int,
        help="Stop cleanly after this many batches so a later run can resume.",
    )
    args = parser.parse_args()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    last_object_id = 0
    append = False
    if args.output.exists() and args.output.stat().st_size > 0:
        try:
            existing = gpd.read_file(args.output, columns=["OBJECTID"])
        except Exception as error:
            print(f"Discarding unusable partial output ({error})", flush=True)
            args.output.unlink()
        else:
            if not existing.empty:
                last_object_id = int(existing["OBJECTID"].max())
                append = True
                print(f"Resuming after OBJECTID {last_object_id:,}")

    with requests.Session() as session:
        session.headers["User-Agent"] = "Road-Recategorise data export"
        total = 0
        batches = 0
        while True:
            payload = fetch_batch(session, last_object_id, args.batch_size)
            features = payload.get("features", [])
            if not features:
                break

            frame = gpd.GeoDataFrame.from_features(features, crs="EPSG:7844")
            write_dataframe(
                frame,
                args.output,
                layer="road_segments",
                driver="GPKG",
                append=append,
            )
            append = True
            last_object_id = int(frame["OBJECTID"].max())
            total += len(frame)
            batches += 1
            print(
                f"Downloaded {total:,} segments; last OBJECTID {last_object_id:,}",
                flush=True,
            )
            time.sleep(0.05)
            if args.max_batches is not None and batches >= args.max_batches:
                print(
                    f"Paused after {total:,} new segments; rerun to resume.",
                    flush=True,
                )
                return

    print(f"Complete: {total:,} new segments written to {args.output}", flush=True)


if __name__ == "__main__":
    main()
