"""Bridges the LLM backlog pipeline (agents/backlog_agent.py) to whatever
dataset is currently loaded in Foreman, so new epics can be checked against
real existing epics/SAD sections instead of always being invented fresh.

If no dataset is loaded, both lists come back empty and backlog_agent falls
back to its old always-create-new behavior — this is additive, not a hard
dependency on Foreman being loaded.
"""

from __future__ import annotations

from typing import Any

from foreman.main import repository as foreman_repository


def get_existing_epics() -> list[dict[str, Any]]:
    if not foreman_repository.has_data():
        return []

    try:
        backlog = foreman_repository.get_sheet("Backlog")
    except KeyError:
        return []

    epics = backlog[backlog["Type"].astype(str).str.lower() == "epic"]

    return [
        {
            "id": str(row.get("TicketID")),
            "title": str(row.get("Title", "")),
            # The sample dataset has no long-form epic description column;
            # Labels is the closest free-text signal available.
            "description": str(row.get("Labels", "") or ""),
        }
        for _, row in epics.iterrows()
    ]


def get_existing_sad_sections() -> list[dict[str, Any]]:
    if not foreman_repository.has_data():
        return []

    try:
        sections = foreman_repository.get_sheet("SAD_Sections")
    except KeyError:
        return []

    return [
        {
            "id": str(row.get("SectionID")),
            "title": str(row.get("SectionTitle", "")),
            "summary": str(row.get("Summary", "") or ""),
            "layer": str(row.get("ArchitectureLayer", "") or ""),
        }
        for _, row in sections.iterrows()
    ]
