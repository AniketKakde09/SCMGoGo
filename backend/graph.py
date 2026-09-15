from __future__ import annotations

from pathlib import Path
from typing import Any

import networkx as nx
import pandas as pd

ROOT = Path(__file__).resolve().parent
EXCEL_PATH = ROOT / "data" / "Foreman_Synthetic_Dataset.xlsx"
GRAPH_PATH = ROOT / "vectorstore" / "dependency_graph.graphml"
DEPENDENCY_TARGET_COLUMN = "ToTicketID (depends on)"


def clean(value: Any) -> str:
    if pd.isna(value):
        return ""
    return str(value).strip()


def build_dependency_graph(excel_path: Path | str = EXCEL_PATH) -> nx.DiGraph:
    excel_path = Path(excel_path)
    dependencies = pd.read_excel(excel_path, sheet_name="Dependencies").fillna("")
    backlog = pd.read_excel(excel_path, sheet_name="Backlog").fillna("")
    graph = nx.DiGraph(name="Foreman Ticket Dependency Graph")

    for _, row in backlog.iterrows():
        ticket_id = clean(row.get("TicketID"))
        if ticket_id:
            graph.add_node(
                ticket_id,
                title=clean(row.get("Title")),
                ticket_type=clean(row.get("Type")),
                status=clean(row.get("Status")),
                priority=clean(row.get("Priority")),
                sprint_id=clean(row.get("SprintID")),
                parent_id=clean(row.get("ParentID")),
                sad_section_id=clean(row.get("SADSectionID")),
            )

    for _, row in dependencies.iterrows():
        source = clean(row.get("FromTicketID"))
        target = clean(row.get(DEPENDENCY_TARGET_COLUMN))
        if not source or not target:
            continue
        if source not in graph:
            graph.add_node(source, title="")
        if target not in graph:
            graph.add_node(target, title="")
        graph.add_edge(
            source,
            target,
            dependency_id=clean(row.get("DependencyID")),
            dependency_type=clean(row.get("DependencyType")),
            notes=clean(row.get("Notes")),
        )
    return graph


def save_graph(graph: nx.DiGraph, path: Path = GRAPH_PATH) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    nx.write_graphml(graph, path)


def load_graph(path: Path = GRAPH_PATH, excel_path: Path | str = EXCEL_PATH) -> nx.DiGraph:
    path = Path(path)
    if not path.exists():
        graph = build_dependency_graph(excel_path)
        save_graph(graph, path)
        return graph
    return nx.read_graphml(path)


def dependency_chain(ticket_id: str, graph=None, max_depth: int = 3) -> list[dict]:
    graph = graph or load_graph()
    ticket_id = clean(ticket_id)
    if ticket_id not in graph:
        return []
    results, seen, queue = [], {ticket_id}, [(ticket_id, 0)]
    while queue:
        current, depth = queue.pop(0)
        if depth >= max_depth:
            continue
        for dep in graph.successors(current):
            if dep in seen:
                continue
            seen.add(dep)
            node, edge = graph.nodes[dep], graph.edges[current, dep]
            results.append({
                "ticket_id": dep,
                "title": node.get("title", ""),
                "status": node.get("status", ""),
                "priority": node.get("priority", ""),
                "depth": depth + 1,
                "dependency_id": edge.get("dependency_id", ""),
                "dependency_type": edge.get("dependency_type", ""),
                "notes": edge.get("notes", ""),
                "depends_from": current,
            })
            queue.append((dep, depth + 1))
    return results


def blocking_candidates(ticket_id: str, graph=None) -> list[dict]:
    return dependency_chain(ticket_id, graph=graph, max_depth=1)


def reverse_dependents(ticket_id: str, graph=None) -> list[dict]:
    graph = graph or load_graph()
    ticket_id = clean(ticket_id)
    if ticket_id not in graph:
        return []
    results = []
    for dep in graph.predecessors(ticket_id):
        node, edge = graph.nodes[dep], graph.edges[dep, ticket_id]
        results.append({
            "ticket_id": dep,
            "title": node.get("title", ""),
            "status": node.get("status", ""),
            "priority": node.get("priority", ""),
            "dependency_id": edge.get("dependency_id", ""),
            "dependency_type": edge.get("dependency_type", ""),
            "notes": edge.get("notes", ""),
        })
    return results


def graph_diagnostics(graph=None) -> dict:
    graph = graph or load_graph()
    return {
        "nodes": graph.number_of_nodes(),
        "edges": graph.number_of_edges(),
        "cycles": list(nx.simple_cycles(graph)),
        "missing_ticket_nodes": [n for n, d in graph.nodes(data=True) if not d.get("title")],
    }
