from __future__ import annotations

from pathlib import Path
from typing import Any

import pandas as pd


def clean(value: Any) -> str:
    if pd.isna(value):
        return ""
    return str(value).strip()


def build_canvas_graph(excel_path: Path | str) -> dict[str, list[dict[str, Any]]]:
    """Build the architecture/work-item graph used by the React Flow canvas.

    Hierarchy:
        SAD Section -> Epic -> Issue (Feature/Story/Task)

    Dependency edges are kept separate so the UI can render them differently
    from the structural hierarchy.
    """
    excel_path = Path(excel_path)
    sad_df = pd.read_excel(excel_path, sheet_name="SAD_Sections").fillna("")
    backlog_df = pd.read_excel(excel_path, sheet_name="Backlog").fillna("")
    dep_df = pd.read_excel(excel_path, sheet_name="Dependencies").fillna("")

    sad_sections: list[dict[str, Any]] = []
    for _, row in sad_df.iterrows():
        section_id = clean(row.get("SectionID"))
        if not section_id:
            continue
        sad_sections.append({
            "id": section_id,
            "title": clean(row.get("SADTitle")),
            "section_number": clean(row.get("SectionNumber")),
            "section_title": clean(row.get("SectionTitle")),
            "architecture_layer": clean(row.get("ArchitectureLayer")),
            "summary": clean(row.get("Summary")),
        })

    items: dict[str, dict[str, Any]] = {}
    for _, row in backlog_df.iterrows():
        ticket_id = clean(row.get("TicketID"))
        if not ticket_id:
            continue
        items[ticket_id] = {
            "id": ticket_id,
            "type": clean(row.get("Type")),
            "title": clean(row.get("Title")),
            "parent_id": clean(row.get("ParentID")),
            "sad_section_id": clean(row.get("SADSectionID")),
            "layer": clean(row.get("Layer")),
            "story_points": row.get("StoryPoints") if pd.notna(row.get("StoryPoints")) else None,
            "priority": clean(row.get("Priority")),
            "status": clean(row.get("Status")),
            "sprint_id": clean(row.get("SprintID")),
            "assignee_id": clean(row.get("AssigneeID")),
            "labels": clean(row.get("Labels")),
        }

    epics = [item for item in items.values() if item["type"].lower() == "epic"]
    issues = [item for item in items.values() if item["type"].lower() != "epic"]

    # ParentID is the authoritative hierarchy for backlog items. The SAD
    # section is retained on each item as a fallback for datasets where a
    # parent record is absent or inconsistent.
    hierarchy_edges: list[dict[str, Any]] = []
    epic_ids = {e["id"] for e in epics}
    sad_ids = {s["id"] for s in sad_sections}

    for epic in epics:
        sad_id = epic["sad_section_id"]
        if sad_id in sad_ids:
            hierarchy_edges.append({
                "id": f"hierarchy-{sad_id}-{epic['id']}",
                "source": sad_id,
                "target": epic["id"],
                "kind": "hierarchy",
                "relation": "contains",
            })

    for issue in issues:
        parent_id = issue["parent_id"]
        if parent_id in epic_ids:
            hierarchy_edges.append({
                "id": f"hierarchy-{parent_id}-{issue['id']}",
                "source": parent_id,
                "target": issue["id"],
                "kind": "hierarchy",
                "relation": "contains",
            })
        elif issue["sad_section_id"] in sad_ids:
            # Keep orphaned issues visible in the correct architecture area.
            hierarchy_edges.append({
                "id": f"hierarchy-{issue['sad_section_id']}-{issue['id']}",
                "source": issue["sad_section_id"],
                "target": issue["id"],
                "kind": "hierarchy",
                "relation": "contains",
            })

    dependencies: list[dict[str, Any]] = []
    for _, row in dep_df.iterrows():
        source = clean(row.get("FromTicketID"))
        target = clean(row.get("ToTicketID (depends on)"))
        if not source or not target:
            continue
        dependencies.append({
            "id": clean(row.get("DependencyID")) or f"dependency-{source}-{target}",
            "source": source,
            "target": target,
            "kind": "dependency",
            "dependency_type": clean(row.get("DependencyType")),
            "notes": clean(row.get("Notes")),
        })

    return {
        "sad_sections": sad_sections,
        "epics": epics,
        "issues": issues,
        "hierarchy_edges": hierarchy_edges,
        "dependencies": dependencies,
    }
