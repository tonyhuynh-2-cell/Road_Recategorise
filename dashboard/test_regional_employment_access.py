import unittest

import geopandas as gpd
from shapely.geometry import LineString, box

from regional_employment_access import MAX_NETWORK_PATH_M, _candidate_pairs, shortest_access_path


class RegionalEmploymentAccessTest(unittest.TestCase):
    route = LineString([(0, -100), (0, 100)])
    employment = box(900, -50, 1_000, 50)

    def segments(self, lines):
        return gpd.GeoDataFrame(geometry=lines, crs="EPSG:3577")

    def test_continuous_local_street_connects(self):
        path = shortest_access_path(
            self.route,
            self.employment,
            self.segments([
                LineString([(0, 0), (500, 0)]),
                LineString([(500, 0), (950, 0)]),
            ]),
        )
        self.assertIsNotNone(path)
        self.assertLessEqual(path, MAX_NETWORK_PATH_M)

    def test_disconnected_streets_do_not_connect(self):
        path = shortest_access_path(
            self.route,
            self.employment,
            self.segments([
                LineString([(0, 0), (400, 0)]),
                LineString([(600, 0), (950, 0)]),
            ]),
        )
        self.assertIsNone(path)

    def test_overlong_path_is_rejected(self):
        path = shortest_access_path(
            self.route,
            box(2_900, -50, 3_000, 50),
            self.segments([LineString([(0, 0), (2_950, 0)])]),
        )
        self.assertIsNone(path)

    def test_candidate_selection_uses_size_decision_not_legacy_tier(self):
        routes = gpd.GeoDataFrame(
            {"geometry": [self.route]},
            index=["remote-unit"],
            crs="EPSG:3577",
        )
        evidence = {
            "remote-unit": {
                "employment": [
                    {
                        "zoneId": "qualifies-by-size",
                        "name": "Small remote employment centre",
                        "ha": 5.5,
                        "tier": "Local",
                        "size_qualifies": True,
                        "size_threshold_ha": 5,
                        "relation": "nearby",
                        "distance_m": 500,
                    },
                    {
                        "zoneId": "below-size-rule",
                        "name": "Below threshold",
                        "ha": 4.9,
                        "tier": "Major",
                        "size_qualifies": False,
                        "size_threshold_ha": 5,
                        "relation": "nearby",
                        "distance_m": 500,
                    },
                ]
            }
        }

        pairs, direct = _candidate_pairs(evidence, routes)

        self.assertIn("qualifies-by-size", pairs)
        self.assertNotIn("below-size-rule", pairs)
        self.assertFalse(direct)


if __name__ == "__main__":
    unittest.main()
