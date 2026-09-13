from __future__ import annotations

from pathlib import Path
from typing import Any

import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .capacity import CapacityEngine
from .agent import ScrumMasterAgent
from .demand import DemandShaper
from .health import HealthChecker
from .planner import PlanningError, SprintPlanner
from .graph import DependencyGraph, normalize_dependencies
from .normalizer import (
    normalize_backlog,
    normalize_holidays,
    normalize_sprints,
)
from .repository import Repository


app = FastAPI(
    title="Foreman",
    description="AI Scrum Master - Phase 1",
    version="0.1.0",
)

# Allow the Vite dev server (and any other frontend origin) to call this
# API directly from the browser. Tighten this before deploying publicly.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

repository = Repository()


BASE_DIR = Path(__file__).resolve().parents[2]
DEFAULT_DATASET = Path(__file__).resolve().parent.parent / "foreman_data" / "Foreman_Synthetic_Dataset.xlsx"


@app.get("/")
def root():
    return {
        "application": "Foreman",
        "status": "running",
        "phase": 1,
    }


@app.get("/health")
def health():
    return {
        "status": "ok",
        "dataset_loaded": repository.has_data(),
    }


@app.post("/api/dataset/load")
def load_dataset():
    try:
        repository.load_excel(DEFAULT_DATASET)

        return {
            "status": "loaded",
            "sheets": repository.sheet_names(),
            "summary": repository.summary(),
        }

    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail=str(exc),
        ) from exc

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Unable to load dataset: {exc}",
        ) from exc


class EdgeRef(BaseModel):
    """A single dependency edge, in Dependencies-sheet terms.

    from_ticket depends on to_ticket (to_ticket is the prerequisite).
    """

    from_ticket: str
    to_ticket: str


class CycleResolution(BaseModel):
    drop_edges: list[EdgeRef] = Field(
        default_factory=list,
        description="Dependency rows (FromTicketID/ToTicketID) to drop in order to break a cycle.",
    )
    time_limit_seconds: float = 10.0
    note: str | None = None


def _planning_inputs() -> dict[str, pd.DataFrame]:
    return {
        "backlog": normalize_backlog(repository.get_sheet("Backlog")),
        "dependencies": repository.get_sheet("Dependencies"),
        "sprints": normalize_sprints(repository.get_sheet("Sprints")),
        "members": repository.get_sheet("TeamMembers"),
        "holidays": normalize_holidays(repository.get_sheet("Holidays")),
    }


def _cycle_clarification(graph_engine: DependencyGraph) -> dict[str, Any]:
    """Structured, human-answerable question when the dependency graph has a cycle.

    Mirrors the human-decision-support shape used elsewhere in the agent: a
    question, options, and the evidence behind it, rather than a bare error.
    """
    return {
        "status": "NEEDS_HUMAN_INPUT",
        "reason": "dependency_cycle",
        "question": (
            "The dependency graph has a cycle, so no valid sprint order exists. "
            "Which dependency edge should be dropped to break it?"
        ),
        "cycles": graph_engine.cycles(),
        "candidate_edges_to_drop": graph_engine.cycle_break_candidates(),
        "how_to_resolve": (
            "POST one or more of the candidate edges to "
            "/api/plan/resolve-cycles as "
            '{"drop_edges": [{"from_ticket": "...", "to_ticket": "..."}]} '
            "to drop them and re-run planning."
        ),
        "items": [],
    }


def require_dataset():
    if not repository.has_data():
        raise HTTPException(
            status_code=400,
            detail=(
                "Dataset is not loaded. "
                "Call POST /api/dataset/load first."
            ),
        )


@app.get("/api/graph")
def get_graph():
    require_dataset()

    backlog = normalize_backlog(repository.get_sheet("Backlog"))
    dependencies = repository.get_sheet("Dependencies")

    graph_engine = DependencyGraph(backlog, dependencies)
    cycles = graph_engine.cycles()

    edges = [
        {
            "from": source,
            "to": target,
            **dict(graph_engine.graph.get_edge_data(source, target) or {}),
        }
        for source, target in graph_engine.graph.edges()
    ]

    return {
        "nodes": graph_engine.graph.number_of_nodes(),
        "edges": edges,
        "is_dag": not bool(cycles),
        "cycles": cycles,
        "topological_order": (
            graph_engine.topological_order() if not cycles else []
        ),
        "critical_path": graph_engine.critical_path(),
        "issues": [issue.__dict__ for issue in graph_engine.issues],
    }


@app.post("/api/plan")
def create_plan(time_limit_seconds: float = 10.0):
    require_dataset()

    data = _planning_inputs()

    # Check the dependency graph up front so a cycle produces a resolvable
    # human question instead of a bare 422.
    graph_engine = DependencyGraph(data["backlog"], data["dependencies"])
    if graph_engine.has_cycle():
        return _cycle_clarification(graph_engine)

    try:
        planner = SprintPlanner(
            backlog=data["backlog"],
            dependencies=data["dependencies"],
            sprints=data["sprints"],
            members=data["members"],
            holidays=data["holidays"],
        )
        return planner.solve(time_limit_seconds=time_limit_seconds)
    except PlanningError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/plan/resolve-cycles")
def resolve_plan_cycles(resolution: CycleResolution):
    """Apply human-chosen dependency drops, then re-run planning.

    Takes the edges a human decided to drop (from the `candidate_edges_to_drop`
    in the /api/plan NEEDS_HUMAN_INPUT response), removes them from the
    Dependencies sheet in memory, and re-attempts planning. This never mutates
    the underlying dataset/repository — the drop is scoped to this request,
    matching the project's "decision-support, not auto-mutation" stance.
    """
    require_dataset()

    if not resolution.drop_edges:
        raise HTTPException(
            status_code=400,
            detail="Provide at least one edge in drop_edges to resolve the cycle.",
        )

    data = _planning_inputs()
    dependencies = normalize_dependencies(data["dependencies"])

    drop_pairs = {(edge.from_ticket, edge.to_ticket) for edge in resolution.drop_edges}
    matches = dependencies.apply(
        lambda row: (str(row.get("FromTicketID")), str(row.get("ToTicketID"))) in drop_pairs,
        axis=1,
    )

    if not matches.any():
        raise HTTPException(
            status_code=400,
            detail=(
                "None of the provided drop_edges matched a row in the Dependencies "
                "sheet (from_ticket/to_ticket must match FromTicketID/ToTicketID)."
            ),
        )

    remaining_dependencies = dependencies[~matches].copy()

    graph_engine = DependencyGraph(data["backlog"], remaining_dependencies)
    if graph_engine.has_cycle():
        clarification = _cycle_clarification(graph_engine)
        clarification["message"] = (
            "A cycle remains after dropping the requested edge(s); another edge "
            "must also be dropped."
        )
        clarification["dropped_edges"] = [e.model_dump() for e in resolution.drop_edges]
        return clarification

    try:
        planner = SprintPlanner(
            backlog=data["backlog"],
            dependencies=remaining_dependencies,
            sprints=data["sprints"],
            members=data["members"],
            holidays=data["holidays"],
        )
        result = planner.solve(time_limit_seconds=resolution.time_limit_seconds)
    except PlanningError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    result["resolved_cycle_by_dropping"] = [e.model_dump() for e in resolution.drop_edges]
    if resolution.note:
        result["resolution_note"] = resolution.note
    return result


@app.post("/api/agent/intake")
def shape_demand(payload: dict):
    """Shape raw demand into a structured candidate and hard clarification questions."""
    try:
        return DemandShaper().shape(
            raw_content=str(payload.get("raw_content", "")),
            title=payload.get("title"),
            demand_id=str(payload.get("demand_id", "INTAKE-001")),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/agent/run")
def run_agent(time_limit_seconds: float = 10.0):
    """Run the deterministic AI Scrum Master decision-support loop."""
    require_dataset()
    try:
        return ScrumMasterAgent(repository).run(
            time_limit_seconds=time_limit_seconds
        )
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Scrum Master agent failed: {exc}",
        ) from exc


@app.get("/api/backlog")
def get_backlog():
    require_dataset()

    backlog = normalize_backlog(
        repository.get_sheet("Backlog")
    )

    return backlog.where(
        pd.notna(backlog),
        None,
    ).to_dict(orient="records")


@app.get("/api/dependencies")
def get_dependencies():
    require_dataset()

    return repository.records(
        "Dependencies"
    )


@app.get("/api/capacity")
def get_capacity():
    require_dataset()

    sprints = normalize_sprints(
        repository.get_sheet("Sprints")
    )

    holidays = normalize_holidays(
        repository.get_sheet("Holidays")
    )

    members = repository.get_sheet(
        "TeamMembers"
    )

    engine = CapacityEngine(
        sprints=sprints,
        members=members,
        holidays=holidays,
    )

    return [
        result.model_dump()
        for result in engine.calculate()
    ]


@app.get("/api/health-report")
def get_health_report():
    require_dataset()

    backlog = normalize_backlog(
        repository.get_sheet("Backlog")
    )

    dependencies = repository.get_sheet(
        "Dependencies"
    )

    sprints = normalize_sprints(
        repository.get_sheet("Sprints")
    )

    members = repository.get_sheet(
        "TeamMembers"
    )

    holidays = normalize_holidays(
        repository.get_sheet("Holidays")
    )

    sad_sections = repository.get_sheet(
        "SAD_Sections"
    )

    checker = HealthChecker(
        backlog=backlog,
        dependencies=dependencies,
        sprints=sprints,
        members=members,
        holidays=holidays,
        sad_sections=sad_sections,
    )

    return checker.run().model_dump()
