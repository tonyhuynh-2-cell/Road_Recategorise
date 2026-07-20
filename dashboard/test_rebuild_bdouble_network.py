import unittest

import geopandas as gpd
from shapely.geometry import LineString

from rebuild_bdouble_network import ACCESS_THRESHOLD, route_coverage


class RouteCoverageTest(unittest.TestCase):
    def coverage(self, road, network):
        roads = gpd.GeoDataFrame(geometry=[road], crs="EPSG:3577")
        approved = gpd.GeoDataFrame(geometry=[network], crs="EPSG:3577")
        return route_coverage(roads, approved, tolerance_m=50)[0]

    def test_parallel_route_is_fully_covered(self):
        fraction = self.coverage(
            LineString([(0, 0), (1_000, 0)]),
            LineString([(0, 10), (1_000, 10)]),
        )
        self.assertGreaterEqual(fraction, ACCESS_THRESHOLD)

    def test_crossing_does_not_approve_whole_road(self):
        fraction = self.coverage(
            LineString([(0, 0), (1_000, 0)]),
            LineString([(500, -500), (500, 500)]),
        )
        self.assertLess(fraction, ACCESS_THRESHOLD)
        self.assertAlmostEqual(fraction, 0.1, places=2)

    def test_endpoint_touch_does_not_approve_whole_road(self):
        fraction = self.coverage(
            LineString([(0, 0), (1_000, 0)]),
            LineString([(0, -500), (0, 0)]),
        )
        self.assertLess(fraction, ACCESS_THRESHOLD)
        self.assertLess(fraction, 0.1)


if __name__ == "__main__":
    unittest.main()
