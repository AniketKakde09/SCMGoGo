"""Opt-in sprint preview and explicitly approved Jira sprint assignment.

Does not alter existing forecast, Jira creation, or canvas persistence.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from hashlib import sha256
import json
import os
import re
import threading
import uuid
from typing import Any
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/planning/sprints", tags=["Smart Sprint Planner"])
_PREVIEWS: dict[str, dict[str, Any]] = {}
_LOCK = threading.RLock()
_KEY = re.compile(r"^[A-Z][A-Z0-9_]*-\d+$", re.I)

class Work(BaseModel):
    id: str = Field(min_length=1)
    title: str = ""
    points: float = Field(gt=0, le=10000)
    jira_key: str | None = None
    current_sprint_id: int | None = None
    committed: bool = False
    team: str = "default"

class Sprint(BaseModel):
    id: int = Field(gt=0)
    name: str
    start: date
    end: date
    capacity_points: float = Field(ge=0)
    team: str = "default"
    committed: bool = False
    working_days_override: int | None = Field(default=None, ge=0, le=31)

class PreviewRequest(BaseModel):
    tickets: list[Work] = Field(min_length=1, max_length=1000)
    dependencies: list[tuple[str, str]] = Field(default_factory=list)  # prerequisite, dependent
    sprints: list[Sprint] = Field(min_length=1, max_length=100)
    holidays: list[date] = Field(default_factory=list)
    holiday_by_team: dict[str, list[date]] = Field(default_factory=dict)
    velocity_points: dict[str, float] = Field(default_factory=dict)
    baseline_workdays: int = Field(default=10, ge=1, le=31)

class ApplyRequest(BaseModel):
    preview_id: str
    confirmation: str
    allow_committed_changes: bool = False


def plan(req: PreviewRequest) -> dict[str, Any]:
    tickets = {t.id: t for t in req.tickets}
    if len(tickets) != len(req.tickets):
        raise ValueError("Duplicate ticket IDs")
    sprints = sorted(req.sprints, key=lambda s: (s.start, s.id))
    if len({s.id for s in sprints}) != len(sprints):
        raise ValueError("Duplicate sprint IDs")
    if any(s.end < s.start for s in sprints):
        raise ValueError("Sprint end must not precede start")
    for team, velocity in req.velocity_points.items():
        if velocity <= 0:
            raise ValueError(f"Velocity must be positive for {team}")
    predecessors: dict[str, set[str]] = {key: set() for key in tickets}
    successors: dict[str, set[str]] = {key: set() for key in tickets}
    for before, after in req.dependencies:
        if before not in tickets or after not in tickets or before == after:
            raise ValueError(f"Invalid dependency {before} -> {after}")
        predecessors[after].add(before)
        successors[before].add(after)
    indegree = {key: len(predecessors[key]) for key in tickets}
    ready = sorted(key for key, degree in indegree.items() if degree == 0)
    order = []
    while ready:
        key = ready.pop(0)
        order.append(key)
        for child in sorted(successors[key]):
            indegree[child] -= 1
            if indegree[child] == 0:
                ready.append(child)
                ready.sort()
    if len(order) != len(tickets):
        raise ValueError("Dependency cycle detected; no sprint assignments proposed")
    holidays = set(req.holidays)
    remaining = {}
    capacity_details = []
    for sprint in sprints:
        weekday_dates = [sprint.start + timedelta(days=d) for d in range((sprint.end-sprint.start).days + 1) if (sprint.start + timedelta(days=d)).weekday() < 5]
        team_holidays = holidays | set(req.holiday_by_team.get(sprint.team, []))
        # A dataset WorkingDays value may already exclude holidays: do not subtract twice.
        baseline = sprint.working_days_override
        if baseline is not None and baseline < len(weekday_dates):
            workdays = baseline
        else:
            workdays = max(0, (baseline if baseline is not None else len(weekday_dates)) - sum(d in team_holidays for d in weekday_dates))
        baseline_workdays = sprint.working_days_override if sprint.working_days_override is not None else req.baseline_workdays
        factor = min(1, workdays / baseline_workdays) if baseline_workdays else 0
        holiday_adjusted = sprint.capacity_points * factor
        velocity = req.velocity_points.get(sprint.team)
        effective = min(holiday_adjusted, velocity * factor) if velocity else holiday_adjusted
        remaining[sprint.id] = round(effective, 4)
        capacity_details.append({"id": sprint.id, "team": sprint.team, "working_days": workdays, "effective_capacity": round(effective, 2), "committed": sprint.committed})
    by_id = {s.id: s for s in sprints}
    assignment: dict[str, int] = {}
    conflicts = []
    # Reserve existing committed work first; never silently reassign it.
    for key in order:
        t = tickets[key]
        if t.committed:
            if t.current_sprint_id not in by_id:
                conflicts.append({"ticket_id": key, "reason": "Committed ticket has no matching sprint in the supplied plan"})
                continue
            s = by_id[t.current_sprint_id]
            if s.team != t.team:
                conflicts.append({"ticket_id": key, "reason": "Committed ticket team does not match sprint"})
                continue
            assignment[key] = s.id
            remaining[s.id] -= t.points
    for key in order:
        t = tickets[key]
        if key in assignment or t.committed:
            continue
        candidates = []
        for s in sprints:
            if s.team != t.team or s.committed or remaining[s.id] + 1e-7 < t.points:
                continue
            if any(parent not in assignment for parent in predecessors[key]):
                continue
            # Finish-to-start: prerequisites must be assigned to a strictly earlier sprint.
            if any(by_id[assignment[parent]].end >= s.start for parent in predecessors[key]):
                continue
            candidates.append(s)
        if candidates:
            chosen = candidates[0]
            assignment[key] = chosen.id
            remaining[chosen.id] -= t.points
        else:
            conflicts.append({"ticket_id": key, "reason": "No feasible unlocked sprint with capacity and completed prerequisites"})
    for key, sprint_id in assignment.items():
        for parent in predecessors[key]:
            if parent in assignment and by_id[assignment[parent]].end >= by_id[sprint_id].start:
                conflicts.append({"ticket_id": key, "reason": f"Prerequisite {parent} does not finish before this sprint"})
    changes = [{"ticket_id": key, "title": tickets[key].title, "jira_key": tickets[key].jira_key, "from_sprint_id": tickets[key].current_sprint_id, "to_sprint_id": target, "committed": tickets[key].committed} for key, target in assignment.items() if tickets[key].current_sprint_id != target]
    finish = max((by_id[sid].end for sid in assignment.values()), default=None)
    return {"heuristic": "dependency-first, risk-aware readiness; earliest unlocked capacity-feasible sprint; strict finish-to-start dependencies", "assignments": assignment, "changes": changes, "conflicts": conflicts, "capacity": capacity_details, "completion_date": finish.isoformat() if finish else None, "unscheduled": [key for key in tickets if key not in assignment], "warnings": ["Forecast is deterministic and conditional on supplied points, sprint dates, capacity, velocity, holidays and dependency completeness.", "Committed work is reserved before new work; over-capacity committed sprints are reported, not changed."] + [f"Committed sprint {s.id} exceeds effective capacity" for s in sprints if s.committed and remaining[s.id] < -1e-7]}

@router.post("/preview")
def preview(req: PreviewRequest):
    try:
        result = plan(req)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    preview_id = uuid.uuid4().hex
    with _LOCK:
        _PREVIEWS[preview_id] = {"request": req, "result": result, "created": datetime.now(timezone.utc), "used": False}
    return {"preview_id": preview_id, **result}



class DatasetPreviewRequest(BaseModel):
    # Internal SprintID (SPR-04) and Jira numeric sprint ID are different namespaces.
    jira_sprint_ids: dict[str, int] = Field(default_factory=dict)
    jira_issue_keys: dict[str, str] = Field(default_factory=dict)


def _dataset_request(path: Path, mappings: DatasetPreviewRequest):
    import pandas as pd
    required = ("Teams", "TeamMembers", "Sprints", "Holidays", "Backlog", "Dependencies")
    with pd.ExcelFile(path) as workbook:
        missing = [name for name in required if name not in workbook.sheet_names]
        if missing:
            raise ValueError("Missing planning sheets: " + ", ".join(missing))
        sheets = {name: pd.read_excel(workbook, sheet_name=name).rename(columns=lambda col: str(col).strip()) for name in required}
    teams, members, sprint_df, holiday_df, backlog, dep_df = (sheets[name] for name in required)
    def value(v):
        return "" if pd.isna(v) else str(v).strip()
    def number(v, default=0.0):
        return default if pd.isna(v) or str(v).strip() == "" else float(v)
    def date_value(v):
        d = pd.to_datetime(v, errors="coerce")
        if pd.isna(d):
            raise ValueError(f"Invalid sprint or holiday date: {v}")
        return d.date()
    sprint_names = [value(row["SprintID"]) for _, row in sprint_df.iterrows()]
    if not all(sprint_names) or len(set(sprint_names)) != len(sprint_names):
        raise ValueError("SprintID values must be nonempty and unique")
    unknown = set(mappings.jira_sprint_ids) - set(sprint_names)
    if unknown:
        raise ValueError("Unknown dataset sprint IDs in Jira mapping: " + ", ".join(sorted(unknown)))
    if any(not isinstance(v, int) or v <= 0 for v in mappings.jira_sprint_ids.values()):
        raise ValueError("Jira sprint IDs must be positive integers")
    if len(set(mappings.jira_sprint_ids.values())) != len(mappings.jira_sprint_ids):
        raise ValueError("Jira sprint IDs must be unique")
    sprint_numeric = {sid: i + 1 for i, sid in enumerate(sprint_names)}
    sprint_status = {value(row["SprintID"]): value(row.get("Status")).lower() for _, row in sprint_df.iterrows()}
    holidays_by_team: dict[str, list[date]] = {}
    for _, row in holiday_df.iterrows():
        team = value(row.get("ImpactedTeamID"))
        if team:
            holidays_by_team.setdefault(team, []).append(date_value(row["Date"]))
    team_velocity = {value(row["TeamID"]): number(row.get("BaseVelocityPts")) for _, row in teams.iterrows()}
    if not all(v > 0 for v in team_velocity.values()):
        raise ValueError("Teams.BaseVelocityPts must be positive")
    sprints = []
    for _, row in sprint_df.iterrows():
        sid = value(row["SprintID"])
        status = sprint_status[sid]
        sprints.append(Sprint(id=sprint_numeric[sid], name=value(row.get("SprintName")) or sid,
            start=date_value(row["StartDate"]), end=date_value(row["EndDate"]),
            capacity_points=number(row.get("PlannedCapacityPts")), team=value(row["TeamID"]),
            committed=status not in ("future", "planned", "planning", "not started", "not started yet"),
            working_days_override=int(number(row.get("WorkingDays"))) if value(row.get("WorkingDays")) else None))
    member_team = {value(row["MemberID"]): value(row["TeamID"]) for _, row in members.iterrows()}
    sprint_team = {value(row["SprintID"]): value(row["TeamID"]) for _, row in sprint_df.iterrows()}
    # Use explicit assignee/sprint first; an unmatched layer is surfaced, not guessed.
    layer_keywords = {"infrastructure": ("booking", "infrastructure"), "identity": ("booking", "security"),
        "data": ("telematics", "data"), "backend": ("booking", "integration", "api"),
        "frontend": ("web", "mobile", "frontend"), "integrations": ("integration", "api"),
        "qa": ("booking", "quality", "security"), "security": ("security", "release"),
        "release": ("security", "release")}
    def derive_team(row):
        assignee, sid = value(row.get("AssigneeID")), value(row.get("SprintID"))
        if assignee in member_team:
            return member_team[assignee]
        if sid in sprint_team:
            return sprint_team[sid]
        layer = value(row.get("Layer")).lower()
        keywords = layer_keywords.get(layer, tuple(w for w in layer.split() if len(w) > 3))
        scored = []
        for _, team_row in teams.iterrows():
            text = (value(team_row.get("TeamName")) + " " + value(team_row.get("Product / Service"))).lower()
            score = sum(word in text for word in keywords)
            if score:
                scored.append((-score, value(team_row["TeamID"])))
        return sorted(scored)[0][1] if scored else ""
    derived_teams = backlog.apply(derive_team, axis=1)
    valid_ids = set(value(v) for v in backlog["TicketID"])
    unknown_issues = set(mappings.jira_issue_keys) - valid_ids
    if unknown_issues:
        raise ValueError("Unknown dataset ticket IDs in Jira mapping: " + ", ".join(sorted(unknown_issues)))
    tickets = []
    warnings = []
    skipped = []
    for index, row in backlog.iterrows():
        tid = value(row["TicketID"])
        if value(row.get("Type")).lower() not in ("story", "task", "sub-task", "subtask"):
            continue
        points = number(row.get("StoryPoints"))
        if points <= 0:
            skipped.append(tid)
            continue
        team = value(derived_teams.loc[index])
        if team not in team_velocity:
            skipped.append(tid)
            warnings.append(f"{tid}: cannot establish a team from assignee, sprint or architecture layer")
            continue
        sid = value(row.get("SprintID"))
        if value(row.get("Status")).lower() in ("done", "completed", "closed") and not sid:
            skipped.append(tid)
            warnings.append(f"{tid}: completed ticket has no sprint; excluded from new scheduling")
            continue
        if sid and sid not in sprint_numeric:
            skipped.append(tid)
            warnings.append(f"{tid}: assigned to unknown dataset sprint {sid}")
            continue
        jira_key = mappings.jira_issue_keys.get(tid)
        if jira_key and not _KEY.fullmatch(jira_key):
            raise ValueError(f"Invalid Jira issue key mapping for {tid}")
        # A Jira issue is writable only when BOTH its issue key and target sprint are verified mappings.
        tickets.append(Work(id=tid, title=value(row.get("Title")), points=points,
            jira_key=jira_key, current_sprint_id=sprint_numeric.get(sid),
            committed=bool(sid and sprint_status[sid] not in ("future", "planned", "planning", "not started", "not started yet")),
            team=team))
    included = {t.id for t in tickets}
    deps = []
    for _, row in dep_df.iterrows():
        # Dataset column explicitly states: FromTicketID depends on ToTicketID.
        dependent, prerequisite = value(row.get("FromTicketID")), value(row.get("ToTicketID (depends on)"))
        if dependent in included and prerequisite in included:
            deps.append((prerequisite, dependent))
        elif dependent in included and prerequisite in valid_ids:
            warnings.append(f"{dependent}: prerequisite {prerequisite} is outside schedulable work; verify manually")
    if not tickets:
        raise ValueError("No schedulable Story or Task tickets with positive points and known teams")
    # Jira numeric IDs are not inferred from dataset IDs. When mappings are supplied,
    # use them only for an additional explicit Jira-safe preview, not for the dataset plan.
    req = PreviewRequest(tickets=tickets, dependencies=deps, sprints=sprints,
        holiday_by_team=holidays_by_team, velocity_points=team_velocity,
        baseline_workdays=10)
    return req, sprint_numeric, warnings, skipped


@router.post("/datasets/{dataset_id}/preview")
def preview_dataset(dataset_id: str, mappings: DatasetPreviewRequest):
    from backend.main import manager
    from hashlib import sha256
    metadata = manager.read_metadata(dataset_id)
    if metadata.get("status") != "ready":
        raise HTTPException(status_code=409, detail="Dataset must be ready")
    path = manager.paths(dataset_id)["excel"]
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Dataset workbook not found")
    try:
        request, sprint_ids, warnings, skipped = _dataset_request(path, mappings)
        try:
            result = plan(request)
        except ValueError as exc:
            if "Dependency cycle detected" not in str(exc):
                raise
            # Keep the issue visible and never claim a valid plan for cyclic work.
            # Exclude the cyclic set and its downstream dependents from scheduling.
            all_ids = {t.id for t in request.tickets}
            incoming = {tid: set() for tid in all_ids}
            outgoing = {tid: set() for tid in all_ids}
            for before, after in request.dependencies:
                incoming[after].add(before)
                outgoing[before].add(after)
            ready = sorted(tid for tid in all_ids if not incoming[tid])
            processed = set()
            while ready:
                tid = ready.pop(0)
                processed.add(tid)
                for after in outgoing[tid]:
                    incoming[after].discard(tid)
                    if not incoming[after] and after not in processed and after not in ready:
                        ready.append(after)
            unresolved = all_ids - processed
            if not processed:
                raise ValueError("All schedulable tickets are blocked by dependency cycles") from exc
            reduced = request.model_copy(update={"tickets": [t for t in request.tickets if t.id in processed],
                "dependencies": [(a,b) for a,b in request.dependencies if a in processed and b in processed]})
            result = plan(reduced)
            result["conflicts"].extend({"ticket_id": tid, "reason": "Dependency cycle or downstream of a cycle; resolve dataset Dependencies before scheduling"} for tid in sorted(unresolved))
            result["unscheduled"].extend(sorted(unresolved))
            result["completion_date"] = None
            result["warnings"].append("Completion cannot be forecast while dependency cycles remain unresolved.")
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    # An internal dataset sprint ID must NEVER be passed to Jira as if it were a Jira ID.
    reverse = {numeric: sid for sid, numeric in sprint_ids.items()}
    for entry in result["capacity"]:
        entry["dataset_sprint_id"] = reverse[entry["id"]]
        entry["name"] = next(s.name for s in request.sprints if s.id == entry["id"])
    for change in result["changes"]:
        change["from_dataset_sprint_id"] = reverse.get(change["from_sprint_id"])
        change["to_dataset_sprint_id"] = reverse[change["to_sprint_id"]]
        target_jira_id = mappings.jira_sprint_ids.get(change["to_dataset_sprint_id"])
        if not target_jira_id:
            change["jira_key"] = None
        else:
            change["jira_sprint_id"] = target_jira_id
    result["dataset_sprints"] = sprint_ids
    result["dataset_warnings"] = warnings
    result["skipped_tickets"] = skipped
    result["source"] = "uploaded_dataset"
    result["warnings"].append("Dataset SprintID values are not Jira sprint IDs; sync requires explicit Jira issue and sprint mappings.")
    preview_id = uuid.uuid4().hex
    # The Jira sync engine expects Jira sprint IDs. A separate request is stored
    # only when every writable change has a verified target Jira sprint mapping.
    jira_changes = [dict(c, to_sprint_id=c.get("jira_sprint_id")) for c in result["changes"] if c.get("jira_key") and c.get("jira_sprint_id")]
    sync_result = dict(result, changes=jira_changes)
    with _LOCK:
        _PREVIEWS[preview_id] = {"request": request, "result": sync_result,
            "created": datetime.now(timezone.utc), "used": False,
            "dataset_path": str(path), "dataset_sha256": sha256(path.read_bytes()).hexdigest()}
    return {"preview_id": preview_id, **result, "jira_sync_ready": bool(jira_changes) and not result["conflicts"]}

def _jira_session():
    import requests
    from requests.auth import HTTPBasicAuth
    from jira_sync import JIRA_URL, USER_ID, API_TOKEN
    if not USER_ID or not API_TOKEN or "Jiraserver.com" in JIRA_URL:
        raise HTTPException(status_code=503, detail="Jira credentials and URL are not configured")
    session = requests.Session()
    session.auth = HTTPBasicAuth(USER_ID, API_TOKEN)
    session.headers.update({"Accept": "application/json", "Content-Type": "application/json"})
    return session, JIRA_URL

@router.post("/apply")
def apply(req: ApplyRequest):
    if req.confirmation != "SYNC APPROVED SPRINTS":
        raise HTTPException(status_code=400, detail="Explicit confirmation required: SYNC APPROVED SPRINTS")
    with _LOCK:
        record = _PREVIEWS.get(req.preview_id)
        if not record or record["used"] or (datetime.now(timezone.utc) - record["created"]).total_seconds() > 900:
            raise HTTPException(status_code=409, detail="Preview missing, expired, or already applied; generate a new preview")
        result = record["result"]
        if record.get("dataset_path"):
            from hashlib import sha256
            dataset_path = Path(record["dataset_path"])
            if not dataset_path.is_file() or sha256(dataset_path.read_bytes()).hexdigest() != record["dataset_sha256"]:
                raise HTTPException(status_code=409, detail="Dataset changed since preview; generate a new preview")
        if result["conflicts"]:
            raise HTTPException(status_code=409, detail="Resolve all scheduling conflicts before Jira sync")
        changes = [change for change in result["changes"] if change["jira_key"]]
        if any(not _KEY.fullmatch(change["jira_key"]) for change in changes):
            raise HTTPException(status_code=422, detail="Invalid Jira issue key")
        if any(change["committed"] for change in changes) and not req.allow_committed_changes:
            raise HTTPException(status_code=409, detail="Committed sprint change requires separate explicit approval")
    if not changes:
        return {"status": "no_jira_changes", "applied": [], "failed": [], "skipped_drafts": len(result["changes"])}
    session, base = _jira_session()
    # Preflight all target sprints and current Jira sprint state before any mutation.
    from jira_sync import SPRINT_FIELD
    for change in changes:
        key, target = change["jira_key"], change["to_sprint_id"]
        try:
            sr = session.get(f"{base}/rest/agile/1.0/sprint/{target}", timeout=15)
            sr.raise_for_status()
            if sr.json().get("state", "").lower() != "future":
                raise ValueError(f"Target sprint {target} must be future")
            ir = session.get(f"{base}/rest/api/2/issue/{key}", params={"fields": SPRINT_FIELD}, timeout=15)
            ir.raise_for_status()
            field = ir.json().get("fields", {}).get(SPRINT_FIELD)
            # Jira Server can encode sprint metadata as strings; unknown shapes are unsafe.
            if field is not None and not isinstance(field, list):
                raise ValueError(f"Cannot verify current sprint state for {key}; refusing to move")
            for sprint in field or []:
                if not isinstance(sprint, dict):
                    raise ValueError(f"Cannot verify sprint state for {key}; refusing to move")
                if sprint.get("state", "").lower() in ("active", "closed"):
                    if not req.allow_committed_changes:
                        raise ValueError(f"{key} belongs to an active or closed sprint; explicit approval required")
                    if sprint.get("state", "").lower() == "closed":
                        raise ValueError(f"{key} belongs to a closed sprint; manual Jira review required")
        except Exception as exc:
            raise HTTPException(status_code=409, detail=f"Jira preflight failed; nothing changed: {str(exc)[:250]}") from exc
    with _LOCK:
        if record["used"]:
            raise HTTPException(status_code=409, detail="Preview already applied")
        record["used"] = True
    applied, failed = [], []
    for change in changes:
        key, target = change["jira_key"], change["to_sprint_id"]
        try:
            sprint_response = session.get(f"{base}/rest/agile/1.0/sprint/{target}", timeout=15)
            sprint_response.raise_for_status()
            state = sprint_response.json().get("state", "").lower()
            if state != "future":
                raise ValueError(f"Target sprint {target} is {state or 'unknown'}; only future sprints are writable")
            issue_response = session.get(f"{base}/rest/api/2/issue/{key}", params={"fields": "key"}, timeout=15)
            issue_response.raise_for_status()
            response = session.post(f"{base}/rest/agile/1.0/sprint/{target}/issue", json={"issues": [key]}, timeout=20)
            response.raise_for_status()
            applied.append({"jira_key": key, "sprint_id": target})
        except Exception as exc:
            failed.append({"jira_key": key, "sprint_id": target, "error": str(exc)[:300]})
    return {"status": "partial" if failed else "completed", "applied": applied, "failed": failed, "skipped_drafts": len(result["changes"]) - len(changes), "note": "Only existing Jira issues were moved; local draft sprint fields are not automatically changed."}
