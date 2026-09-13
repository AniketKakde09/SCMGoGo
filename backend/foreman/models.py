from __future__ import annotations

from datetime import date
from typing import Optional

from pydantic import BaseModel, ConfigDict


class Ticket(BaseModel):
    model_config = ConfigDict(extra="ignore")

    ticket_id: str
    type: str
    title: str
    parent_id: Optional[str] = None
    sad_section_id: Optional[str] = None
    layer: Optional[str] = None
    story_points: float = 0
    priority: Optional[str] = None
    status: Optional[str] = None
    sprint_id: Optional[str] = None
    assignee_id: Optional[str] = None
    has_acceptance_criteria: bool = True
    has_dod: bool = True


class Dependency(BaseModel):
    dependency_id: str
    from_ticket_id: str
    to_ticket_id: str
    dependency_type: Optional[str] = None
    notes: Optional[str] = None


class Sprint(BaseModel):
    sprint_id: str
    team_id: str
    sprint_name: str
    start_date: date
    end_date: date
    working_days: int
    planned_capacity_pts: float
    committed_pts: float
    status: str


class TeamMember(BaseModel):
    member_id: str
    team_id: str
    name: str
    role: str
    allocation_pct: float
    capacity_hrs_per_sprint: float


class Holiday(BaseModel):
    holiday_id: str
    impacted_team_id: str
    date: date
    holiday_name: str


class SADSection(BaseModel):
    section_id: str
    section_number: str
    section_title: str
    architecture_layer: str
    summary: str


class HealthIssue(BaseModel):
    category: str
    severity: str
    message: str
    ticket_id: Optional[str] = None
    sprint_id: Optional[str] = None
    details: Optional[dict] = None


class HealthReport(BaseModel):
    total_issues: int
    issues: list[HealthIssue]


class CapacityResult(BaseModel):
    sprint_id: str
    team_id: str
    nominal_capacity: float
    holiday_count: int
    effective_capacity: float
    committed_points: float
    remaining_capacity: float
    over_committed: bool