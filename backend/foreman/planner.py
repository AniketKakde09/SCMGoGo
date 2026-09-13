from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import networkx as nx
import pandas as pd
from ortools.sat.python import cp_model

from .capacity import CapacityEngine
from .graph import DependencyGraph


@dataclass(frozen=True)
class PlannedItem:
    ticket_id: str
    title: str
    story_points: int
    priority: str
    sprint_id: str
    sprint_name: str
    sprint_index: int
    dependency_ids: list[str]
    dependency_level: int
    previous_sprint_id: str | None
    changed_sprint: bool


class PlanningError(RuntimeError):
    pass


class SprintPlanner:
    """CP-SAT sprint allocator backed by a NetworkX dependency graph."""

    PRIORITY_WEIGHT = {
        "Highest": 100,
        "Critical": 100,
        "High": 60,
        "Medium": 30,
        "Low": 10,
        "Lowest": 5,
    }

    def __init__(
        self,
        backlog: pd.DataFrame,
        dependencies: pd.DataFrame,
        sprints: pd.DataFrame,
        members: pd.DataFrame,
        holidays: pd.DataFrame,
    ) -> None:
        self.backlog = backlog.copy()
        self.dependencies = dependencies.copy()
        self.sprints = sprints.copy()
        self.members = members.copy()
        self.holidays = holidays.copy()
        self.graph_engine = DependencyGraph(self.backlog, self.dependencies)

    @staticmethod
    def _points(value: Any) -> int:
        try:
            return max(int(round(float(value))), 0)
        except (TypeError, ValueError):
            return 0

    def _planned_sprints(self) -> pd.DataFrame:
        result = self.sprints.copy()
        result = result[result["Status"].astype(str).str.lower() == "planned"].copy()
        result = result.sort_values("StartDate").reset_index(drop=True)
        if result.empty:
            raise PlanningError("No Planned sprints are available for scheduling.")
        return result

    def _work_items(self) -> pd.DataFrame:
        result = self.backlog[
            self.backlog["Type"].isin(["Story", "Task"])
            & ~self.backlog["Status"].astype(str).str.lower().isin({"done", "closed", "cancelled", "canceled"})
        ].copy()
        return result

    def _fixed_sprint_lookup(self) -> dict[str, str]:
        """Completed/Active assignments are treated as fixed historical/current facts."""
        lookup: dict[str, str] = {}
        for _, row in self.backlog.iterrows():
            ticket_id = row.get("TicketID")
            sprint_id = row.get("SprintID")
            if pd.isna(ticket_id) or pd.isna(sprint_id):
                continue
            status = str(row.get("Status", "")).lower()
            if status in {"done", "closed", "cancelled", "canceled", "in progress"}:
                # If the issue is already assigned to an Active/Completed sprint,
                # preserve it. In-progress may still belong to current active sprint.
                sprint_row = self.sprints[self.sprints["SprintID"] == sprint_id]
                if not sprint_row.empty:
                    sprint_status = str(sprint_row.iloc[0]["Status"]).lower()
                    if sprint_status in {"completed", "active"}:
                        lookup[str(ticket_id)] = str(sprint_id)
        return lookup

    def _capacity_by_sprint(self, planned_sprints: pd.DataFrame) -> dict[str, int]:
        # Reuse existing capacity semantics so the scheduler and dashboard agree.
        capacity_results = CapacityEngine(
            sprints=self.sprints,
            members=self.members,
            holidays=self.holidays,
        ).calculate()

        capacity_map = {
            item.sprint_id: max(int(round(item.effective_capacity)), 0)
            for item in capacity_results
        }

        return {
            str(row["SprintID"]): capacity_map.get(str(row["SprintID"]), 0)
            for _, row in planned_sprints.iterrows()
        }

    def solve(self, time_limit_seconds: float = 10.0) -> dict[str, Any]:
        planned_sprints = self._planned_sprints()
        work_items = self._work_items()

        if self.graph_engine.has_cycle():
            cycles = self.graph_engine.cycles()
            raise PlanningError(
                "Cannot schedule while dependency cycles exist. "
                f"Detected cycles: {cycles[:5]}"
            )

        fixed = self._fixed_sprint_lookup()
        planned_ids = [str(x) for x in planned_sprints["SprintID"].tolist()]
        sprint_index = {sprint_id: i for i, sprint_id in enumerate(planned_ids)}
        capacity = self._capacity_by_sprint(planned_sprints)

        # Readiness is a hard commitment gate. Items missing Acceptance Criteria
        # or Definition of Done remain in backlog and are not assigned to a sprint.
        unready: dict[str, list[str]] = {}
        candidates = []
        for _, row in work_items.iterrows():
            ticket_id = str(row["TicketID"])
            if ticket_id in fixed:
                continue
            missing = []
            if str(row.get("HasAcceptanceCriteria", "Y")).upper() != "Y":
                missing.append("acceptance criteria")
            if str(row.get("HasDoD", "Y")).upper() != "Y":
                missing.append("definition of done")
            if missing:
                unready[ticket_id] = missing
                continue
            candidates.append(ticket_id)

        if not candidates:
            return {
                "status": "NO_ELIGIBLE_WORK",
                "message": "No ready Story/Task items require planned-sprint scheduling.",
                "items": [],
                "unready": unready,
                "capacity": capacity,
                "graph": self._graph_summary(),
            }

        item_rows = self.backlog.set_index("TicketID")
        candidate_set = set(candidates)

        # A ready item is still not schedulable when it depends directly on an
        # unready item. This propagates the Ready gate along the dependency graph.
        blocked_by_unready: dict[str, list[str]] = {}
        for ticket_id in list(candidates):
            blockers = [p for p in self.graph_engine.graph.predecessors(ticket_id) if p in unready]
            if blockers:
                blocked_by_unready[ticket_id] = blockers
                candidates.remove(ticket_id)
        candidate_set = set(candidates)

        if not candidates:
            return {
                "status": "NO_ELIGIBLE_WORK",
                "message": "All otherwise-ready candidates are blocked by unready dependencies.",
                "items": [],
                "unready": unready,
                "blocked_by_unready": blocked_by_unready,
                "capacity": capacity,
                "graph": self._graph_summary(),
            }

        model = cp_model.CpModel()
        x: dict[tuple[str, int], cp_model.IntVar] = {}

        for ticket_id in candidates:
            for idx in range(len(planned_ids)):
                x[(ticket_id, idx)] = model.new_bool_var(f"assign_{ticket_id}_{idx}")
            model.add(sum(x[(ticket_id, idx)] for idx in range(len(planned_ids))) == 1)

        # Story-point capacity per sprint.
        for idx, sprint_id in enumerate(planned_ids):
            terms = []
            for ticket_id in candidates:
                pts = self._points(item_rows.loc[ticket_id, "StoryPoints"])
                terms.append(pts * x[(ticket_id, idx)])
            model.add(sum(terms) <= capacity[sprint_id])

        # Dependency precedence at sprint granularity.
        # Graph edge prerequisite -> dependent.
        for prerequisite, dependent in self.graph_engine.graph.edges():
            if prerequisite not in candidate_set and prerequisite not in fixed:
                continue
            if dependent not in candidate_set:
                continue

            if prerequisite in candidate_set:
                # dependent sprint index >= prerequisite sprint index
                dependent_index = sum(idx * x[(dependent, idx)] for idx in range(len(planned_ids)))
                prerequisite_index = sum(idx * x[(prerequisite, idx)] for idx in range(len(planned_ids)))
                model.add(dependent_index >= prerequisite_index)
            elif prerequisite in fixed:
                # Fixed prerequisite: map it to the nearest planned-sprint index boundary.
                # Completed/active prerequisites are already before planned sprints.
                fixed_sprint = fixed[prerequisite]
                fixed_row = self.sprints[self.sprints["SprintID"] == fixed_sprint]
                if fixed_row.empty:
                    continue
                fixed_end = pd.Timestamp(fixed_row.iloc[0]["EndDate"])
                allowed = []
                for idx, sprint_id in enumerate(planned_ids):
                    start = pd.Timestamp(planned_sprints.iloc[idx]["StartDate"])
                    allowed.append(start >= fixed_end)
                model.add(sum(x[(dependent, idx)] for idx in range(len(planned_ids)) if allowed[idx]) >= 1)

        # Objective: prioritize important work, complete work as early as possible,
        # and avoid moving already-planned work unless necessary.
        objective_terms = []
        for ticket_id in candidates:
            row = item_rows.loc[ticket_id]
            priority = str(row.get("Priority", "Medium"))
            weight = self.PRIORITY_WEIGHT.get(priority, 30)
            previous = row.get("SprintID")
            previous_idx = None
            if pd.notna(previous) and str(previous) in sprint_index:
                previous_idx = sprint_index[str(previous)]

            for idx in range(len(planned_ids)):
                # Earlier sprint => lower cost. High-priority items get stronger pressure.
                completion_cost = (idx + 1) * weight
                change_cost = 0
                if previous_idx is not None:
                    change_cost = abs(idx - previous_idx) * 3
                objective_terms.append((completion_cost + change_cost) * x[(ticket_id, idx)])

        model.minimize(sum(objective_terms))

        solver = cp_model.CpSolver()
        solver.max_time_in_seconds = time_limit_seconds
        solver.num_search_workers = 8
        status = solver.solve(model)

        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            raise PlanningError(
                f"CP-SAT could not find a feasible schedule. status={solver.status_name(status)}"
            )

        level = self.graph_engine.dependency_levels()
        items: list[PlannedItem] = []
        for ticket_id in candidates:
            assigned_idx = next(
                idx for idx in range(len(planned_ids)) if solver.value(x[(ticket_id, idx)]) == 1
            )
            row = item_rows.loc[ticket_id]
            sprint_id = planned_ids[assigned_idx]
            sprint_row = planned_sprints.iloc[assigned_idx]
            dependency_ids = sorted(self.graph_engine.graph.predecessors(ticket_id))
            previous = row.get("SprintID")
            previous_sprint = None if pd.isna(previous) else str(previous)

            items.append(
                PlannedItem(
                    ticket_id=ticket_id,
                    title=str(row["Title"]),
                    story_points=self._points(row["StoryPoints"]),
                    priority=str(row.get("Priority", "Medium")),
                    sprint_id=sprint_id,
                    sprint_name=str(sprint_row["SprintName"]),
                    sprint_index=assigned_idx,
                    dependency_ids=dependency_ids,
                    dependency_level=level.get(ticket_id, 0),
                    previous_sprint_id=previous_sprint,
                    changed_sprint=(previous_sprint is not None and previous_sprint != sprint_id),
                )
            )

        items.sort(key=lambda x: (x.sprint_index, -self.PRIORITY_WEIGHT.get(x.priority, 30), x.ticket_id))

        utilization = {sid: 0 for sid in planned_ids}
        for item in items:
            utilization[item.sprint_id] += item.story_points

        return {
            "status": "OPTIMAL" if status == cp_model.OPTIMAL else "FEASIBLE",
            "objective_value": solver.objective_value,
            "sprints": [
                {
                    "sprint_id": sid,
                    "capacity_points": capacity[sid],
                    "scheduled_points": utilization[sid],
                    "remaining_points": capacity[sid] - utilization[sid],
                }
                for sid in planned_ids
            ],
            "items": [item.__dict__ for item in items],
            "graph": self._graph_summary(),
        }

    def _graph_summary(self) -> dict[str, Any]:
        graph = self.graph_engine.graph
        critical = self.graph_engine.critical_path()
        return {
            "nodes": graph.number_of_nodes(),
            "edges": graph.number_of_edges(),
            "is_dag": nx.is_directed_acyclic_graph(graph),
            "topological_order": (
                self.graph_engine.topological_order()[:50]
                if nx.is_directed_acyclic_graph(graph)
                else []
            ),
            "critical_path": critical,
            "issues": [issue.__dict__ for issue in self.graph_engine.issues],
        }
