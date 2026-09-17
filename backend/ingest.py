from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Any

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

import chromadb
import pandas as pd

from graph import GRAPH_PATH, build_dependency_graph, save_graph, graph_diagnostics
from search import get_embedding_model
from security import sanitize_dataframe


BASE_DIR = Path(__file__).resolve().parent
EXCEL_PATH = Path(os.getenv("FOREMAN_EXCEL_PATH", str(BASE_DIR / "data" / "Foreman_Synthetic_Dataset.xlsx")))
CHROMA_PATH = Path(os.getenv("FOREMAN_CHROMA_PATH", str(BASE_DIR / "vectorstore" / "chroma")))
GRAPH_PATH = Path(os.getenv("FOREMAN_GRAPH_PATH", str(BASE_DIR / "vectorstore" / "dependency_graph.graphml")))
COLLECTION_NAME = os.getenv("CHROMA_COLLECTION", "foreman_knowledge")

# Good small local embedding model. Change this if you need another model.
EMBEDDING_MODEL = os.getenv(
    "EMBEDDING_MODEL",
    "sentence-transformers/all-MiniLM-L6-v2",
)

# Keep the AnswerKey out of the searchable knowledge base by default.
INCLUDE_ANSWER_KEY = os.getenv("INCLUDE_ANSWER_KEY", "false").lower() == "true"




def sanitize_workbook(source_path: Path | str, destination_path: Path | str) -> dict[str, Any]:
    """Create a sanitized workbook without changing the original upload."""
    source_path = Path(source_path)
    destination_path = Path(destination_path)
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    import pandas as pd
    sheets = pd.read_excel(source_path, sheet_name=None)
    sanitized = {name: sanitize_dataframe(df) for name, df in sheets.items()}
    with pd.ExcelWriter(destination_path, engine="openpyxl") as writer:
        for name, df in sanitized.items():
            df.to_excel(writer, sheet_name=str(name)[:31], index=False)
    return {"source": str(source_path), "destination": str(destination_path), "sheets": list(sanitized)}


def clean(value: Any) -> str:
    """Convert Excel values to clean strings."""
    if pd.isna(value):
        return ""
    return str(value).strip()


def load_workbook() -> dict[str, pd.DataFrame]:
    """Load all workbook sheets as dataframes."""
    return pd.read_excel(EXCEL_PATH, sheet_name=None)


def normalize_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    """Chroma metadata values must be scalar primitives."""
    output = {}
    for key, value in metadata.items():
        if value is None or (isinstance(value, float) and pd.isna(value)):
            continue
        if isinstance(value, (str, int, float, bool)):
            output[key] = value
        else:
            output[key] = str(value)
    return output


def make_id(prefix: str, text: str) -> str:
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]
    return f"{prefix}-{digest}"


def index_by(rows: list[dict[str, Any]], key: str) -> dict[str, dict[str, Any]]:
    return {
        clean(row.get(key)): row
        for row in rows
        if clean(row.get(key))
    }


def build_documents(sheets: dict[str, pd.DataFrame]):
    """
    Turn relational Excel rows into LLM-friendly documents.

    The important design choice is that rows are enriched with related
    records. For example, a backlog ticket includes its team, assignee,
    sprint, and architecture section.
    """
    rows = {
        name: [
            {str(k): clean(v) for k, v in row.items()}
            for row in df.to_dict(orient="records")
        ]
        for name, df in sheets.items()
    }

    teams = index_by(rows.get("Teams", []), "TeamID")
    members = index_by(rows.get("TeamMembers", []), "MemberID")
    sprints = index_by(rows.get("Sprints", []), "SprintID")
    sad = index_by(rows.get("SAD_Sections", []), "SectionID")
    backlog = index_by(rows.get("Backlog", []), "TicketID")

    documents = []

    def add_doc(doc_id, text, metadata):
        text = text.strip()
        if not text:
            return
        documents.append(
            {
                "id": doc_id,
                "text": text,
                "metadata": normalize_metadata(metadata),
            }
        )

    # Teams
    for row in rows.get("Teams", []):
        add_doc(
            f"team-{row.get('TeamID')}",
            f"""Team record:
Team ID: {row.get('TeamID')}
Team name: {row.get('TeamName')}
Product/service: {row.get('Product / Service')}
Sprint length: {row.get('SprintLengthDays')} days
Base velocity: {row.get('BaseVelocityPts')} story points
Team size: {row.get('TeamSize')}
Timezone: {row.get('Timezone')}
Delivery manager: {row.get('DeliveryManager')}""",
            {"source": "Teams", "record_type": "team", "team_id": row.get("TeamID")},
        )

    # Team members
    for row in rows.get("TeamMembers", []):
        team = teams.get(row.get("TeamID"), {})
        add_doc(
            f"member-{row.get('MemberID')}",
            f"""Team member:
Member ID: {row.get('MemberID')}
Name: {row.get('Name')}
Team: {team.get('TeamName', row.get('TeamID'))}
Team ID: {row.get('TeamID')}
Role: {row.get('Role')}
Seniority: {row.get('Seniority')}
Allocation: {row.get('AllocationPct')}%
Capacity per sprint: {row.get('CapacityHrsPerSprint')} hours
Location: {row.get('Location')}
Start date: {row.get('StartDate')}""",
            {
                "source": "TeamMembers",
                "record_type": "team_member",
                "member_id": row.get("MemberID"),
                "team_id": row.get("TeamID"),
                "role": row.get("Role"),
                "allocation_pct": row.get("AllocationPct"),
            },
        )

    # Sprints
    for row in rows.get("Sprints", []):
        team = teams.get(row.get("TeamID"), {})
        add_doc(
            f"sprint-{row.get('SprintID')}",
            f"""Sprint:
Sprint ID: {row.get('SprintID')}
Sprint name: {row.get('SprintName')}
Team: {team.get('TeamName', row.get('TeamID'))}
Team ID: {row.get('TeamID')}
Dates: {row.get('StartDate')} to {row.get('EndDate')}
Working days: {row.get('WorkingDays')}
Planned capacity: {row.get('PlannedCapacityPts')} story points
Committed: {row.get('CommittedPts')} story points
Status: {row.get('Status')}""",
            {
                "source": "Sprints",
                "record_type": "sprint",
                "sprint_id": row.get("SprintID"),
                "team_id": row.get("TeamID"),
                "status": row.get("Status"),
            },
        )

    # Holidays
    for row in rows.get("Holidays", []):
        add_doc(
            f"holiday-{row.get('HolidayID')}",
            f"""Holiday:
Holiday ID: {row.get('HolidayID')}
Location: {row.get('Location')}
Date: {row.get('Date')}
Holiday name: {row.get('HolidayName')}
Impacted team: {row.get('ImpactedTeamID')}""",
            {
                "source": "Holidays",
                "record_type": "holiday",
                "holiday_id": row.get("HolidayID"),
                "team_id": row.get("ImpactedTeamID"),
            },
        )

    # Architecture sections
    for row in rows.get("SAD_Sections", []):
        add_doc(
            f"sad-{row.get('SectionID')}",
            f"""Architecture / SAD section:
Section ID: {row.get('SectionID')}
Document: {row.get('SADTitle')}
Section number: {row.get('SectionNumber')}
Section title: {row.get('SectionTitle')}
Architecture layer: {row.get('ArchitectureLayer')}
Summary: {row.get('Summary')}""",
            {
                "source": "SAD_Sections",
                "record_type": "architecture",
                "sad_section_id": row.get("SectionID"),
                "sad_title": row.get("SADTitle"),
                "section_number": row.get("SectionNumber"),
                "section_title": row.get("SectionTitle"),
                "architecture_layer": row.get("ArchitectureLayer"),
            },
        )

    # Backlog: enrich with linked entities.
    for row in rows.get("Backlog", []):
        team_id = ""
        sprint = sprints.get(row.get("SprintID"), {})
        assignee = members.get(row.get("AssigneeID"), {})
        sad_section = sad.get(row.get("SADSectionID"), {})

        if sprint:
            team_id = sprint.get("TeamID", "")
        elif assignee:
            team_id = assignee.get("TeamID", "")

        team = teams.get(team_id, {})

        add_doc(
            f"ticket-{row.get('TicketID')}",
            f"""Backlog item:
Ticket ID: {row.get('TicketID')}
Type: {row.get('Type')}
Title: {row.get('Title')}
Parent: {row.get('ParentID')}
Story points: {row.get('StoryPoints')}
Priority: {row.get('Priority')}
Status: {row.get('Status')}
Sprint: {sprint.get('SprintName', row.get('SprintID'))}
Sprint ID: {row.get('SprintID')}
Team: {team.get('TeamName', team_id)}
Team ID: {team_id}
Assignee: {assignee.get('Name', row.get('AssigneeID'))}
Assignee ID: {row.get('AssigneeID')}
Architecture section: {sad_section.get('SectionTitle', row.get('SADSectionID'))}
Architecture layer: {sad_section.get('ArchitectureLayer', row.get('Layer'))}
Acceptance criteria present: {row.get('HasAcceptanceCriteria')}
Definition of Done present: {row.get('HasDoD')}
Labels: {row.get('Labels')}
Created date: {row.get('CreatedDate')}""",
            {
                "source": "Backlog",
                "record_type": "backlog_item",
                "ticket_id": row.get("TicketID"),
                "ticket_type": row.get("Type"),
                "team_id": team_id,
                "sprint_id": row.get("SprintID"),
                "assignee_id": row.get("AssigneeID"),
                "sad_section_id": row.get("SADSectionID"),
                "priority": row.get("Priority"),
                "status": row.get("Status"),
            },
        )

    # Dependencies: include both ticket titles so dependency questions work well.
    for row in rows.get("Dependencies", []):
        source_ticket = backlog.get(row.get("FromTicketID"), {})
        target_ticket = backlog.get(row.get("ToTicketID (depends on)"), {})
        add_doc(
            f"dependency-{row.get('DependencyID')}",
            f"""Dependency:
Dependency ID: {row.get('DependencyID')}
From ticket: {row.get('FromTicketID')} — {source_ticket.get('Title')}
Depends on ticket: {row.get('ToTicketID (depends on)')} — {target_ticket.get('Title')}
Dependency type: {row.get('DependencyType')}
Notes: {row.get('Notes')}""",
            {
                "source": "Dependencies",
                "record_type": "dependency",
                "dependency_id": row.get("DependencyID"),
                "from_ticket_id": row.get("FromTicketID"),
                "to_ticket_id": row.get("ToTicketID (depends on)"),
                "dependency_type": row.get("DependencyType"),
            },
        )

    # Change requests
    for row in rows.get("ChangeRequests", []):
        duplicate = backlog.get(row.get("PotentialDuplicateOf"), {})
        sprint = sprints.get(row.get("TargetSprintID"), {})
        add_doc(
            f"change-request-{row.get('CRID')}",
            f"""Change request:
Change request ID: {row.get('CRID')}
Received date: {row.get('ReceivedDate')}
Source: {row.get('Source')}
Request: {row.get('RawText')}
Suggested type: {row.get('SuggestedType')}
Potential duplicate: {row.get('PotentialDuplicateOf')} — {duplicate.get('Title')}
Target sprint: {row.get('TargetSprintID')} — {sprint.get('SprintName')}
Status: {row.get('Status')}""",
            {
                "source": "ChangeRequests",
                "record_type": "change_request",
                "change_request_id": row.get("CRID"),
                "target_sprint_id": row.get("TargetSprintID"),
                "status": row.get("Status"),
            },
        )

    # Intake samples
    for row in rows.get("Intake_Samples", []):
        add_doc(
            f"intake-{row.get('IntakeID')}",
            f"""Intake sample:
Intake ID: {row.get('IntakeID')}
Mode: {row.get('IntakeMode')}
Title: {row.get('Title')}
Content: {row.get('RawContent')}
Stakeholder: {row.get('SourceStakeholder')}""",
            {
                "source": "Intake_Samples",
                "record_type": "intake",
                "intake_id": row.get("IntakeID"),
            },
        )

    # README is useful as dataset-level context, but not as a giant chunk.
    for row in rows.get("README", []):
        values = [v for v in row.values() if v]
        if values:
            text = "Foreman dataset README context:\n" + "\n".join(values)
            add_doc(
                make_id("readme", text),
                text,
                {"source": "README", "record_type": "dataset_readme"},
            )

    if INCLUDE_ANSWER_KEY:
        for row in rows.get("AnswerKey", []):
            add_doc(
                f"answer-{row.get('ScenarioID')}",
                f"""Evaluation answer-key scenario:
Scenario ID: {row.get('ScenarioID')}
Category: {row.get('Category')}
Location: {row.get('Location')}
Description: {row.get('Description')}
Why it matters: {row.get('WhyItMatters')}
Detection hint: {row.get('DetectionHint')}""",
                {
                    "source": "AnswerKey",
                    "record_type": "answer_key",
                    "scenario_id": row.get("ScenarioID"),
                },
            )

    return documents


def ingest(
    reset: bool = True,
    excel_path: Path | str = EXCEL_PATH,
    chroma_path: Path | str = CHROMA_PATH,
    graph_path: Path | str = GRAPH_PATH,
    collection_name: str = COLLECTION_NAME,
):
    excel_path = Path(excel_path)
    chroma_path = Path(chroma_path)
    graph_path = Path(graph_path)
    sheets = pd.read_excel(excel_path, sheet_name=None)
    documents = build_documents(sheets)

    client = chromadb.PersistentClient(path=str(chroma_path))

    if reset:
        try:
            client.delete_collection(collection_name)
        except Exception:
            pass

    collection = client.get_or_create_collection(
        name=collection_name,
        metadata={"description": "Foreman synthetic dataset knowledge base"},
    )

    model = get_embedding_model(EMBEDDING_MODEL)

    batch_size = 64
    for start in range(0, len(documents), batch_size):
        batch = documents[start:start + batch_size]
        ids = [d["id"] for d in batch]
        texts = [d["text"] for d in batch]
        metadata = [d["metadata"] for d in batch]

        embeddings = model.encode(
            texts,
            normalize_embeddings=True,
            show_progress_bar=False,
        ).tolist()

        collection.upsert(
            ids=ids,
            documents=texts,
            metadatas=metadata,
            embeddings=embeddings,
        )

    print(f"Ingested {len(documents)} documents.")
    print(f"Chroma path: {chroma_path}")
    print(f"Collection: {collection_name}")

    # Build the structured dependency graph alongside the vector store.
    graph = build_dependency_graph(excel_path)
    save_graph(graph, graph_path)
    diagnostics = graph_diagnostics(graph)
    print(f"Dependency graph: {diagnostics['nodes']} nodes, {diagnostics['edges']} edges")
    if diagnostics["cycles"]:
        print(f"Dependency cycles: {diagnostics['cycles']}")
    if diagnostics["missing_ticket_nodes"]:
        print(f"Missing ticket references: {diagnostics['missing_ticket_nodes']}")
    print(f"GraphML path: {graph_path}")
    return {"document_count": len(documents), "graph": diagnostics, "chroma_path": str(chroma_path), "graph_path": str(graph_path), "collection_name": collection_name}


if __name__ == "__main__":
    ingest(reset=True)
