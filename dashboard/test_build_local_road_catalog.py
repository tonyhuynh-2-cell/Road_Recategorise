import unittest

import geopandas as gpd
from shapely.geometry import LineString
from shapely.geometry import Point

from build_local_road_catalog import (
    NetworkCoverage,
    available_outcome,
    connected_terminal_names,
    connected_groups,
    dedupe_names,
    display_name,
    facility_connection_names,
    normalise_name,
    stable_road_id,
    terminal_points,
)


class LocalRoadCatalogTests(unittest.TestCase):
    def test_full_name_is_normalised(self):
        self.assertEqual(display_name("Amy", "Street", None), "Amy Street")
        self.assertEqual(normalise_name("Amy St."), "AMY ST")

    def test_same_name_connected_segments_form_one_road(self):
        lines = [
            LineString([(0, 0), (10, 0)]),
            LineString([(10, 0), (20, 0)]),
            LineString([(100, 0), (110, 0)]),
        ]
        groups = connected_groups(["AMY ST"] * 3, lines, [True] * 3)
        self.assertEqual(sorted(sorted(group) for group in groups), [[0, 1], [2]])

    def test_different_names_do_not_merge_at_an_intersection(self):
        lines = [
            LineString([(0, 0), (10, 0)]),
            LineString([(10, 0), (10, 10)]),
        ]
        groups = connected_groups(["AMY ST", "AUBURN RD"], lines, [True, True])
        self.assertEqual(sorted(sorted(group) for group in groups), [[0], [1]])

    def test_unnamed_segments_stay_separate(self):
        lines = [
            LineString([(0, 0), (10, 0)]),
            LineString([(10, 0), (20, 0)]),
        ]
        groups = connected_groups(["", ""], lines, [False, False])
        self.assertEqual(sorted(sorted(group) for group in groups), [[0], [1]])

    def test_ids_are_stable_across_segment_order(self):
        self.assertEqual(
            stable_road_id("AMY ST", [3, 1, 2]),
            stable_road_id("AMY ST", [2, 3, 1]),
        )

    def test_compound_centres_are_not_double_counted(self):
        self.assertEqual(
            dedupe_names(["Albury", "Albury - Wodonga", "Wagga Wagga"]),
            ["Albury", "Wagga Wagga"],
        )

    def test_state_suffix_does_not_create_a_second_centre(self):
        self.assertEqual(dedupe_names(["Lismore", "Lismore (NSW)"]), ["Lismore"])

    def test_terminal_centres_require_distinct_road_ends(self):
        terminals = [Point(0, 0), Point(1000, 0)]
        centres = gpd.GeoDataFrame(
            {"name": ["Alpha", "Beta"]},
            geometry=[Point(0, 10), Point(1000, 10)],
            crs="EPSG:3577",
        )
        self.assertEqual(
            connected_terminal_names(terminals, centres, distance_m=30),
            ["Alpha", "Beta"],
        )

    def test_short_road_inside_overlapping_centre_radii_is_not_a_connection(self):
        terminals = [Point(0, 0), Point(5, 0)]
        centres = gpd.GeoDataFrame(
            {"name": ["Nearest", "Also nearby"]},
            geometry=[Point(0, 10), Point(0, 20)],
            crs="EPSG:3577",
        )
        self.assertEqual(
            connected_terminal_names(terminals, centres, distance_m=30),
            [],
        )

    def test_facility_requires_a_centre_at_another_terminal(self):
        terminals = [Point(0, 0), Point(1000, 0)]
        facilities = gpd.GeoDataFrame(
            {"name": ["Hospital"]},
            geometry=[Point(0, 10)],
            crs="EPSG:3577",
        )
        same_end_centre = gpd.GeoDataFrame(
            {"name": ["Town"]},
            geometry=[Point(0, 5)],
            crs="EPSG:3577",
        )
        other_end_centre = gpd.GeoDataFrame(
            {"name": ["Town"]},
            geometry=[Point(1000, 5)],
            crs="EPSG:3577",
        )
        self.assertEqual(
            facility_connection_names(terminals, facilities, same_end_centre, 30),
            [],
        )
        self.assertEqual(
            facility_connection_names(terminals, facilities, other_end_centre, 30),
            ["Hospital"],
        )

    def test_terminal_points_exclude_internal_segment_junctions(self):
        lines = [
            LineString([(0, 0), (10, 0)]),
            LineString([(10, 0), (20, 0)]),
        ]
        self.assertEqual(
            {(point.x, point.y) for point in terminal_points(lines)},
            {(0.0, 0.0), (20.0, 0.0)},
        )

    def test_bdouble_coverage_does_not_pass_an_endpoint_touch(self):
        network = NetworkCoverage([LineString([(0, 0), (0, 100)])])
        fraction = network.fraction(LineString([(0, 0), (1000, 0)]))
        self.assertLess(fraction, 0.80)

    def test_available_outcome_uses_the_bdouble_gate(self):
        result = available_outcome(
            regional_centres=2,
            state_centres=0,
            regional_facilities=1,
            state_facilities=0,
            bdouble=True,
            pbs1=False,
        )
        self.assertEqual(result["status"], "potential_regional")
        self.assertEqual(result["regional_available_optional_met"], 2)
        self.assertTrue(result["regional_mandatory_gate"])

    def test_available_outcome_uses_the_pbs_level_1_gate(self):
        result = available_outcome(
            regional_centres=0,
            state_centres=2,
            regional_facilities=0,
            state_facilities=1,
            bdouble=False,
            pbs1=True,
        )
        self.assertEqual(result["status"], "potential_state")
        self.assertEqual(result["state_available_optional_met"], 2)
        self.assertTrue(result["state_mandatory_gate"])

    def test_one_regional_criterion_is_a_provisional_regional_road(self):
        result = available_outcome(
            regional_centres=2,
            state_centres=0,
            regional_facilities=0,
            state_facilities=0,
            bdouble=True,
            pbs1=False,
        )
        self.assertEqual(result["status"], "likely_regional")

    def test_one_state_criterion_is_a_provisional_state_road(self):
        result = available_outcome(
            regional_centres=0,
            state_centres=2,
            regional_facilities=0,
            state_facilities=0,
            bdouble=False,
            pbs1=True,
        )
        self.assertEqual(result["status"], "likely_state")

    def test_provisional_regional_is_preferred_over_provisional_state(self):
        result = available_outcome(
            regional_centres=2,
            state_centres=2,
            regional_facilities=0,
            state_facilities=0,
            bdouble=True,
            pbs1=True,
        )
        self.assertEqual(result["status"], "likely_regional")

    def test_no_available_evidence_is_not_described_as_a_proven_failure(self):
        result = available_outcome(
            regional_centres=0,
            state_centres=0,
            regional_facilities=0,
            state_facilities=0,
            bdouble=False,
            pbs1=False,
        )
        self.assertEqual(result["status"], "local_available")
        self.assertIn("available criteria", result["label"])


if __name__ == "__main__":
    unittest.main()
