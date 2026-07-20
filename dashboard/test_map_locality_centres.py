import json
import unittest
from collections import Counter
from pathlib import Path


DATA = Path(__file__).resolve().parent / "data" / "nsw_locality_centres.geojson"


class MapLocalityCentresTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = json.loads(DATA.read_text(encoding="utf-8"))
        cls.features = cls.data["features"]
        cls.by_name = {f["properties"]["name"]: f for f in cls.features}

    def test_inventory_is_unique_and_matches_metadata(self):
        codes = [f["properties"]["sal_code"] for f in self.features]
        self.assertEqual(len(codes), len(set(codes)))
        self.assertEqual(len(codes), self.data["metadata"]["feature_count"])
        self.assertGreater(len(codes), 1_200)

    def test_every_feature_meets_the_remote_population_floor(self):
        self.assertTrue(all(f["properties"]["population"] >= 1_000 for f in self.features))

    def test_requested_maitland_localities_are_present(self):
        self.assertEqual(self.by_name["Rutherford"]["properties"]["population"], 13_091)
        self.assertEqual(self.by_name["East Maitland"]["properties"]["population"], 11_860)

    def test_population_bands_match_the_documented_thresholds(self):
        counts = Counter(f["properties"]["size_band"] for f in self.features)
        self.assertEqual(counts, {
            "regional_city": 40,
            "major_town": 306,
            "regional_town": 616,
            "remote_town": 303,
        })


if __name__ == "__main__":
    unittest.main()
