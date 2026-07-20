import unittest
from datetime import date

import pandas as pd

from rebuild_adt import (
    apply_traffic_criteria,
    latest_complete_year,
    latest_station_observations,
    names_match,
    normalise_road_number,
    select_road_observation,
)


def row(station, year, classification, count, direction="PRESCRIBED AND COUNTER", partial="false"):
    return {
        "station_key": station,
        "year": year,
        "classification_type": classification,
        "traffic_count": count,
        "traffic_direction_name": direction,
        "period": "ALL DAYS",
        "partial_year": partial,
        "data_reliability": 100,
    }


class RebuildAdtTest(unittest.TestCase):
    def test_latest_completed_year_is_previous_calendar_year(self):
        self.assertEqual(latest_complete_year(date(2026, 7, 20)), 2025)

    def test_road_number_normalisation(self):
        self.assertEqual(normalise_road_number(29), "0000029")
        self.assertEqual(normalise_road_number("664"), "0000664")
        self.assertEqual(normalise_road_number(-10), "")

    def test_names_match_without_road_type(self):
        self.assertTrue(names_match(["Golden Highway"], ["GOLDEN HIGHWAY"]))
        self.assertFalse(names_match(["Golden Highway"], ["Kamilaroi Highway"]))

    def test_newest_station_year_wins_and_hv_uses_same_year(self):
        summary = pd.DataFrame([
            row("A", 2010, "ALL VEHICLES", 20000),
            row("A", 2010, "HEAVY VEHICLES", 3000),
            row("A", 2024, "ALL VEHICLES", 5000),
            row("A", 2024, "HEAVY VEHICLES", 500),
            row("A", 2026, "ALL VEHICLES", 9000),
        ])
        result = latest_station_observations(summary, 2025).iloc[0]
        self.assertEqual(result["year"], 2024)
        self.assertEqual(result["aadt"], 5000)
        self.assertEqual(result["hv_pct"], 10.0)

    def test_separate_directions_are_summed(self):
        summary = pd.DataFrame([
            row("A", 2024, "ALL VEHICLES", 2400, "PRESCRIBED"),
            row("A", 2024, "ALL VEHICLES", 2600, "COUNTER"),
            row("A", 2024, "HEAVY VEHICLES", 240, "PRESCRIBED"),
            row("A", 2024, "HEAVY VEHICLES", 260, "COUNTER"),
        ])
        result = latest_station_observations(summary, 2025).iloc[0]
        self.assertEqual(result["aadt"], 5000)
        self.assertEqual(result["hv_pct"], 10.0)

    def test_road_selection_prioritises_year_then_classification(self):
        selected = select_road_observation([
            {"station_key": "old", "year": 2010, "aadt": 50000, "hv_pct": 10.0, "dist_m": 2},
            {"station_key": "new", "year": 2024, "aadt": 4000, "hv_pct": None, "dist_m": 4},
        ])
        self.assertEqual(selected["station_key"], "new")
        self.assertEqual(selected["year"], 2024)

    def test_traffic_criterion_updates_verdict(self):
        criteria = {
            "road": {
                "cls": "Regional", "area": "rural", "mand": {"bdouble": True},
                "opt": {"centres": True, "dest": False, "traffic": None},
                "optMet": 1, "verdict": "orange",
            }
        }
        apply_traffic_criteria(criteria, {"road": {"aadt": 4000, "hv_pct": 8.0}})
        self.assertTrue(criteria["road"]["opt"]["traffic"])
        self.assertEqual(criteria["road"]["verdict"], "green")


if __name__ == "__main__":
    unittest.main()
