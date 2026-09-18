"""Capacity Studio v1: self-reported availability and isolated editable scenarios.

No Jira writes, ticket assignment, story-point conversion or committed-sprint edits.
Identity is caller-supplied until Foreman integrates authenticated user identity.
"""
from __future__ import annotations

import json
import os
import re
import threading
import uuid
from datetime import date, datetime, timezone, timedelta
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator

router = APIRouter(prefix="/api/capacity", tags=["Team Capacity Studio"])
ROOT = Path(os.getenv("FOREMAN_DATASETS_DIR", str(Path(__file__).resolve().parent / "datasets")))
DATASET_ID = re.compile(r"^[a-f0-9]{32}$")
LOCK = threading.RLock()


class SprintAvailability(BaseModel):
    sprint_id: str = Field(min_length=1, max_length=100)
    sprint_name: str = Field(min_length=1, max_length=150)
    start: date
    end: date
    working_days: int = Field(ge=0, le=31)
    leave_days: float = Field(default=0, ge=0, le=31)
    hours_per_day: float = Field(default=8, gt=0, le=24)
    focus_percent: float = Field(default=70, ge=0, le=100)
    support_hours: float = Field(default=0, ge=0, le=744)
    # Points are an independent, optional TEAM planning estimate, never derived from hours.
    planned_points: float | None = Field(default=None, ge=0, le=10000)
    # Persist exact dates on the server so the heatmap works across browsers.
    leave_dates: list[date] = Field(default_factory=list, max_length=31)

    @model_validator(mode="after")
    def validate_dates(self):
        if self.end < self.start:
            raise ValueError("Sprint end must not precede start")
        if (self.end - self.start).days > 30:
            raise ValueError("Sprint duration must not exceed 31 calendar days")
        if self.leave_days > self.working_days:
            raise ValueError("Leave days cannot exceed working days")
        if len(set(self.leave_dates)) != len(self.leave_dates):
            raise ValueError("Leave dates must be unique")
        if any(d < self.start or d > self.end or d.weekday() >= 5 for d in self.leave_dates):
            raise ValueError("Leave dates must be weekdays within the sprint")
        if self.leave_dates and self.leave_days != len(self.leave_dates):
            raise ValueError("Leave days must equal the number of selected leave dates")
        actual_days = sum((self.start + timedelta(days=i)).weekday() < 5 for i in range((self.end - self.start).days + 1))
        if self.working_days > actual_days:
            raise ValueError("Working days exceed weekdays in the sprint")
        return self


class MemberCapacity(BaseModel):
    member_id: str = Field(min_length=1, max_length=120)
    display_name: str = Field(min_length=1, max_length=150)
    team_id: str = Field(min_length=1, max_length=120)
    sprints: list[SprintAvailability] = Field(min_length=1, max_length=2)

    @model_validator(mode="after")
    def unique_sprints(self):
        if len({s.sprint_id for s in self.sprints}) != len(self.sprints):
            raise ValueError("Sprint IDs must be unique")
        return self


class Scenario(BaseModel):
    name: str = Field(min_length=1, max_length=150)
    team_id: str = Field(min_length=1, max_length=120)
    sprint_ids: list[str] = Field(min_length=1, max_length=2)
    # Explicit hypothetical changes, NOT updates to member submissions or Jira.
    adjustments: dict[str, float] = Field(default_factory=dict)
    notes: str = Field(default="", max_length=2000)

    @model_validator(mode="after")
    def validate_sprints(self):
        if len(set(self.sprint_ids)) != len(self.sprint_ids):
            raise ValueError("Sprint IDs must be unique")
        if any(not key or len(key) > 120 for key in self.adjustments):
            raise ValueError("Adjustment keys must be 1-120 characters")
        if any(not re.fullmatch(r"[^:]+:[^:]+:hours", key) for key in self.adjustments):
            raise ValueError("Adjustments must use member:sprint:hours keys")
        if any(not -10000 <= value <= 10000 for value in self.adjustments.values()):
            raise ValueError("Adjustment values must be within -10000 and 10000")
        return self


def _folder(dataset_id: str) -> Path:
    if not DATASET_ID.fullmatch(dataset_id):
        raise HTTPException(400, "Invalid dataset ID")
    folder = ROOT / dataset_id
    if not (folder / "metadata.json").is_file():
        raise HTTPException(404, "Dataset not found")
    return folder


def _read(folder: Path) -> dict:
    path = folder / "capacity_studio.json"
    if not path.exists():
        return {"members": {}, "scenarios": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def _write(folder: Path, data: dict) -> None:
    path = folder / "capacity_studio.json"
    temp = folder / f".capacity-{uuid.uuid4().hex}.tmp"
    try:
        temp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def _summary(member: dict) -> dict:
    sprints = []
    for s in member["sprints"]:
        available_days = s["working_days"] - s["leave_days"]
        gross_hours = available_days * s["hours_per_day"]
        planned_hours = max(0.0, gross_hours * s["focus_percent"] / 100 - s["support_hours"])
        sprints.append({**s, "available_days": available_days,
                        "gross_hours": round(gross_hours, 2),
                        "planned_hours": round(planned_hours, 2)})
    return {**member, "sprints": sprints}


@router.put("/{dataset_id}/members/{member_id}")
def save_member(dataset_id: str, member_id: str, request: MemberCapacity):
    if member_id != request.member_id:
        raise HTTPException(400, "Member ID in path and body must match")
    folder = _folder(dataset_id)
    with LOCK:
        data = _read(folder)
        member = request.model_dump(mode="json")
        member["updated_at"] = datetime.now(timezone.utc).isoformat()
        data["members"][member_id] = member
        _write(folder, data)
    return _summary(member)


@router.get("/{dataset_id}/members")
def list_members(dataset_id: str, team_id: str | None = None):
    with LOCK:
        members = _read(_folder(dataset_id))["members"].values()
        return {"members": [_summary(m) for m in members if team_id is None or m["team_id"] == team_id],
                "identity_verified": False}


def _validate_adjustments(data: dict, request: Scenario) -> None:
    members = {m["member_id"]: m for m in data["members"].values() if m["team_id"] == request.team_id}
    for key, delta in request.adjustments.items():
        member_id, sprint_id, _ = key.rsplit(":", 2)
        member = members.get(member_id)
        sprint = next((s for s in member["sprints"] if s["sprint_id"] == sprint_id), None) if member else None
        if not sprint or sprint_id not in request.sprint_ids:
            raise HTTPException(422, f"Unknown team member or sprint in adjustment: {key}")
        baseline = _summary(member)["sprints"]
        hours = next(s["planned_hours"] for s in baseline if s["sprint_id"] == sprint_id)
        if hours + delta < 0:
            raise HTTPException(422, f"Adjustment would make capacity negative: {key}")


@router.post("/{dataset_id}/scenarios", status_code=201)
def create_scenario(dataset_id: str, request: Scenario):
    folder = _folder(dataset_id)
    with LOCK:
        data = _read(folder)
        _validate_adjustments(data, request)
        scenario_id = uuid.uuid4().hex
        scenario = {**request.model_dump(mode="json"), "scenario_id": scenario_id,
                    "created_at": datetime.now(timezone.utc).isoformat(), "status": "draft"}
        data["scenarios"][scenario_id] = scenario
        _write(folder, data)
    return scenario


@router.put("/{dataset_id}/scenarios/{scenario_id}")
def edit_scenario(dataset_id: str, scenario_id: str, request: Scenario):
    folder = _folder(dataset_id)
    with LOCK:
        data = _read(folder)
        if scenario_id not in data["scenarios"]:
            raise HTTPException(404, "Scenario not found")
        _validate_adjustments(data, request)
        existing = data["scenarios"][scenario_id]
        existing.update(request.model_dump(mode="json"))
        existing["updated_at"] = datetime.now(timezone.utc).isoformat()
        _write(folder, data)
    return existing


@router.get("/{dataset_id}/scenarios")
def list_scenarios(dataset_id: str):
    with LOCK:
        return {"scenarios": list(_read(_folder(dataset_id))["scenarios"].values())}
