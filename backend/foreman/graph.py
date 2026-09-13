from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

import networkx as nx
import pandas as pd


@dataclass(frozen=True)
class GraphIssue:
    kind: str
    message: str
    ticket_id: str | None = None


def normalize_dependencies(df: pd.DataFrame) -> pd.DataFrame:
    """Normalize the Dependencies sheet to FromTicketID/ToTicketID columns.

    FromTicketID depends on ToTicketID (ToTicketID is the prerequisite).
    """
    result = df.copy()
    rename_map = {
        "ToTicketID (depends on)": "ToTicketID",
        "ToTicketID": "ToTicketID",
        "FromTicketID": "FromTicketID",
    }
    result = result.rename(columns=rename_map)
    required = {"FromTicketID", "ToTicketID"}
    missing = required - set(result.columns)
    if missing:
        raise ValueError(
            f"Dependency sheet missing required columns: {sorted(missing)}"
        )
    return result


class DependencyGraph:
    """Builds a normalized prerequisite -> dependent DAG from Foreman's data."""

    def __init__(self, backlog: pd.DataFrame, dependencies: pd.DataFrame) -> None:
        self.backlog = backlog.copy()
        self.dependencies = normalize_dependencies(dependencies)
        self.ticket_ids = set(self.backlog["TicketID"].dropna().astype(str))
        self.graph = nx.DiGraph()
        self.issues: list[GraphIssue] = []
        self._build()

    @staticmethod
    def _normalize_dependencies(df: pd.DataFrame) -> pd.DataFrame:
        # Kept for backward compatibility; delegates to the module-level helper.
        return normalize_dependencies(df)

    def _build(self) -> None:
        for ticket_id in self.ticket_ids:
            self.graph.add_node(ticket_id)

        for _, row in self.dependencies.iterrows():
            dependent = row.get("FromTicketID")
            prerequisite = row.get("ToTicketID")

            if pd.isna(dependent) or pd.isna(prerequisite):
                continue

            dependent = str(dependent)
            prerequisite = str(prerequisite)

            # The dataset says: FromTicketID depends on ToTicketID.
            # Therefore graph edge is prerequisite -> dependent.
            if prerequisite not in self.ticket_ids:
                self.issues.append(
                    GraphIssue(
                        kind="missing_prerequisite",
                        message=f"Dependency references missing prerequisite {prerequisite}.",
                        ticket_id=dependent,
                    )
                )
                continue

            if dependent not in self.ticket_ids:
                self.issues.append(
                    GraphIssue(
                        kind="missing_dependent",
                        message=f"Dependency references missing dependent {dependent}.",
                        ticket_id=dependent,
                    )
                )
                continue

            self.graph.add_edge(
                prerequisite,
                dependent,
                dependency_type=row.get("DependencyType"),
                notes=row.get("Notes"),
            )

    def has_cycle(self) -> bool:
        return not nx.is_directed_acyclic_graph(self.graph)

    def cycles(self) -> list[list[str]]:
        return list(nx.simple_cycles(self.graph))

    def cycle_break_candidates(self) -> list[dict[str, str]]:
        """Edges (in dataset FromTicketID/ToTicketID terms) that participate in a cycle.

        Dropping any one of these from the Dependencies sheet breaks that cycle.
        Graph edges are prerequisite -> dependent, i.e. the dataset row is
        FromTicketID=dependent, ToTicketID=prerequisite.
        """
        seen: set[tuple[str, str]] = set()
        candidates: list[dict[str, str]] = []
        for cycle in self.cycles():
            for i in range(len(cycle)):
                prerequisite = cycle[i]
                dependent = cycle[(i + 1) % len(cycle)]
                if not self.graph.has_edge(prerequisite, dependent):
                    continue
                key = (dependent, prerequisite)
                if key in seen:
                    continue
                seen.add(key)
                candidates.append({"from_ticket": dependent, "to_ticket": prerequisite})
        return candidates

    def topological_order(self) -> list[str]:
        if self.has_cycle():
            raise nx.NetworkXUnfeasible("Dependency graph contains a cycle")
        return list(nx.topological_sort(self.graph))

    def dependency_levels(self) -> dict[str, int]:
        """Return longest-path level from a root node."""
        if self.has_cycle():
            return {}
        levels: dict[str, int] = {}
        for node in nx.topological_sort(self.graph):
            predecessors = list(self.graph.predecessors(node))
            levels[node] = 0 if not predecessors else 1 + max(
                levels[p] for p in predecessors
            )
        return levels

    def critical_path(self) -> list[str]:
        """Longest dependency path weighted by story points."""
        if self.has_cycle():
            return []

        weights = {}
        backlog_index = self.backlog.set_index("TicketID")
        for node in self.graph.nodes:
            points = backlog_index.loc[node, "StoryPoints"] if node in backlog_index.index else 0
            try:
                weights[node] = max(int(round(float(points or 0))), 0)
            except (TypeError, ValueError):
                weights[node] = 0

        weighted = self.graph.copy()
        for u, v in weighted.edges():
            weighted[u][v]["weight"] = weights.get(v, 0)
        path = nx.dag_longest_path(weighted, weight="weight")
        return list(path)

    def subgraph_for_work_items(self, ticket_ids: Iterable[str]) -> nx.DiGraph:
        ids = set(ticket_ids)
        return self.graph.subgraph(ids).copy()
