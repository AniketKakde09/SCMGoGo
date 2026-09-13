from __future__ import annotations

from dataclasses import dataclass
from math import ceil
from statistics import median, pstdev
from typing import Any

import pandas as pd


@dataclass(frozen=True)
class ForecastResult:
    remaining_points: int
    historical_sprints: int
    median_velocity: float
    p80_velocity: float
    projected_sprints: int | None
    projected_completion_sprint: str | None
    confidence: float
    method: str
    assumptions: list[str]


class ForecastEngine:
    """Simple explainable Monte-Carlo-free forecast from historical throughput.

    The first version intentionally uses sprint throughput rather than an LLM.
    This keeps forecasting deterministic and auditable. A probabilistic model can
    be added later without changing the API contract.
    """

    def __init__(
        self,
        backlog: pd.DataFrame,
        sprints: pd.DataFrame,
    ) -> None:
        self.backlog = backlog.copy()
        self.sprints = sprints.copy()

    @staticmethod
    def _points(value: Any) -> int:
        try:
            return max(int(round(float(value))), 0)
        except (TypeError, ValueError):
            return 0

    def forecast(self) -> dict[str, Any]:
        completed = self.sprints[
            self.sprints["Status"].astype(str).str.lower().eq("completed")
        ].copy()
        completed = completed.sort_values("StartDate")

        delivered_by_sprint: list[int] = []
        if not completed.empty:
            grouped = (
                self.backlog[
                    self.backlog["SprintID"].notna()
                    & self.backlog["Status"].astype(str).str.lower().isin(
                        {"done", "closed"}
                    )
                ]
                .groupby("SprintID")["StoryPoints"]
                .sum()
                .to_dict()
            )
            for sprint_id in completed["SprintID"].astype(str):
                delivered_by_sprint.append(self._points(grouped.get(sprint_id, 0)))

        non_zero = [x for x in delivered_by_sprint if x > 0]
        remaining = self.backlog[
            self.backlog["Type"].astype(str).isin({"Story", "Task"})
            & ~self.backlog["Status"].astype(str).str.lower().isin(
                {"done", "closed", "cancelled", "canceled"}
            )
        ]["StoryPoints"].map(self._points).sum()
        remaining = int(remaining)

        assumptions = [
            "Forecast uses completed Story/Task points as observed throughput.",
            "Future throughput is assumed to be similar to historical throughput.",
            "Current readiness and dependency blockers can extend the date beyond this baseline.",
        ]

        if not non_zero:
            # Fall back to planned capacity if the synthetic/real dataset has no delivered points.
            capacities = [self._points(x) for x in completed.get("PlannedCapacityPts", [])]
            typical = median([x for x in capacities if x > 0]) if any(x > 0 for x in capacities) else 0
            velocity = float(typical)
            confidence = 0.25 if velocity else 0.0
        else:
            velocity = float(median(non_zero))
            # Conservative p80-throughput: 80th percentile by nearest-rank.
            ordered = sorted(non_zero)
            p80 = ordered[max(0, min(len(ordered) - 1, ceil(0.8 * len(ordered)) - 1))]
            p80_velocity = float(p80)
            variability = pstdev(non_zero) if len(non_zero) > 1 else 0.0
            confidence = max(0.35, min(0.9, 0.85 - (variability / max(velocity * 4, 1))))

        if non_zero:
            ordered = sorted(non_zero)
            p80_velocity = float(ordered[max(0, min(len(ordered) - 1, ceil(0.8 * len(ordered)) - 1))])
        else:
            p80_velocity = velocity

        projected_sprints = None if velocity <= 0 else max(1, ceil(remaining / velocity))
        planned = self.sprints[
            self.sprints["Status"].astype(str).str.lower().isin({"planned", "active"})
        ].sort_values("StartDate").reset_index(drop=True)
        completion_sprint = None
        if projected_sprints is not None and not planned.empty:
            index = min(projected_sprints - 1, len(planned) - 1)
            completion_sprint = str(planned.iloc[index]["SprintID"])
            if projected_sprints > len(planned):
                completion_sprint = f"{completion_sprint}+{projected_sprints - len(planned)} sprints"
                assumptions.append("More planned sprints are required than currently exist in the dataset.")

        return ForecastResult(
            remaining_points=remaining,
            historical_sprints=len(non_zero),
            median_velocity=round(velocity, 2),
            p80_velocity=round(p80_velocity, 2),
            projected_sprints=projected_sprints,
            projected_completion_sprint=completion_sprint,
            confidence=round(confidence, 2),
            method="historical throughput median",
            assumptions=assumptions,
        ).__dict__
