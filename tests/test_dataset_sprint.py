"""Dataset adapter regression checks; no Jira requests or dataset mutations."""
from datetime import date
from pathlib import Path
import os
import pytest
from backend.smart_sprint import _dataset_request, DatasetPreviewRequest, PreviewRequest, Sprint, Work, plan

DATASET = Path(os.environ.get("FOREMAN_TEST_DATASET", str(Path(__file__).resolve().parents[2] / "Foreman_Synthetic_Dataset(1).xlsx")))
pytestmark = pytest.mark.skipif(not DATASET.is_file(), reason="Set FOREMAN_TEST_DATASET to the provided workbook for dataset integration tests")


def test_uploaded_dataset_read_only():
    before = DATASET.read_bytes()
    req, ids, warnings, skipped = _dataset_request(DATASET, DatasetPreviewRequest())
    assert req.tickets and req.dependencies and req.sprints
    assert "SPR-01" in ids
    assert "TEAM-01" in req.holiday_by_team
    assert all(t.jira_key is None for t in req.tickets)
    assert DATASET.read_bytes() == before


def test_dataset_sprint_id_not_assumed_jira_id():
    req, ids, _, _ = _dataset_request(DATASET, DatasetPreviewRequest(jira_sprint_ids={"SPR-04": 9876}))
    assert ids["SPR-04"] != 9876
    assert all(t.jira_key is None for t in req.tickets)


def test_unknown_mapping_rejected():
    with pytest.raises(ValueError, match="Unknown dataset sprint"):
        _dataset_request(DATASET, DatasetPreviewRequest(jira_sprint_ids={"MISSING": 99}))


def test_team_specific_holiday_does_not_affect_other_team():
    req = PreviewRequest(tickets=[Work(id="a",points=1,team="A")], sprints=[
        Sprint(id=1,name="A",start=date(2026,9,14),end=date(2026,9,25),capacity_points=20,team="A"),
        Sprint(id=2,name="B",start=date(2026,9,14),end=date(2026,9,25),capacity_points=20,team="B")],
        holiday_by_team={"A":[date(2026,9,14)]})
    result=plan(req)
    capacities={row['team']:row['effective_capacity'] for row in result['capacity']}
    assert capacities['A']==18
    assert capacities['B']==20
