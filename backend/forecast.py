from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import networkx as nx
import pandas as pd
from ortools.sat.python import cp_model


PRIORITY_WEIGHT = {"Highest": 100, "High": 60, "Medium": 30, "Low": 10}
STATUS_DONE = {"done", "completed", "closed"}
WORK_TYPES = {"story", "task"}

# Used only when a ticket has neither an assignee nor a sprint. The mapping is
# intentionally derived from the dataset's team product names rather than from
# ticket IDs.
LAYER_KEYWORDS = {
    "data": ("telematics", "data"),
    "integrations": ("integration", "api"),
    "frontend": ("web", "mobile", "frontend"),
    "security": ("security", "release"),
    "release": ("security", "release"),
    "infrastructure": ("booking", "infrastructure"),
    "identity": ("booking", "security"),
    "backend": ("booking", "integration", "api"),
    "qa": ("booking", "quality", "security"),
}


def _clean(v: Any) -> Any:
    if pd.isna(v):
        return None
    if isinstance(v, (pd.Timestamp, date)):
        return v.isoformat()
    if hasattr(v, "item"):
        try:
            return v.item()
        except Exception:
            pass
    return v


def _require_sheets(sheets: dict[str, pd.DataFrame], required: list[str]) -> None:
    missing = [name for name in required if name not in sheets]
    if missing:
        raise ValueError(f"Dataset is missing required sheets: {', '.join(missing)}")


def _normalise_columns(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    out.columns = [str(c).strip() for c in out.columns]
    return out


def _team_product_text(row: pd.Series) -> str:
    return f"{row.get('TeamName', '')} {row.get('Product / Service', '')}".lower()


def _team_for_layer(layer: Any, teams: pd.DataFrame) -> str | None:
    layer_text = str(layer or "").strip().lower()
    if not layer_text:
        return None

    keywords = LAYER_KEYWORDS.get(layer_text, tuple(x for x in layer_text.replace("&", " ").split() if len(x) > 3))
    candidates: list[tuple[int, str]] = []
    for _, team in teams.iterrows():
        text = _team_product_text(team)
        score = sum(1 for keyword in keywords if keyword and keyword in text)
        if score:
            candidates.append((score, str(team["TeamID"])))
    if candidates:
        candidates.sort(key=lambda x: (-x[0], x[1]))
        return candidates[0][1]
    return None


def _derive_ticket_team(
    backlog: pd.DataFrame,
    members: pd.DataFrame,
    sprints: pd.DataFrame,
    teams: pd.DataFrame,
) -> pd.Series:
    member_team = members.set_index("MemberID")["TeamID"].astype(str).to_dict()
    sprint_team = sprints.set_index("SprintID")["TeamID"].astype(str).to_dict()

    result: list[str | None] = []
    for _, ticket in backlog.iterrows():
        team: str | None = None
        assignee = ticket.get("AssigneeID")
        sprint = ticket.get("SprintID")
        layer = ticket.get("Layer")

        if pd.notna(assignee):
            team = member_team.get(str(assignee))
        if not team and pd.notna(sprint):
            team = sprint_team.get(str(sprint))
        if not team and pd.notna(layer):
            team = _team_for_layer(layer, teams)
        result.append(team)
    return pd.Series(result, index=backlog.index, dtype="object")


def _history(backlog: pd.DataFrame, sprints: pd.DataFrame, team_id: str) -> list[dict[str, Any]]:
    team_sprints = sprints[sprints["TeamID"].astype(str) == team_id].copy()
    team_sprints["StartDate"] = pd.to_datetime(team_sprints["StartDate"], errors="coerce")
    team_sprints["EndDate"] = pd.to_datetime(team_sprints["EndDate"], errors="coerce")
    team_sprints = team_sprints.sort_values("StartDate")

    rows = []
    for _, sprint in team_sprints.iterrows():
        sid = str(sprint["SprintID"])
        done = backlog[
            (backlog["SprintID"].astype(str) == sid)
            & backlog["Status"].astype(str).str.lower().isin(STATUS_DONE)
        ]
        completed_points = float(pd.to_numeric(done["StoryPoints"], errors="coerce").fillna(0).sum())
        rows.append(
            {
                "sprint_id": sid,
                "status": str(sprint.get("Status", "")),
                "capacity_points": float(pd.to_numeric(pd.Series([sprint.get("PlannedCapacityPts")]), errors="coerce").fillna(0).iloc[0]),
                "committed_points": float(pd.to_numeric(pd.Series([sprint.get("CommittedPts")]), errors="coerce").fillna(0).iloc[0]),
                "completed_points": completed_points,
            }
        )
    return rows


def _velocity(history: list[dict[str, Any]], base_velocity: float) -> dict[str, Any]:
    completed = [x["completed_points"] for x in history if x["status"].lower() == "completed"]
    capacities = [x["capacity_points"] for x in history if x["status"].lower() == "completed" and x["capacity_points"] > 0]

    base = max(0.0, float(base_velocity or 0))
    if completed:
        average = sum(completed) / len(completed)
        recent_values = completed[-3:]
        recent = sum(recent_values) / len(recent_values)
        median = float(pd.Series(completed).median())
        # Blend empirical delivery with the dataset's base velocity. This keeps
        # sparse histories from producing an extreme forecast.
        forecast = 0.7 * recent + 0.3 * base if base else recent
        utilization = sum(completed) / sum(capacities) if capacities else None
    else:
        average = recent = median = forecast = base
        utilization = None

    if len(completed) >= 2:
        if completed[-1] > completed[0]:
            trend = "increasing"
        elif completed[-1] < completed[0]:
            trend = "decreasing"
        else:
            trend = "stable"
    else:
        trend = "insufficient_history"

    if len(completed) >= 3:
        mean = sum(completed) / len(completed)
        variance = sum((v - mean) ** 2 for v in completed) / len(completed)
        coefficient_variation = (variance**0.5) / mean if mean else None
    else:
        coefficient_variation = None

    # Confidence is a transparent heuristic, not a statistical probability.
    confidence = 0.45
    confidence += min(0.30, len(completed) * 0.10)
    if coefficient_variation is not None:
        confidence += 0.15 if coefficient_variation < 0.20 else 0.05 if coefficient_variation < 0.40 else 0
    if trend == "stable":
        confidence += 0.10
    confidence = round(min(confidence, 0.95), 2)

    return {
        "completed_sprints_used": len(completed),
        "completed_points": [round(v, 2) for v in completed],
        "average_completed_points": round(average, 2),
        "median_completed_points": round(median, 2),
        "recent_average_points": round(recent, 2),
        "base_velocity_points": round(base, 2),
        "forecast_velocity_points": round(forecast, 2),
        "historical_capacity_utilization": round(utilization, 3) if utilization is not None else None,
        "coefficient_of_variation": round(coefficient_variation, 3) if coefficient_variation is not None else None,
        "trend": trend,
        "confidence": confidence,
    }


def _future_sprints(team: pd.Series, all_sprints: pd.DataFrame, forecast_velocity: float, count: int = 12) -> list[dict[str, Any]]:
    team_id = str(team["TeamID"])
    team_sprints = all_sprints[all_sprints["TeamID"].astype(str) == team_id].copy()
    team_sprints["StartDate"] = pd.to_datetime(team_sprints["StartDate"], errors="coerce")
    team_sprints["EndDate"] = pd.to_datetime(team_sprints["EndDate"], errors="coerce")
    team_sprints = team_sprints.sort_values("StartDate")

    planned = team_sprints[team_sprints["Status"].astype(str).str.lower() == "planned"].copy()
    if not planned.empty:
        rows = []
        for _, sprint in planned.iterrows():
            planned_capacity = float(pd.to_numeric(pd.Series([sprint.get("PlannedCapacityPts")]), errors="coerce").fillna(0).iloc[0])
            # The velocity forecast is the expected deliverable throughput; the
            # workbook's planned capacity is an upper bound when it exists.
            effective_capacity = forecast_velocity if planned_capacity <= 0 else min(forecast_velocity, planned_capacity)
            rows.append(
                {
                    "sprint_id": str(sprint["SprintID"]),
                    "start": sprint["StartDate"].date(),
                    "end": sprint["EndDate"].date(),
                    "planned_capacity_points": planned_capacity,
                    "capacity": max(0.0, effective_capacity),
                    "generated": False,
                }
            )
        return rows

    if not team_sprints.empty and team_sprints["EndDate"].notna().any():
        last_end = team_sprints["EndDate"].dropna().max().date()
        start = last_end + timedelta(days=1)
    else:
        start = date.today()

    length = int(pd.to_numeric(pd.Series([team.get("SprintLengthDays", 14)]), errors="coerce").fillna(14).iloc[0])
    result = []
    for i in range(count):
        end = start + timedelta(days=max(length, 1) - 1)
        result.append(
            {
                "sprint_id": f"FORECAST-{team_id}-{i + 1:02d}",
                "start": start,
                "end": end,
                "planned_capacity_points": None,
                "capacity": max(0.0, forecast_velocity),
                "generated": True,
            }
        )
        start = end + timedelta(days=1)
    return result


def _holiday_factor(holidays: pd.DataFrame, team_id: str, start: date, end: date) -> tuple[float, list[str]]:
    if holidays.empty:
        return 1.0, []
    h = holidays.copy()
    h["Date"] = pd.to_datetime(h["Date"], errors="coerce").dt.date
    impacted = h[
        (h["ImpactedTeamID"].astype(str) == team_id)
        & h["Date"].notna()
        & (h["Date"] >= start)
        & (h["Date"] <= end)
    ]
    if impacted.empty:
        return 1.0, []

    working_days = sum((start + timedelta(days=i)).weekday() < 5 for i in range((end - start).days + 1))
    if working_days <= 0:
        return 1.0, []
    unique_dates = set(impacted["Date"].tolist())
    factor = max(0.0, min(1.0, (working_days - len(unique_dates)) / working_days))
    names = [str(x) for x in impacted["HolidayName"].dropna().tolist()]
    return factor, names


def _build_open_tickets(backlog: pd.DataFrame) -> pd.DataFrame:
    out = backlog.copy()
    out["Type"] = out["Type"].astype(str)
    out["Status"] = out["Status"].astype(str)
    out["StoryPoints"] = pd.to_numeric(out["StoryPoints"], errors="coerce").fillna(0)
    out = out[out["Type"].str.lower().isin(WORK_TYPES)]
    out = out[~out["Status"].str.lower().isin(STATUS_DONE)]
    out = out[out["StoryPoints"] > 0].copy()
    out["TicketID"] = out["TicketID"].astype(str)
    return out


def _dependency_pairs(dependencies: pd.DataFrame) -> list[tuple[str, str]]:
    pairs = []
    for _, row in dependencies.iterrows():
        source = row.get("FromTicketID")
        prerequisite = row.get("ToTicketID (depends on)")
        if pd.notna(source) and pd.notna(prerequisite):
            pairs.append((str(source), str(prerequisite)))
    return pairs


def _optimize_all(
    open_tickets: pd.DataFrame,
    teams: pd.DataFrame,
    future_by_team: dict[str, list[dict[str, Any]]],
    dependencies: pd.DataFrame,
    completed_ids: set[str],
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, Any]]:
    """Jointly optimize all teams so cross-team dependencies are enforceable."""
    model = cp_model.CpModel()
    ticket_rows = {str(r["TicketID"]): r for _, r in open_tickets.iterrows()}
    ids = list(ticket_rows)

    slots: list[tuple[str, int]] = []
    for team_id, sprints in future_by_team.items():
        slots.extend((team_id, i) for i in range(len(sprints)))
    if not ids or not slots:
        return {}, {"status": "NO_HORIZON", "tickets_optimized": len(ids), "tickets_scheduled": 0, "remaining_points": float(open_tickets["StoryPoints"].sum()) if ids else 0}

    x: dict[tuple[str, str, int], Any] = {}
    for tid in ids:
        team_id = str(ticket_rows[tid]["TeamID"])
        for _, slot_team in filter(lambda z: z[0] == team_id, slots):
            pass
        for j, _sprint in enumerate(future_by_team.get(team_id, [])):
            x[(tid, team_id, j)] = model.NewBoolVar(f"x_{tid}_{team_id}_{j}")
        model.Add(sum(x[(tid, team_id, j)] for j in range(len(future_by_team.get(team_id, [])))) <= 1)

    # Team capacity constraints.
    for team_id, sprints in future_by_team.items():
        team_ids = [tid for tid in ids if str(ticket_rows[tid]["TeamID"]) == team_id]
        for j, sprint in enumerate(sprints):
            cap = int(round(max(0.0, sprint["capacity"])))
            terms = []
            for tid in team_ids:
                points = int(round(float(ticket_rows[tid]["StoryPoints"])))
                terms.append(points * x[(tid, team_id, j)])
            model.Add(sum(terms) <= cap)

    # Dependency rule: source ticket depends on prerequisite ticket. If both are
    # scheduled, the source must be in a sprint after the prerequisite sprint.
    dep_pairs = _dependency_pairs(dependencies)
    missing_dependencies = []
    internal_dependency_count = 0
    for source, prerequisite in dep_pairs:
        if prerequisite in completed_ids:
            continue
        if source not in ticket_rows and prerequisite not in ticket_rows:
            continue
        if source not in ticket_rows or prerequisite not in ticket_rows:
            missing_dependencies.append({"from": source, "to": prerequisite, "reason": "dependency ticket is outside open forecast scope"})
            continue
        internal_dependency_count += 1
        source_team = str(ticket_rows[source]["TeamID"])
        prerequisite_team = str(ticket_rows[prerequisite]["TeamID"])
        source_sprints = future_by_team.get(source_team, [])
        prerequisite_sprints = future_by_team.get(prerequisite_team, [])
        for sj, ss in enumerate(source_sprints):
            for pj, ps in enumerate(prerequisite_sprints):
                # The prerequisite must finish before the dependent sprint starts.
                if ps["end"] >= ss["start"]:
                    model.Add(x[(source, source_team, sj)] + x[(prerequisite, prerequisite_team, pj)] <= 1)

    # Detect dependency cycles in the open graph. CP-SAT will naturally avoid
    # impossible simultaneous scheduling, while the response explicitly reports
    # the cycle as a risk.
    graph = nx.DiGraph()
    graph.add_nodes_from(ids)
    graph.add_edges_from((source, prerequisite) for source, prerequisite in dep_pairs if source in ticket_rows and prerequisite in ticket_rows)
    cycles = [cycle for cycle in nx.simple_cycles(graph) if cycle]

    objective_terms = []
    for tid, row in ticket_rows.items():
        team_id = str(row["TeamID"])
        points = int(round(float(row["StoryPoints"])))
        priority = PRIORITY_WEIGHT.get(str(row.get("Priority")), 1)
        for j in range(len(future_by_team.get(team_id, []))):
            # Maximize value and strongly prefer earlier delivery.
            position_weight = len(future_by_team[team_id]) - j
            objective_terms.append(points * priority * position_weight * x[(tid, team_id, j)])
    model.Maximize(sum(objective_terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 10.0
    solver.parameters.num_search_workers = 8
    status = solver.Solve(model)
    status_name = solver.StatusName(status)

    assignments: dict[str, list[dict[str, Any]]] = defaultdict(list)
    scheduled_ids: set[str] = set()
    for team_id, sprints in future_by_team.items():
        team_ids = [tid for tid in ids if str(ticket_rows[tid]["TeamID"]) == team_id]
        for j, sprint in enumerate(sprints):
            selected = []
            points = 0.0
            for tid in team_ids:
                var = x[(tid, team_id, j)]
                if status in (cp_model.OPTIMAL, cp_model.FEASIBLE) and solver.Value(var):
                    row = ticket_rows[tid]
                    pts = float(row["StoryPoints"])
                    points += pts
                    scheduled_ids.add(tid)
                    selected.append(
                        {
                            "ticket_id": tid,
                            "title": str(row.get("Title", "")),
                            "story_points": pts,
                            "priority": str(row.get("Priority", "")),
                            "status": str(row.get("Status", "")),
                            "dependency_parent": str(row.get("ParentID")) if pd.notna(row.get("ParentID")) else None,
                        }
                    )
            if selected:
                assignments[team_id].append(
                    {
                        "sprint_id": sprint["sprint_id"],
                        "start_date": sprint["start"].isoformat(),
                        "end_date": sprint["end"].isoformat(),
                        "capacity_points": round(sprint["capacity"], 2),
                        "planned_points": round(points, 2),
                        "utilization": round(points / sprint["capacity"], 3) if sprint["capacity"] else 0,
                        "tickets": selected,
                    }
                )

    remaining = open_tickets[~open_tickets["TicketID"].isin(scheduled_ids)]
    return assignments, {
        "status": status_name,
        "tickets_optimized": len(ids),
        "tickets_scheduled": len(scheduled_ids),
        "remaining_tickets": len(remaining),
        "remaining_points": round(float(remaining["StoryPoints"].sum()), 2),
        "internal_dependencies_enforced": internal_dependency_count,
        "out_of_scope_dependencies": missing_dependencies,
        "dependency_cycles": cycles,
        "objective_value": round(float(solver.ObjectiveValue()), 2) if status in (cp_model.OPTIMAL, cp_model.FEASIBLE) else None,
    }


def generate_forecast(excel_path: str | Path) -> dict[str, Any]:
    sheets = {name: _normalise_columns(df) for name, df in pd.read_excel(excel_path, sheet_name=None).items()}
    required = ["Teams", "TeamMembers", "Sprints", "Holidays", "Backlog", "Dependencies"]
    _require_sheets(sheets, required)

    teams = sheets["Teams"]
    members = sheets["TeamMembers"]
    sprints = sheets["Sprints"]
    holidays = sheets["Holidays"]
    backlog = sheets["Backlog"]
    dependencies = sheets["Dependencies"]

    backlog = backlog.copy()
    backlog["TeamID"] = _derive_ticket_team(backlog, members, sprints, teams)
    open_tickets = _build_open_tickets(backlog)
    open_tickets = open_tickets[open_tickets["TeamID"].notna()].copy()
    open_tickets["TeamID"] = open_tickets["TeamID"].astype(str)

    completed_ids = set(backlog.loc[backlog["Status"].astype(str).str.lower().isin(STATUS_DONE), "TicketID"].astype(str))

    velocity_by_team: dict[str, dict[str, Any]] = {}
    future_by_team: dict[str, list[dict[str, Any]]] = {}
    team_results: list[dict[str, Any]] = []

    for _, team in teams.iterrows():
        team_id = str(team["TeamID"])
        base_velocity = float(pd.to_numeric(pd.Series([team.get("BaseVelocityPts")]), errors="coerce").fillna(0).iloc[0])
        history = _history(backlog, sprints, team_id)
        velocity = _velocity(history, base_velocity)
        velocity_by_team[team_id] = velocity

        future = _future_sprints(team, sprints, velocity["forecast_velocity_points"])
        for sprint in future:
            factor, holiday_names = _holiday_factor(holidays, team_id, sprint["start"], sprint["end"])
            sprint["holiday_adjustment_factor"] = round(factor, 3)
            sprint["holiday_names"] = holiday_names
            sprint["capacity"] = round(sprint["capacity"] * factor, 2)
        future_by_team[team_id] = future

    assignments, optimization = _optimize_all(open_tickets, teams, future_by_team, dependencies, completed_ids)

    total_open = float(open_tickets["StoryPoints"].sum())
    total_scheduled = 0.0

    for _, team in teams.iterrows():
        team_id = str(team["TeamID"])
        team_open = open_tickets[open_tickets["TeamID"] == team_id]
        team_assignments = assignments.get(team_id, [])
        scheduled_points = sum(float(s["planned_points"]) for s in team_assignments)
        total_scheduled += scheduled_points
        team_remaining = float(team_open["StoryPoints"].sum()) - scheduled_points
        completion = team_assignments[-1] if team_assignments and team_remaining <= 0.001 else None

        risks: list[dict[str, Any]] = []
        velocity = velocity_by_team[team_id]
        if velocity["trend"] == "decreasing":
            risks.append({"type": "VELOCITY_TREND", "severity": "MEDIUM", "message": "Historical completed velocity is trending down."})
        if velocity["completed_sprints_used"] < 2:
            risks.append({"type": "LOW_HISTORY", "severity": "MEDIUM", "message": "Limited completed sprint history; the base velocity has a larger influence on the forecast."})
        if optimization["dependency_cycles"]:
            risks.append({"type": "DEPENDENCY_CYCLE", "severity": "HIGH", "message": "A dependency cycle exists among open forecast tickets."})
        if optimization["out_of_scope_dependencies"]:
            risks.append({"type": "CROSS_TEAM_DEPENDENCY", "severity": "HIGH", "message": "Some dependencies point outside the open forecast scope and should be validated before delivery."})
        if team_remaining > 0.001:
            risks.append({"type": "UNSCHEDULED_WORK", "severity": "HIGH", "message": "Not all open work fits within the available forecast horizon or constraints."})
        if any(s["holiday_adjustment_factor"] < 1 for s in future_by_team[team_id]):
            risks.append({"type": "HOLIDAY_CAPACITY", "severity": "LOW", "message": "At least one forecast sprint has holiday-adjusted capacity."})

        team_results.append(
            {
                "team_id": team_id,
                "team_name": str(team.get("TeamName", "")),
                "product_service": str(team.get("Product / Service", "")),
                "velocity_forecast": velocity,
                "backlog": {
                    "open_tickets": int(len(team_open)),
                    "open_points": round(float(team_open["StoryPoints"].sum()), 2),
                    "scheduled_points": round(scheduled_points, 2),
                    "remaining_points": round(max(team_remaining, 0.0), 2),
                },
                "forecast": {
                    "sprints": team_assignments,
                    "completion_sprint": completion["sprint_id"] if completion else None,
                    "completion_date": completion["end_date"] if completion else None,
                },
                "forecast_calendar": [
                    {
                        "sprint_id": s["sprint_id"],
                        "start_date": s["start"].isoformat(),
                        "end_date": s["end"].isoformat(),
                        "planned_capacity_points": s["planned_capacity_points"],
                        "forecast_capacity_points": round(s["capacity"], 2),
                        "holiday_adjustment_factor": s["holiday_adjustment_factor"],
                        "holiday_names": s["holiday_names"],
                        "generated": s["generated"],
                    }
                    for s in future_by_team[team_id]
                ],
                "risks": risks,
            }
        )

    scheduled_pct = (total_scheduled / total_open * 100) if total_open else 100.0
    return {
        "forecast_version": "2.0",
        "method": {
            "velocity": "historical completed story points blended with Teams.BaseVelocityPts",
            "optimization": "OR-Tools CP-SAT",
            "scope": "all teams with joint cross-team dependency constraints",
            "inputs": "dataset.xlsx only",
            "confidence_note": "Confidence is a heuristic based on history length, velocity variability and trend; it is not a statistical probability.",
        },
        "summary": {
            "teams": len(team_results),
            "open_tickets": int(len(open_tickets)),
            "total_open_points": round(total_open, 2),
            "total_points_scheduled": round(total_scheduled, 2),
            "total_remaining_points": round(max(total_open - total_scheduled, 0.0), 2),
            "scheduled_points_percent": round(scheduled_pct, 2),
            "optimization_status": optimization["status"],
            "dependency_cycles": optimization["dependency_cycles"],
        },
        "optimization": {
            "status": optimization["status"],
            "tickets_optimized": optimization["tickets_optimized"],
            "tickets_scheduled": optimization["tickets_scheduled"],
            "remaining_tickets": optimization["remaining_tickets"],
            "remaining_points": optimization["remaining_points"],
            "internal_dependencies_enforced": optimization["internal_dependencies_enforced"],
            "out_of_scope_dependencies": optimization["out_of_scope_dependencies"],
            "dependency_cycles": optimization["dependency_cycles"],
            "objective_value": optimization["objective_value"],
        },
        "teams": team_results,
    }
