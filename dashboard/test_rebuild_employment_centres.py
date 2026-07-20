import unittest

import geopandas as gpd
from shapely.geometry import box

from rebuild_employment_centres import (
    employment_size_qualifies,
    employment_size_threshold,
    remove_eldm_overlap,
)


class EmploymentCentresTest(unittest.TestCase):
    def test_zone_thresholds_are_area_only(self):
        self.assertEqual(employment_size_threshold("urban"), 40)
        self.assertEqual(employment_size_threshold("regional"), 15)
        self.assertEqual(employment_size_threshold("remote"), 5)
        self.assertTrue(employment_size_qualifies(5, "remote"))
        self.assertFalse(employment_size_qualifies(5, "regional"))

    def test_eldm_geometry_takes_precedence_over_epi_overlap(self):
        epi = gpd.GeoDataFrame(
            {
                "LGA_NAME": ["Test"],
                "SYM_CODE": ["E4"],
                "LAY_CLASS": ["General Industrial"],
                "kind": ["Industrial"],
                "source": ["EPI"],
                "source_id": [""],
                "official_precinct": [False],
                "status": ["Zoned"],
                "region": [""],
                "zone_codes": [["E4"]],
                "planning_classes": [["General Industrial"]],
                "geometry": [box(0, 0, 1_000, 1_000)],
            },
            crs="EPSG:3577",
        )
        eldm = gpd.GeoDataFrame(
            {"geometry": [box(0, 0, 500, 1_000)]},
            crs="EPSG:3577",
        )

        residual = remove_eldm_overlap(epi, eldm)

        self.assertEqual(len(residual), 1)
        self.assertAlmostEqual(float(residual.iloc[0].ha), 50.0)
        self.assertEqual(float(residual.geometry.iloc[0].intersection(eldm.geometry.iloc[0]).area), 0.0)


if __name__ == "__main__":
    unittest.main()
