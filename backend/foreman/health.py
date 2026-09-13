from __future__ import annotations

import networkx as nx
import pandas as pd

from .models import HealthIssue, HealthReport
from .graph import DependencyGraph


class HealthChecker:
    def __init__(
        self,
        backlog: pd.DataFrame,
        dependencies: pd.DataFrame,
        sprints: pd.DataFrame,
        members: pd.DataFrame,
        holidays: pd.DataFrame,
        sad_sections: pd.DataFrame,
    ) -> None:
        self.backlog = backlog.copy()
        self.dependencies = dependencies.copy()
        self.sprints = sprints.copy()
        self.members = members.copy()
        self.holidays = holidays.copy()
        self.sad_sections = sad_sections.copy()

        self.ticket_ids = set(
            self.backlog["TicketID"].dropna()
        )

    def run(self) -> HealthReport:
        issues: list[HealthIssue] = []

        issues.extend(self.check_hierarchy())
        issues.extend(self.check_traceability())
        issues.extend(self.check_readiness())
        issues.extend(self.check_estimation())
        issues.extend(self.check_dependencies())
        issues.extend(self.check_sprints())
        issues.extend(self.check_allocations())
        issues.extend(self.check_holidays())

        return HealthReport(
            total_issues=len(issues),
            issues=issues,
        )

    def check_hierarchy(self) -> list[HealthIssue]:
        issues = []

        valid_parent_types = {
            "Feature": {"Epic"},
            "Story": {"Feature"},
            "Task": {"Feature"},
        }

        for _, row in self.backlog.iterrows():
            ticket_type = row.get("Type")
            parent_id = row.get("ParentID")

            if ticket_type not in valid_parent_types:
                continue

            if pd.isna(parent_id) or parent_id is None:
                issues.append(
                    HealthIssue(
                        category="Hierarchy",
                        severity="HIGH",
                        message=(
                            f"{row['TicketID']} has no parent."
                        ),
                        ticket_id=row["TicketID"],
                    )
                )
                continue

            parent = self.backlog[
                self.backlog["TicketID"] == parent_id
            ]

            if parent.empty:
                issues.append(
                    HealthIssue(
                        category="Hierarchy",
                        severity="HIGH",
                        message=(
                            f"{row['TicketID']} references "
                            f"missing parent {parent_id}."
                        ),
                        ticket_id=row["TicketID"],
                    )
                )

        return issues

    def check_traceability(self) -> list[HealthIssue]:
        issues = []

        valid_sad_ids = set(
            self.sad_sections["SectionID"].dropna()
        )

        epics = self.backlog[
            self.backlog["Type"].astype(str).str.lower() == "epic"
        ]

        for _, row in epics.iterrows():
            sad_id = row.get("SADSectionID")

            if pd.isna(sad_id) or sad_id not in valid_sad_ids:
                issues.append(
                    HealthIssue(
                        category="Traceability",
                        severity="HIGH",
                        message=(
                            f"Epic {row['TicketID']} is not "
                            f"anchored to a valid S-AD section."
                        ),
                        ticket_id=row["TicketID"],
                    )
                )

        return issues

    def check_readiness(self) -> list[HealthIssue]:
        issues = []

        for _, row in self.backlog.iterrows():
            if row.get("Type") not in {"Story", "Task"}:
                continue

            has_ac = str(row.get("HasAcceptanceCriteria", "Y")).upper() == "Y"
            has_dod = str(row.get("HasDoD", "Y")).upper() == "Y"

            if not has_ac or not has_dod:
                missing = []

                if not has_ac:
                    missing.append("acceptance criteria")

                if not has_dod:
                    missing.append("Definition of Done")

                issues.append(
                    HealthIssue(
                        category="Readiness",
                        severity="HIGH",
                        message=(
                            f"{row['TicketID']} is not Ready: "
                            f"missing {', '.join(missing)}."
                        ),
                        ticket_id=row["TicketID"],
                    )
                )

        return issues

    def check_estimation(self) -> list[HealthIssue]:
        issues = []

        for _, row in self.backlog.iterrows():
            if row.get("Type") not in {"Story", "Task"}:
                continue

            points = row.get("StoryPoints", 0)

            if pd.isna(points) or float(points) <= 0:
                issues.append(
                    HealthIssue(
                        category="Estimation",
                        severity="MEDIUM",
                        message=(
                            f"{row['TicketID']} has no valid "
                            "story-point estimate."
                        ),
                        ticket_id=row["TicketID"],
                    )
                )

        return issues

    def check_dependencies(self) -> list[HealthIssue]:
        issues: list[HealthIssue] = []
        engine = DependencyGraph(self.backlog, self.dependencies)

        for item in engine.issues:
            issues.append(
                HealthIssue(
                    category="Dependency",
                    severity="HIGH",
                    message=item.message,
                    ticket_id=item.ticket_id,
                )
            )

        for cycle in engine.cycles():
            issues.append(
                HealthIssue(
                    category="Dependency",
                    severity="CRITICAL",
                    message="Circular dependency detected: " + " -> ".join(cycle),
                    details={"cycle": cycle},
                )
            )

        # Sprint order check uses the normalized graph semantics: prerequisite -> dependent.
        if "SprintID" in self.backlog.columns:
            sprint_lookup = (
                self.backlog[["TicketID", "SprintID"]]
                .dropna(subset=["SprintID"])
                .set_index("TicketID")["SprintID"]
                .to_dict()
            )
        else:
            sprint_lookup = {}
        sprint_order = {
            str(sprint_id): index
            for index, sprint_id in enumerate(self.sprints["SprintID"].tolist())
        }

        for prerequisite, dependent in engine.graph.edges():
            prerequisite_sprint = sprint_lookup.get(prerequisite)
            dependent_sprint = sprint_lookup.get(dependent)
            if (
                prerequisite_sprint in sprint_order
                and dependent_sprint in sprint_order
                and sprint_order[dependent_sprint] < sprint_order[prerequisite_sprint]
            ):
                issues.append(
                    HealthIssue(
                        category="Dependency",
                        severity="HIGH",
                        message=(
                            f"{dependent} depends on {prerequisite}, "
                            "but the dependent is scheduled earlier."
                        ),
                        ticket_id=dependent,
                        details={
                            "prerequisite": prerequisite,
                            "prerequisite_sprint": prerequisite_sprint,
                            "dependent_sprint": dependent_sprint,
                        },
                    )
                )

        return issues

    def check_sprints(self) -> list[HealthIssue]:
        issues = []

        for _, row in self.sprints.iterrows():
            capacity = float(row.get("PlannedCapacityPts", 0))
            committed = float(row.get("CommittedPts", 0))

            if committed > capacity:
                issues.append(
                    HealthIssue(
                        category="Capacity",
                        severity="HIGH",
                        message=(
                            f"{row['SprintID']} is over-committed: "
                            f"{committed:g} pts vs {capacity:g} pts."
                        ),
                        sprint_id=row["SprintID"],
                    )
                )

        return issues

    def check_allocations(self) -> list[HealthIssue]:
        issues = []

        for _, row in self.members.iterrows():
            allocation = float(row.get("AllocationPct", 0))

            if allocation > 100:
                issues.append(
                    HealthIssue(
                        category="Capacity",
                        severity="HIGH",
                        message=(
                            f"{row['Name']} is allocated at "
                            f"{allocation:g}%."
                        ),
                    )
                )

        return issues

    def check_holidays(self) -> list[HealthIssue]:
        issues = []

        for _, sprint in self.sprints.iterrows():
            if pd.isna(sprint["StartDate"]) or pd.isna(sprint["EndDate"]):
                continue

            matching = self.holidays[
                (self.holidays["ImpactedTeamID"] == sprint["TeamID"])
                & (self.holidays["Date"] >= sprint["StartDate"])
                & (self.holidays["Date"] <= sprint["EndDate"])
            ]

            if not matching.empty:
                issues.append(
                    HealthIssue(
                        category="Capacity",
                        severity="MEDIUM",
                        message=(
                            f"{sprint['SprintID']} contains "
                            f"{len(matching)} team holiday(s); "
                            "nominal capacity may be overstated."
                        ),
                        sprint_id=sprint["SprintID"],
                        details={
                            "holidays": matching[
                                [
                                    "HolidayID",
                                    "Date",
                                    "HolidayName",
                                ]
                            ].to_dict(orient="records")
                        },
                    )
                )

        return issues