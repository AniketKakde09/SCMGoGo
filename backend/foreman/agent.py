from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pandas as pd

from .forecast import ForecastEngine
from .graph import DependencyGraph
from .health import HealthChecker
from .normalizer import normalize_backlog, normalize_holidays, normalize_sprints
from .repository import Repository


@dataclass(frozen=True)
class AgentDecision:
    decision_id: str
    category: str
    question: str
    recommendation: str
    options: list[str]
    evidence: list[str]
    impact: str
    requires_human_approval: bool = True


class ScrumMasterAgent:
    """Deterministic Scrum Master core.

    The agent does not mutate Jira/OpenProject or the backlog. It produces:
    - health/readiness evidence
    - dependency graph facts
    - CP-SAT plan when the inputs are schedulable
    - throughput forecast
    - hard questions / human decisions

    An LLM can later be placed in front of this service to turn raw demand into
    structured backlog items, but the hard constraints remain deterministic.
    """

    def __init__(self, repository: Repository) -> None:
        self.repository = repository

    def _inputs(self) -> dict[str, pd.DataFrame]:
        return {
            "backlog": normalize_backlog(self.repository.get_sheet("Backlog")),
            "dependencies": self.repository.get_sheet("Dependencies").copy(),
            "sprints": normalize_sprints(self.repository.get_sheet("Sprints")),
            "members": self.repository.get_sheet("TeamMembers").copy(),
            "holidays": normalize_holidays(self.repository.get_sheet("Holidays")),
            "sad": self.repository.get_sheet("SAD_Sections").copy(),
        }

    @staticmethod
    def _health_summary(issues: list[Any]) -> dict[str, int]:
        out: dict[str, int] = {}
        for issue in issues:
            out[issue.category] = out.get(issue.category, 0) + 1
        return out

    def _decisions(
        self,
        health: Any,
        graph: DependencyGraph,
        forecast: dict[str, Any],
        plan: dict[str, Any],
    ) -> list[AgentDecision]:
        decisions: list[AgentDecision] = []
        issues = health.issues
        critical = [x for x in issues if x.severity == "CRITICAL"]
        readiness = [x for x in issues if x.category == "Readiness"]
        capacity = [x for x in issues if x.category == "Capacity"]

        if critical:
            decisions.append(
                AgentDecision(
                    decision_id="DEC-DEPENDENCY-001",
                    category="Dependencies",
                    question="Which dependency owner will resolve the blocking graph defects before planning is approved?",
                    recommendation="Do not approve the sprint sequence while a cycle or missing dependency exists.",
                    options=["Assign dependency owner", "Remove/replace invalid dependency", "Defer affected work"],
                    evidence=[x.message for x in critical[:5]],
                    impact="The optimizer cannot guarantee a valid execution order until the dependency graph is valid.",
                )
            )

        if readiness:
            decisions.append(
                AgentDecision(
                    decision_id="DEC-READY-001",
                    category="Readiness",
                    question="Which unready items should be refined before they are allowed into a sprint?",
                    recommendation="Keep items without acceptance criteria or DoD outside the committed plan.",
                    options=["Refine now", "Split the item", "Defer to backlog"],
                    evidence=[x.message for x in readiness[:8]],
                    impact=f"{len(readiness)} work items currently fail the Ready gate.",
                )
            )

        if capacity:
            decisions.append(
                AgentDecision(
                    decision_id="DEC-CAPACITY-001",
                    category="Capacity",
                    question="What will we deliberately drop when demand exceeds the team's effective capacity?",
                    recommendation="Honor effective capacity and protect the highest-value/critical dependency chain.",
                    options=["Drop lowest priority", "Move lower priority work", "Increase capacity with explicit approval"],
                    evidence=[x.message for x in capacity[:8]],
                    impact="Keeping the current commitment risks spillover and reduces forecast confidence.",
                )
            )

        if graph.critical_path():
            path = " → ".join(graph.critical_path()[:8])
            decisions.append(
                AgentDecision(
                    decision_id="DEC-CRITICAL-PATH-001",
                    category="Delivery risk",
                    question="Are the owners and environments for the critical dependency chain committed before downstream work starts?",
                    recommendation="Protect the critical path from resource contention and external delays.",
                    options=["Protect critical path", "Re-sequence dependent work", "Accept delivery risk"],
                    evidence=[f"Critical path: {path}"],
                    impact="A delay on the critical path can move the earliest feasible completion date for multiple downstream items.",
                )
            )

        if forecast.get("confidence", 0) < 0.6:
            decisions.append(
                AgentDecision(
                    decision_id="DEC-FORECAST-001",
                    category="Forecast",
                    question="Do we accept a low-confidence delivery forecast, or do we reduce scope and uncertainty first?",
                    recommendation="Treat the forecast as directional until more completed-sprint throughput is available.",
                    options=["Accept forecast risk", "Reduce scope", "Collect more evidence"],
                    evidence=[
                        f"Confidence: {forecast.get('confidence', 0):.0%}",
                        f"Historical throughput samples: {forecast.get('historical_sprints', 0)}",
                    ],
                    impact="Low confidence means a date should not be presented as a commitment.",
                )
            )

        if plan.get("status") == "BLOCKED":
            decisions.append(
                AgentDecision(
                    decision_id="DEC-PLAN-001",
                    category="Planning",
                    question="Do we fix the blocking inputs now, or explicitly accept that no executable sprint plan exists?",
                    recommendation="Fix hard blockers before committing to a sprint sequence.",
                    options=["Fix blockers", "Create an exception decision", "Stop planning"],
                    evidence=plan.get("blockers", [])[:8],
                    impact="The current plan is advisory only until hard constraints are satisfiable.",
                )
            )

        return decisions

    def run(self, time_limit_seconds: float = 10.0) -> dict[str, Any]:
        data = self._inputs()
        health = HealthChecker(
            backlog=data["backlog"],
            dependencies=data["dependencies"],
            sprints=data["sprints"],
            members=data["members"],
            holidays=data["holidays"],
            sad_sections=data["sad"],
        ).run()

        graph = DependencyGraph(data["backlog"], data["dependencies"])
        forecast = ForecastEngine(data["backlog"], data["sprints"]).forecast()

        plan: dict[str, Any]
        try:
            from .planner import PlanningError, SprintPlanner
            plan = SprintPlanner(
                backlog=data["backlog"],
                dependencies=data["dependencies"],
                sprints=data["sprints"],
                members=data["members"],
                holidays=data["holidays"],
            ).solve(time_limit_seconds=time_limit_seconds)
        except RuntimeError as exc:
            plan = {
                "status": "BLOCKED",
                "blockers": [str(exc)],
                "items": [],
            }
        except ModuleNotFoundError as exc:
            plan = {
                "status": "BLOCKED",
                "blockers": [
                    "OR-Tools is not installed. Run: pip install -r requirements.txt",
                    str(exc),
                ],
                "items": [],
            }

        decisions = self._decisions(health, graph, forecast, plan)

        # Hard-stop semantics: critical integrity blockers prevent a plan from being
        # presented as an executable commitment even if the optimizer could otherwise run.
        executable = not any(x.severity == "CRITICAL" for x in health.issues)
        if not executable:
            plan["commitment_status"] = "NOT_EXECUTABLE"

        return {
            "agent": "Foreman Scrum Master",
            "mode": "decision-support",
            "health": {
                "total_issues": health.total_issues,
                "by_category": self._health_summary(health.issues),
                "issues": [x.model_dump() for x in health.issues],
            },
            "dependencies": {
                "is_dag": not graph.has_cycle(),
                "missing_or_invalid": [x.__dict__ for x in graph.issues],
                "cycles": graph.cycles(),
                "topological_order": graph.topological_order() if not graph.has_cycle() else [],
                "dependency_levels": graph.dependency_levels(),
                "critical_path": graph.critical_path(),
            },
            "readiness": {
                "ready_items": sum(
                    1
                    for _, row in data["backlog"].iterrows()
                    if str(row.get("Type")) in {"Story", "Task"}
                    and str(row.get("HasAcceptanceCriteria", "Y")).upper() == "Y"
                    and str(row.get("HasDoD", "Y")).upper() == "Y"
                ),
                "blocked_items": len([x for x in health.issues if x.category == "Readiness"]),
                "policy": "Unready Story/Task items are not eligible for commitment.",
            },
            "forecast": forecast,
            "plan": plan,
            "human_decisions": [x.__dict__ for x in decisions],
            "next_best_actions": [
                x.recommendation for x in decisions[:5]
            ],
        }
