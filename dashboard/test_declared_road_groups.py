import unittest

from rebuild_road_units import (
    apply_measured_mandatory_gates,
    combined_boolean,
    criteria_area,
    declared_group_reason,
)


def unit(number, admin_class, name):
    return {
        "source_road_number": number,
        "admin_class": admin_class,
        "primary_name": name,
    }


class DeclaredRoadGroupingTest(unittest.TestCase):
    def test_state_highway_sections_form_one_declared_road(self):
        rows = [
            unit("0000029", "S", "KAMILAROI"),
            unit("0000029", "S", "KAMILAROI"),
        ]
        self.assertEqual(
            declared_group_reason("0000029", rows),
            "official State Highway number",
        )

    def test_same_named_regional_sections_form_one_declared_road(self):
        rows = [
            unit("0000237", "R", "GRENFELL-ORANGE"),
            unit("0000237", "R", "GRENFELL-ORANGE"),
        ]
        self.assertEqual(
            declared_group_reason("0000237", rows),
            "same classified road number and current class",
        )

    def test_different_named_regional_sections_share_the_classified_road(self):
        rows = [
            unit("0000241", "R", "MILVALE"),
            unit("0000241", "R", "MURRINGO"),
            unit("0000241", "R", "GUNNING - TEMORA"),
        ]
        self.assertEqual(
            declared_group_reason("0000241", rows),
            "same classified road number and current class",
        )

    def test_unnumbered_same_name_components_stay_separate(self):
        rows = [
            unit("", "R", "MAIN"),
            unit("", "R", "MAIN"),
        ]
        self.assertIsNone(declared_group_reason("n:main", rows))

    def test_mixed_class_identifier_stays_separate(self):
        rows = [
            unit("0000057", "R", "WEST WYALONG-CONDOBOLIN"),
            unit("0000057", "S", "GOLDFIELDS"),
        ]
        self.assertIsNone(declared_group_reason("0000057", rows))

    def test_known_reused_identifier_stays_separate(self):
        rows = [
            unit("0000057", "R", "SAME NAME"),
            unit("0000057", "R", "SAME NAME"),
        ]
        self.assertIsNone(declared_group_reason("0000057", rows))

    def test_mandatory_gate_is_conservative_across_sections(self):
        self.assertTrue(combined_boolean([True, True]))
        self.assertFalse(combined_boolean([True, False]))
        self.assertIsNone(combined_boolean([True, None]))

    def test_zone_selects_the_criteria_family(self):
        self.assertEqual(criteria_area("urban"), "urban")
        self.assertEqual(criteria_area("regional"), "rural")
        self.assertEqual(criteria_area("remote"), "rural")

    def test_single_unit_legacy_gates_are_replaced_by_measured_coverage(self):
        criteria = {
            "cls": "Regional",
            "opt": {"centres": True, "dest": True},
            "optMet": 2,
            "mand": {"pbs1": True, "bdouble": True},
            "verdict": "green",
        }
        updated = apply_measured_mandatory_gates(
            criteria,
            {"pbs1": False, "bdouble": False},
        )
        self.assertFalse(updated["mand"]["pbs1"])
        self.assertFalse(updated["mand"]["bdouble"])
        self.assertEqual(updated["verdict"], "red")
        self.assertTrue(criteria["mand"]["pbs1"])


if __name__ == "__main__":
    unittest.main()
