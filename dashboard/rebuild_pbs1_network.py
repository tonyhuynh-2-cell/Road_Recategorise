#!/usr/bin/env python3
"""Measure S-09 coverage from the current official NSW PBS Level 1 network.

The former import marked an entire source feature as accessible when any part
of it touched the PBS network. This rebuild stores the actual fraction that
follows approved geometry. Run ``rebuild_road_units.py --apply`` afterwards so
all connected and declared-road assessments inherit the measured coverage.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import geopandas as gpd

from rebuild_bdouble_network import (
    ACCESS_THRESHOLD,
    DATA,
    PROJECTED_CRS,
    approved_network,
    read_json,
    route_coverage,
    write_json,
)


DEFAULT_NETWORK = (
    Path.home() / "Desktop" / "IPWEA" / "data" / "raw" / "nhvr_hvn_11240619.gpkg"
)
EXPECTED_NETWORK = "NSW- PBS Aggregate GML - Level 1"
DEFAULT_PBS1_TOLERANCE_M = 50.0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--network", type=Path, default=DEFAULT_NETWORK)
    parser.add_argument("--tolerance-m", type=float, default=DEFAULT_PBS1_TOLERANCE_M)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    if not args.network.exists():
        raise FileNotFoundError(f"NHVR GeoPackage not found: {args.network}")

    assessment = read_json("nsw_assessment.geojson")
    roads = gpd.GeoDataFrame.from_features(assessment["features"], crs="EPSG:4326")
    network = approved_network(args.network)
    network = network[network["network_name"].astype(str) == EXPECTED_NETWORK].copy()
    if network.empty:
        raise RuntimeError(
            f"Network {EXPECTED_NETWORK!r} was not found in {args.network}"
        )

    print(f"network: {EXPECTED_NETWORK}")
    print(f"approved NHVR segments: {len(network):,}")
    print(f"road source features: {len(roads):,}")
    print(f"matching tolerance: {args.tolerance_m:g} m")

    old_flags = [
        bool(feature["properties"].get("has_pbs1"))
        for feature in assessment["features"]
    ]
    fractions = route_coverage(roads, network, args.tolerance_m)
    new_flags = [fraction > ACCESS_THRESHOLD for fraction in fractions]

    for index, feature in enumerate(assessment["features"]):
        properties = feature["properties"]
        properties["pbs1_coverage"] = round(fractions[index], 6)
        properties["has_pbs1"] = int(new_flags[index])

    changed = sum(old != new for old, new in zip(old_flags, new_flags))
    print(f"source feature access flags changed: {changed:,}")
    print(
        f"source features passing S-09 coverage: "
        f"{sum(new_flags):,}/{len(new_flags):,}"
    )

    if not args.apply:
        print("dry run only; use --apply to write exact PBS Level 1 coverage")
        return

    write_json("nsw_assessment.geojson", assessment)
    print(f"wrote exact PBS Level 1 coverage to {DATA / 'nsw_assessment.geojson'}")


if __name__ == "__main__":
    main()
