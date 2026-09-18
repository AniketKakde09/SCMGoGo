from __future__ import annotations

from pathlib import Path
from typing import Any

import pandas as pd

ESTIMATION_SCALE = {
    "S": 2,
    "M": 5,
    "L": 8,
    "XL": 13,
}


REQUIRED_SHEETS = {
    "Teams",
    "TeamMembers",
    "Backlog",
}


def _normalise_columns(df: pd.DataFrame) -> pd.DataFrame:
    """
    Normalise Excel column names so small formatting differences
    do not break the estimation endpoint.
    """
    result = df.copy()

    result.columns = [str(column).strip() for column in result.columns]

    return result


def _load_workbook(excel_path: str | Path) -> dict[str, pd.DataFrame]:
    """
    Load only the workbook sheets required for ticket estimation.
    """
    sheets = pd.read_excel(
        excel_path,
        sheet_name=None,
    )

    sheets = {name: _normalise_columns(df) for name, df in sheets.items()}

    missing = REQUIRED_SHEETS - set(sheets.keys())

    if missing:
        raise ValueError(
            f"Workbook is missing required sheets: " f"{', '.join(sorted(missing))}"
        )

    return sheets


def _clean_value(value: Any) -> Any:
    """
    Convert pandas NaN/NaT values to JSON-friendly None.
    """
    if pd.isna(value):
        return None

    return value


def _team_list(teams: pd.DataFrame) -> list[dict[str, Any]]:
    """
    Return only fields needed by the frontend team selector.
    """
    result = []

    for _, row in teams.iterrows():
        result.append(
            {
                "id": str(row["TeamID"]),
                "name": str(row["TeamName"]),
            }
        )

    return result


def _team_members(
    members: pd.DataFrame,
    team_id: str,
) -> list[dict[str, Any]]:
    """
    Return members belonging to the selected team.

    Only ID and display name are exposed to the estimation UI.
    """
    team_members = members[members["TeamID"].astype(str) == str(team_id)]

    result = []

    for _, row in team_members.iterrows():
        result.append(
            {
                "id": str(row["MemberID"]),
                "name": str(row["Name"]),
            }
        )

    return result


def _tickets(
    backlog: pd.DataFrame,
    members: pd.DataFrame,
    team_id: str,
) -> list[dict[str, Any]]:
    """
    Resolve backlog tickets belonging to a team.

    Relationship:

        Backlog.AssigneeID
                ↓
        TeamMembers.MemberID
                ↓
        TeamMembers.TeamID
    """

    member_ids = set(
        members.loc[
            members["TeamID"].astype(str) == str(team_id),
            "MemberID",
        ]
        .astype(str)
    )

    result = backlog.copy()

    result["AssigneeID"] = (
        result["AssigneeID"]
        .fillna("")
        .astype(str)
    )

    result = result[
        result["AssigneeID"].isin(member_ids)
    ]

    # Estimation is intended for actionable tickets,
    # not Epics.
    ticket_types = {
        "Story",
        "Task",
        "Bug",
        "Sub-task",
    }

    result = result[
        result["Type"]
        .astype(str)
        .isin(ticket_types)
    ]

    tickets = []

    for _, row in result.iterrows():
        tickets.append(
            {
                "id": str(row["TicketID"]),
                "title": str(
                    _clean_value(row.get("Title"))
                    or ""
                ),
                "priority": _clean_value(
                    row.get("Priority")
                ),
                "type": _clean_value(
                    row.get("Type")
                ),
            }
        )

    return tickets


def build_estimation_workspace(
    excel_path: str | Path,
    team_id: str | None = None,
) -> dict[str, Any]:

    sheets = _load_workbook(excel_path)

    teams = sheets["Teams"]
    members = sheets["TeamMembers"]
    backlog = sheets["Backlog"]

    # ---------------------------------------------------------
    # Team list request
    # ---------------------------------------------------------

    if team_id is None:
        return {
            "teams": _team_list(teams),
            "estimation_scale": ESTIMATION_SCALE,
        }

    # ---------------------------------------------------------
    # Validate selected team
    # ---------------------------------------------------------

    selected_team = teams[teams["TeamID"].astype(str) == str(team_id)]

    if selected_team.empty:
        raise ValueError(f"Team not found: {team_id}")

    team_row = selected_team.iloc[0]

    # ---------------------------------------------------------
    # Team members
    # ---------------------------------------------------------

    team_members = _team_members(
        members,
        team_id,
    )

    member_ids = {member["id"] for member in team_members}

    # ---------------------------------------------------------
    # Resolve tickets belonging to the team
    #
    # Current workbook relationship:
    #
    # Backlog.AssigneeID
    #       ↓
    # TeamMembers.MemberID
    #       ↓
    # TeamMembers.TeamID
    # ---------------------------------------------------------

    backlog_copy = backlog.copy()

    backlog_copy["AssigneeID"] = backlog_copy["AssigneeID"].fillna("").astype(str)

    team_backlog = backlog_copy[backlog_copy["AssigneeID"].isin(member_ids)].copy()

    # Only tickets that make sense for estimation.
    #
    # Epics are excluded because your UI is estimating tickets
    # rather than portfolio-level containers.
    ticket_types = {
        "Story",
        "Task",
        "Bug",
        "Sub-task",
    }

    team_backlog = team_backlog[team_backlog["Type"].astype(str).isin(ticket_types)]

    # ---------------------------------------------------------
    # Build frontend-friendly ticket objects
    # ---------------------------------------------------------

    tickets = _tickets(
        backlog,
        members,
        team_id,
    )

    for _, row in team_backlog.iterrows():

        tickets.append(
            {
                "id": str(row["TicketID"]),
                "title": str(_clean_value(row.get("Title")) or ""),
                "description": None,
                "priority": _clean_value(row.get("Priority")),
                "type": _clean_value(row.get("Type")),
            }
        )

    return {
        "team": {
            "id": str(team_row["TeamID"]),
            "name": str(team_row["TeamName"]),
        },
        "team_members": team_members,
        "tickets": tickets,
        "estimation_scale": ESTIMATION_SCALE,
    }
