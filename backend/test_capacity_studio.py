"""Run: python -m unittest test_capacity_studio.py (from backend directory)."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import capacity_studio as studio


class CapacityStudioTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.dataset_id = "a" * 32
        folder = self.root / self.dataset_id
        folder.mkdir()
        (folder / "metadata.json").write_text("{}")
        self.patcher = patch.object(studio, "ROOT", self.root)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def member(self):
        return studio.MemberCapacity(member_id="m1", display_name="Member One", team_id="team-a", sprints=[
            studio.SprintAvailability(sprint_id="s1", sprint_name="Sprint 1", start="2026-09-21", end="2026-10-02", working_days=10, leave_days=1, hours_per_day=8, focus_percent=70, support_hours=4, planned_points=8)
        ])

    def test_member_hours_and_points_remain_separate(self):
        result = studio.save_member(self.dataset_id, "m1", self.member())
        self.assertEqual(result["sprints"][0]["planned_hours"], 46.4)
        self.assertEqual(result["sprints"][0]["planned_points"], 8)
        self.assertEqual(len(studio.list_members(self.dataset_id)["members"]), 1)

    def test_scenario_edits_do_not_modify_member_or_committed_work(self):
        studio.save_member(self.dataset_id, "m1", self.member())
        original = studio.list_members(self.dataset_id)["members"]
        request = studio.Scenario(name="What if", team_id="team-a", sprint_ids=["s1"], adjustments={"m1:s1:hours": -5})
        created = studio.create_scenario(self.dataset_id, request)
        studio.edit_scenario(self.dataset_id, created["scenario_id"], studio.Scenario(name="Revised", team_id="team-a", sprint_ids=["s1"], adjustments={"m1:s1:hours": -3}))
        self.assertEqual(studio.list_members(self.dataset_id)["members"], original)
        self.assertEqual(studio.list_scenarios(self.dataset_id)["scenarios"][0]["name"], "Revised")
        self.assertEqual(set(json.loads((self.root / self.dataset_id / "capacity_studio.json").read_text())), {"members", "scenarios"})

    def test_invalid_leave_rejected(self):
        with self.assertRaises(ValueError):
            studio.SprintAvailability(sprint_id="s1", sprint_name="Sprint", start="2026-09-21", end="2026-10-02", working_days=3, leave_days=4)

    def test_unknown_dataset_rejected(self):
        with self.assertRaises(studio.HTTPException) as ctx:
            studio.list_members("b" * 32)
        self.assertEqual(ctx.exception.status_code, 404)



class CapacityStudioDailyTests(CapacityStudioTests):
    def test_leave_dates_persist_across_reads(self):
        member = self.member()
        member.sprints[0].leave_dates = [studio.date(2026, 9, 22)]
        studio.save_member(self.dataset_id, "m1", member)
        fetched = studio.list_members(self.dataset_id)["members"][0]["sprints"][0]
        self.assertEqual(fetched["leave_dates"], ["2026-09-22"])
        self.assertEqual(fetched["planned_hours"], 46.4)

    def test_invalid_leave_date_rejected(self):
        with self.assertRaises(ValueError):
            studio.SprintAvailability(sprint_id="s1", sprint_name="Sprint", start="2026-09-21", end="2026-10-02", working_days=10, leave_days=1, leave_dates=["2026-09-26"])

    def test_negative_scenario_rejected_without_mutation(self):
        studio.save_member(self.dataset_id, "m1", self.member())
        with self.assertRaises(studio.HTTPException) as ctx:
            studio.create_scenario(self.dataset_id, studio.Scenario(name="Impossible", team_id="team-a", sprint_ids=["s1"], adjustments={"m1:s1:hours": -100}))
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertEqual(studio.list_scenarios(self.dataset_id)["scenarios"], [])

    def test_unknown_member_adjustment_rejected(self):
        studio.save_member(self.dataset_id, "m1", self.member())
        with self.assertRaises(studio.HTTPException):
            studio.create_scenario(self.dataset_id, studio.Scenario(name="Invalid", team_id="team-a", sprint_ids=["s1"], adjustments={"other:s1:hours": 2}))

if __name__ == "__main__":
    unittest.main()
