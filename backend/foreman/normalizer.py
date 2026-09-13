from __future__ import annotations

import pandas as pd


def clean_value(value):
    if pd.isna(value):
        return None
    return value


def normalize_backlog(df: pd.DataFrame) -> pd.DataFrame:
    result = df.copy()

    result.columns = [
        str(column).strip()
        for column in result.columns
    ]

    for column in ["ParentID", "SADSectionID", "SprintID", "AssigneeID"]:
        if column in result.columns:
            result[column] = result[column].apply(clean_value)

    if "StoryPoints" in result.columns:
        result["StoryPoints"] = (
            pd.to_numeric(
                result["StoryPoints"],
                errors="coerce",
            )
            .fillna(0)
        )

    return result


def normalize_sprints(df: pd.DataFrame) -> pd.DataFrame:
    result = df.copy()

    result["StartDate"] = pd.to_datetime(
        result["StartDate"],
        errors="coerce",
    ).dt.date

    result["EndDate"] = pd.to_datetime(
        result["EndDate"],
        errors="coerce",
    ).dt.date

    return result


def normalize_holidays(df: pd.DataFrame) -> pd.DataFrame:
    result = df.copy()

    result["Date"] = pd.to_datetime(
        result["Date"],
        errors="coerce",
    ).dt.date

    return result