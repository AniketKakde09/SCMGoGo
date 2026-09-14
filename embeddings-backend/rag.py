from __future__ import annotations

import os
import re
from typing import Any

from search import ForemanSearch

SYSTEM_PROMPT = """You are Foreman, an AI Scrum Master.

Answer questions using ONLY the supplied Foreman dataset context.
Do not invent tickets, people, teams, sprint information, dependencies,
architecture details, or dates.

For dependency/blocker questions, distinguish between:
- an explicit dependency recorded in the dataset
- a possible blocker inferred from a dependency target's status
- a semantic match that is not an actual dependency

If the context is insufficient, say so. Always mention relevant ticket IDs
and dependency IDs when available.
"""

TICKET_RE = re.compile(r"\b(?:EPIC|F|T)-\d+\b", re.IGNORECASE)

# High-confidence domain aliases. These prevent a blocker question such as
# "authentication" from accidentally combining unrelated semantic matches
# such as Security & Compliance (SAD-12).
DOMAIN_ALIASES = {
    "authentication": "SAD-02",
    "auth": "SAD-02",
    "identity": "SAD-02",
    "access management": "SAD-02",
    "oauth": "SAD-02",
    "oidc": "SAD-02",
    "rbac": "SAD-02",
    "token": "SAD-02",
    "session": "SAD-02",
    "user pool": "SAD-02",
}

ACTIVE_STATUSES = {"to do", "in progress", "blocked", "open", "reopened"}
DONE_STATUSES = {"done", "closed", "cancelled", "canceled"}


class ForemanRAG:
    def __init__(self, top_k: int = 6, graph_depth: int = 2, searcher: ForemanSearch | None = None):
        self.searcher = searcher or ForemanSearch()
        self.top_k = top_k
        self.graph_depth = graph_depth

    def retrieve(self, question: str) -> list[dict[str, Any]]:
        return self.searcher.search(question, top_k=self.top_k)

    def _ticket_ids(self, results: list[dict[str, Any]]) -> list[str]:
        ids, seen = [], set()
        for result in results:
            metadata = result.get("metadata", {})
            ticket_id = metadata.get("ticket_id")
            if ticket_id and ticket_id not in seen:
                seen.add(ticket_id)
                ids.append(ticket_id)
            for match in TICKET_RE.findall(result.get("text", "")):
                match = match.upper()
                if match not in seen:
                    seen.add(match)
                    ids.append(match)
        return ids

    def _is_dependency_question(self, question: str) -> bool:
        q = question.lower()
        terms = (
            "block", "blocking", "blocked", "dependency", "dependencies",
            "depends", "dependent", "cycle", "cycles", "downstream", "upstream",
            "bottleneck", "waiting on", "waiting for",
        )
        return any(term in q for term in terms)

    def _is_cycle_question(self, question: str) -> bool:
        q = question.lower()
        return "cycle" in q or "cyclic" in q

    def _format_ticket(self, ticket_id: str) -> str:
        ticket = self.searcher.ticket(ticket_id)
        if not ticket:
            node = self.searcher.graph.nodes.get(ticket_id, {})
            title = node.get("title", "")
            status = node.get("status", "")
        else:
            title = ticket.get("Title", ticket.get("title", ""))
            status = ticket.get("Status", ticket.get("status", ""))
        title = str(title).strip()
        status = str(status).strip()
        if title and status:
            return f"{ticket_id} — {title} (Status: {status})"
        if title:
            return f"{ticket_id} — {title}"
        if status:
            return f"{ticket_id} (Status: {status})"
        return ticket_id

    def _cycle_answer(self, question: str) -> str | None:
        ticket_ids = TICKET_RE.findall(question)
        if ticket_ids:
            for ticket_id in ticket_ids:
                ticket_id = ticket_id.upper()
                cycles = self.searcher.cycles_for(ticket_id)
                if cycles:
                    cycle = cycles[0]
                    cycle_text = " → ".join(cycle + [cycle[0]])
                    dep_lines = []
                    graph = self.searcher.graph
                    for source, target in zip(cycle, cycle[1:] + [cycle[0]]):
                        edge = graph.edges[source, target]
                        dep_lines.append(
                            f"- {edge.get('dependency_id', '')}: "
                            f"{source} depends on {target}"
                        )
                    return (
                        f"Yes. {ticket_id} is part of a dependency cycle:\n\n"
                        f"{cycle_text}\n\n"
                        "Dependencies:\n" + "\n".join(dep_lines)
                    )
            return f"No dependency cycle was found involving {ticket_ids[0].upper()} in the recorded dependency graph."

        cycles = self.searcher.all_cycles()
        if not cycles:
            return "No dependency cycles were found in the recorded dependency graph."
        lines = [f"I found {len(cycles)} dependency cycle(s):"]
        for cycle in cycles:
            lines.append("- " + " → ".join(cycle + [cycle[0]]))
        return "\n".join(lines)

    def _domain_from_question(self, question: str, results: list[dict[str, Any]]) -> list[str]:
        q = question.lower()
        for phrase, sad_id in DOMAIN_ALIASES.items():
            if phrase in q:
                return [sad_id]

        # Otherwise use the strongest semantic architecture match, but only
        # keep architecture IDs that are actually represented by the results.
        for result in results:
            metadata = result.get("metadata", {})
            sid = metadata.get("sad_section_id")
            if sid:
                return [sid]
        return []

    def _ticket_dependency_answer(self, question: str) -> str | None:
        ticket_ids = TICKET_RE.findall(question)
        if len(ticket_ids) != 1:
            return None
        ticket_id = ticket_ids[0].upper()

        # "Which tickets are blocked by T-111?" asks for reverse dependents.
        q = question.lower()
        reverse = any(p in q for p in (
            "blocked by", "depend on", "depends on", "dependent on",
            "which tickets use", "who is waiting on",
        )) and "what is blocking" not in q

        if reverse:
            rows = self.searcher.reverse_dependents(ticket_id)
            if not rows:
                return f"No explicit dependency records show another ticket depending on {ticket_id}."
            lines = [f"Tickets that explicitly depend on {ticket_id}:"]
            for row in rows:
                lines.append(
                    f"- {row['ticket_id']} — {row['title']} "
                    f"(Status: {row['status']}) [{row['dependency_id']}; {row['dependency_type']}]"
                )
            return "\n".join(lines)

        # For "what is blocking T-136", inspect its actual dependency targets.
        if any(p in q for p in ("what is blocking", "what's blocking", "what blocks", "blocking")):
            rows = self.searcher.blocking_candidates(ticket_id)
            if not rows:
                return f"No explicit dependency records show a blocker for {ticket_id}."
            lines = [f"Explicit dependencies for {self._format_ticket(ticket_id)}:"]
            unfinished = []
            for row in rows:
                status = str(row.get("status", "")).strip()
                marker = "potential blocker" if status.lower() in ACTIVE_STATUSES else "not currently active"
                line = (
                    f"- {row['dependency_id']}: {ticket_id} depends on "
                    f"{self._format_ticket(row['ticket_id'])} "
                    f"[{row['dependency_type']}; {marker}]"
                )
                lines.append(line)
                if status.lower() in ACTIVE_STATUSES:
                    unfinished.append(row)
            if unfinished:
                lines.append("\nPotential blockers are dependency targets whose recorded status is not complete.")
            else:
                lines.append("\nNo dependency target is currently recorded as unfinished.")
            cycles = self.searcher.cycles_for(ticket_id)
            if cycles:
                cycle = cycles[0]
                lines.append("\nThis ticket is also part of a dependency cycle: " + " → ".join(cycle + [cycle[0]]) + ".")
            return "\n".join(lines)
        return None

    def _domain_dependency_answer(self, question: str) -> str:
        results = self.retrieve(question)
        sad_ids = self._domain_from_question(question, results)

        if not sad_ids:
            ticket_ids = self._ticket_ids(results)
        else:
            ticket_ids = self.searcher.tickets_for_sad_sections(sad_ids)

        if not ticket_ids:
            return "I could not identify a relevant ticket or architecture area in the dataset."

        graph = self.searcher.graph
        relevant = set(ticket_ids)
        rows = []
        seen_edges = set()

        # A dependency is relevant if either its source or target is part of
        # the selected domain. This catches cross-domain prerequisites while
        # excluding unrelated semantic matches from other SAD sections.
        for source, target, data in graph.edges(data=True):
            if source not in relevant and target not in relevant:
                continue
            key = (source, target, data.get("dependency_id", ""))
            if key in seen_edges:
                continue
            seen_edges.add(key)
            rows.append((source, target, data))

        domain_label = ", ".join(sad_ids) if sad_ids else "the matched domain"
        if not rows:
            return (
                f"I found {domain_label}, but there are no explicit dependency records "
                "connecting the matched work. Semantic relevance alone is not considered a blocker."
            )

        blocking = []
        completed = []
        for source, target, data in rows:
            node = graph.nodes.get(target, {})
            status = str(node.get("status", "")).strip()
            row = (source, target, data, status)
            if status.lower() in ACTIVE_STATUSES:
                blocking.append(row)
            else:
                completed.append(row)

        lines = [f"Authentication/domain: {domain_label}.", "", "Potential blockers (explicit dependency + unfinished target):"]
        if blocking:
            for source, target, data, status in blocking:
                lines.append(
                    f"- {self._format_ticket(target)} is depended on by "
                    f"{self._format_ticket(source)}; "
                    f"{data.get('dependency_id', '')}; {data.get('dependency_type', '')}"
                )
        else:
            lines.append("- None identified from unfinished dependency targets.")

        if completed:
            lines.append("\nExplicit dependencies whose targets are already complete:")
            for source, target, data, status in completed:
                lines.append(
                    f"- {self._format_ticket(target)} is depended on by "
                    f"{self._format_ticket(source)}; {data.get('dependency_id', '')}"
                )

        # Explicitly call out matched tickets with no dependency edges. This is
        # especially important for F-04: semantic relevance does not imply a blocker.
        matched_without_edges = [
            tid for tid in ticket_ids
            if graph.in_degree(tid) == 0 and graph.out_degree(tid) == 0
        ]
        if matched_without_edges:
            shown = ", ".join(matched_without_edges[:12])
            lines.append(
                f"\nNo explicit dependency edges are recorded for: {shown}. "
                "Those tickets are not considered blocked merely because they are semantically relevant."
            )

        cycles = [c for c in self.searcher.all_cycles() if set(c) & relevant]
        if cycles:
            lines.append("\nDependency cycle touching this domain:")
            for cycle in cycles:
                lines.append("- " + " → ".join(cycle + [cycle[0]]))

        return "\n".join(lines)

    def build_context(self, results: list[dict[str, Any]]) -> str:
        blocks = []
        for result in results:
            blocks.append(
                f"SOURCE ID: {result['id']}\n"
                f"METADATA: {result['metadata']}\n"
                f"CONTENT:\n{result['text']}"
            )
        return "\n\n".join(blocks)

    def answer_with_openai(self, question: str, model: str | None = None) -> str:
        from openai import OpenAI
        model = model or os.getenv("OPENAI_MODEL", "gpt-5-mini")
        results = self.retrieve(question)
        context = self.build_context(results)
        client = OpenAI()
        response = client.responses.create(
            model=model,
            instructions=SYSTEM_PROMPT,
            input=f"Question:\n{question}\n\nRetrieved dataset context:\n{context}",
        )
        return response.output_text

    def answer(self, question: str) -> str:
        if self._is_cycle_question(question):
            exact = self._cycle_answer(question)
            if exact:
                return exact

        if self._is_dependency_question(question):
            exact_ticket = self._ticket_dependency_answer(question)
            if exact_ticket:
                return exact_ticket
            return self._domain_dependency_answer(question)

        if os.getenv("LLM_PROVIDER", "").lower() == "openai":
            return self.answer_with_openai(question)
        return self.build_context(self.retrieve(question))


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Foreman hybrid RAG")
    parser.add_argument("question")
    parser.add_argument("--top-k", type=int, default=6)
    parser.add_argument("--graph-depth", type=int, default=2)
    args = parser.parse_args()
    print(ForemanRAG(args.top_k, args.graph_depth).answer(args.question))
