import json
import unittest
from pathlib import Path


DATA = Path(__file__).parent / "data"


def read_json(name):
    return json.loads((DATA / name).read_text(encoding="utf-8"))


class DeclaredRuntimeAlignmentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.assessment = read_json("nsw_assessment.geojson")
        cls.roads_payload = read_json("nsw_declared_roads.json")
        cls.roads = cls.roads_payload["roads"]
        cls.criteria = read_json("nsw_declared_criteria.json")
        cls.recat = read_json("nsw_declared_recat.json")
        cls.exports = read_json("export_declared_rows.json")

    def test_every_declared_road_has_exactly_one_criteria_result(self):
        self.assertEqual(921, len(self.roads))
        self.assertEqual(set(self.roads), set(self.criteria))

    def test_declared_classes_match(self):
        expected = {"S": "State", "R": "Regional"}
        for key, road in self.roads.items():
            self.assertEqual(expected[road["admin_class"]], self.criteria[key]["cls"], key)

    def test_every_displayed_feature_uses_its_declared_verdict(self):
        features = self.assessment["features"]
        self.assertEqual(len(features), len(self.recat))
        section_to_road = self.roads_payload["section_to_road"]
        for index, feature in enumerate(features):
            properties = feature["properties"]
            if properties.get("unit_excluded"):
                continue
            key = properties.get("declared_road")
            self.assertIn(key, self.roads, index)
            self.assertEqual(key, section_to_road.get(properties.get("road_unit")), index)
            self.assertEqual(self.criteria[key]["verdict"], self.recat[index], index)

    def test_export_has_one_row_per_declared_road(self):
        export_keys = {
            row["_key"]
            for tab in ("state", "regional")
            for row in self.exports[tab]
        }
        self.assertEqual(set(self.roads), export_keys)

    def test_browser_loads_canonical_declared_files(self):
        init_source = (Path(__file__).parent / "js" / "init.js").read_text(encoding="utf-8")
        self.assertIn("_f('data/nsw_declared_criteria.json')", init_source)
        self.assertIn("_f('data/nsw_declared_recat.json')", init_source)
        self.assertNotIn("_f('data/nsw_criteria.json')", init_source)


if __name__ == "__main__":
    unittest.main()
