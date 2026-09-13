from __future__ import annotations

import pandas as pd

from .models import CapacityResult


class CapacityEngine:
    def __init__(
        self,
        sprints: pd.DataFrame,
        members: pd.DataFrame,
        holidays: pd.DataFrame,
    ) -> None:
        self.sprints = sprints
        self.members = members
        self.holidays = holidays

    def calculate(self) -> list[CapacityResult]:
        results: list[CapacityResult] = []

        for _, sprint in self.sprints.iterrows():
            team_id = sprint["TeamID"]

            team_members = self.members[
                self.members["TeamID"] == team_id
            ]

            total_allocation = (
                team_members["AllocationPct"]
                .fillna(0)
                .clip(upper=100)
                .sum()
            )

            holiday_count = len(
                self.holidays[
                    (self.holidays["ImpactedTeamID"] == team_id)
                    & (self.holidays["Date"] >= sprint["StartDate"])
                    & (self.holidays["Date"] <= sprint["EndDate"])
                ]
            )

            nominal_capacity = float(
                sprint["PlannedCapacityPts"]
            )

            working_days = max(
                int(sprint["WorkingDays"]),
                1,
            )

            holiday_factor = max(
                0,
                (working_days - holiday_count) / working_days,
            )

            allocation_ratio = min(
                total_allocation /
                max(len(team_members) * 100, 1),
                1.0,
            )

            effective_capacity = (
                nominal_capacity
                * holiday_factor
                * allocation_ratio
            )

            committed = float(
                sprint["CommittedPts"]
            )

            results.append(
                CapacityResult(
                    sprint_id=sprint["SprintID"],
                    team_id=team_id,
                    nominal_capacity=round(
                        nominal_capacity,
                        2,
                    ),
                    holiday_count=holiday_count,
                    effective_capacity=round(
                        effective_capacity,
                        2,
                    ),
                    committed_points=round(
                        committed,
                        2,
                    ),
                    remaining_capacity=round(
                        effective_capacity - committed,
                        2,
                    ),
                    over_committed=(
                        committed > effective_capacity
                    ),
                )
            )

        return results