from __future__ import annotations

import argparse
import json
import re
from typing import Any

from llm import LLMClient
from search import ForemanSearch


TICKET_RE = re.compile(r"\b(?:EPIC|F|T)-\d+\b", re.IGNORECASE)


class IntakeProcessor:
    """Generic free-form intake processor.

    No business-domain vocabulary, ticket IDs, SAD IDs, actors, capabilities,
    or expected outcomes are hardcoded here. The processor discovers relevant
    evidence from the supplied knowledge base.
    """

    def __init__(self, top_k: int = 8, llm: LLMClient | None = None, searcher: ForemanSearch | None = None):
        self.searcher = searcher or ForemanSearch()
        self.top_k = top_k
        self.llm = llm or LLMClient()
        self.sad_sections = self.searcher.sad_sections

    @staticmethod
    def clean_text(text: str) -> str:
        return " ".join(str(text or "").split()).strip()

    @staticmethod
    def _unique(values: list[str]) -> list[str]:
        seen = set()
        result = []
        for value in values:
            value = str(value).strip()
            key = value.lower()
            if value and key not in seen:
                seen.add(key)
                result.append(value)
        return result

    def _normalize_result(self, result: dict[str, Any]) -> dict[str, Any]:
        metadata = result.get("metadata", {}) or {}
        return {
            "id": result.get("id"),
            "distance": result.get("distance"),
            "record_type": metadata.get("record_type", ""),
            "ticket_id": metadata.get("ticket_id", ""),
            "sad_section_id": metadata.get("sad_section_id", ""),
            "sad_title": metadata.get("sad_title", ""),
            "section_number": metadata.get("section_number", ""),
            "section_title": metadata.get("section_title", ""),
            "title": metadata.get("title", ""),
            "status": metadata.get("status", ""),
            "priority": metadata.get("priority", ""),
            "text": result.get("text", ""),
        }

    def retrieve(self, intake_text: str) -> list[dict[str, Any]]:
        return [self._normalize_result(r) for r in self.searcher.search(intake_text, top_k=self.top_k)]

    def _ticket_ids(self, results: list[dict[str, Any]]) -> list[str]:
        ids = []
        for result in results:
            if result.get("ticket_id"):
                ids.append(result["ticket_id"])
            ids.extend(m.upper() for m in TICKET_RE.findall(result.get("text", "")))
        return self._unique(ids)

    def _architecture_areas(self, results: list[dict[str, Any]]) -> list[dict[str, str]]:
        """Resolve architecture matches to human-readable SAD titles.

        Architecture documents store their own SAD metadata. Backlog and
        dependency documents may only carry the SAD section ID, so use the
        structured workbook as the authoritative fallback.
        """
        found = {}
        for result in results:
            sid = str(result.get("sad_section_id", "")).strip()
            if not sid:
                continue

            sad_title = str(result.get("sad_title", "")).strip()
            section_number = str(result.get("section_number", "")).strip()
            section_title = str(result.get("section_title", "")).strip()
            architecture_layer = str(result.get("architecture_layer", "")).strip()

            # Fallback to the structured Excel sheet when the retrieved
            # Chroma metadata came from an enriched ticket rather than the
            # architecture document itself.
            if not section_title or not sad_title:
                rows = self.sad_sections[
                    self.sad_sections["SectionID"].astype(str).str.strip().str.upper() == sid.upper()
                ]
                if not rows.empty:
                    row = rows.iloc[0]
                    sad_title = str(row.get("SADTitle", "") or "").strip()
                    section_number = str(row.get("SectionNumber", "") or "").strip()
                    section_title = str(row.get("SectionTitle", "") or "").strip()
                    architecture_layer = str(row.get("ArchitectureLayer", "") or "").strip()

            # Prefer the actual SAD section title. Keep SAD title separate so
            # callers can see both the document and section context.
            display_title = section_title or sad_title or str(result.get("title", "")).strip()
            found.setdefault(
                sid,
                {
                    "sad_section_id": sid,
                    "sad_title": sad_title,
                    "section_number": section_number,
                    "section_title": section_title,
                    "architecture_layer": architecture_layer,
                    "title": display_title,
                },
            )
        return list(found.values())

    def _related_tickets(self, ticket_ids: list[str]) -> list[dict[str, Any]]:
        output = []
        for ticket_id in ticket_ids:
            ticket = self.searcher.ticket(ticket_id)
            if ticket:
                output.append({
                    "ticket_id": ticket_id,
                    "title": ticket.get("Title", ""),
                    "type": ticket.get("Type", ""),
                    "status": ticket.get("Status", ""),
                    "priority": ticket.get("Priority", ""),
                    "sprint_id": ticket.get("SprintID", ""),
                    "sad_section_id": ticket.get("SADSectionID", ""),
                })
        return output

    def _dependency_impacts(self, ticket_ids: list[str]) -> list[dict[str, Any]]:
        graph = self.searcher.graph
        impacts = []
        seen = set()
        for ticket_id in ticket_ids:
            if ticket_id not in graph:
                continue
            for row in self.searcher.blocking_candidates(ticket_id):
                key = (ticket_id, row["ticket_id"], row.get("dependency_id", ""))
                if key in seen:
                    continue
                seen.add(key)
                impacts.append({
                    "ticket_id": ticket_id,
                    "depends_on": row["ticket_id"],
                    "dependency_id": row.get("dependency_id", ""),
                    "dependency_type": row.get("dependency_type", ""),
                    "target_status": row.get("status", ""),
                })
            for row in self.searcher.reverse_dependents(ticket_id):
                key = (row["ticket_id"], ticket_id, row.get("dependency_id", ""))
                if key in seen:
                    continue
                seen.add(key)
                impacts.append({
                    "ticket_id": row["ticket_id"],
                    "depends_on": ticket_id,
                    "dependency_id": row.get("dependency_id", ""),
                    "dependency_type": row.get("dependency_type", ""),
                    "target_status": self.searcher.graph.nodes.get(ticket_id, {}).get("status", ""),
                })
        return impacts

    def _overlap_candidates(self, results: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Return semantic overlap candidates without calling them duplicates."""
        candidates = []
        for result in results:
            if result.get("record_type") in {"backlog_item", "architecture"}:
                candidates.append({
                    "ticket_id": result.get("ticket_id", ""),
                    "sad_section_id": result.get("sad_section_id", ""),
                    "title": result.get("title", ""),
                    "status": result.get("status", ""),
                    "distance": result.get("distance"),
                    "evidence": result.get("text", ""),
                })
        return candidates

    def _cycles(self, ticket_ids: list[str]) -> list[list[str]]:
        relevant = set(ticket_ids)
        return [cycle for cycle in self.searcher.all_cycles() if relevant.intersection(cycle)]

    def build_evidence(self, intake_text: str) -> dict[str, Any]:
        text = self.clean_text(intake_text)
        if not text:
            raise ValueError("Intake text cannot be empty.")

        results = self.retrieve(text)
        ticket_ids = self._ticket_ids(results)
        architecture = self._architecture_areas(results)
        dependencies = self._dependency_impacts(ticket_ids)
        cycles = self._cycles(ticket_ids)

        return {
            "intake": {"raw_text": intake_text, "cleaned_text": text},
            "retrieval": results,
            "architecture_areas": architecture,
            "related_tickets": self._related_tickets(ticket_ids),
            "overlap_candidates": self._overlap_candidates(results),
            "dependency_impacts": dependencies,
            "dependency_cycles": cycles,
        }

    def _llm_assess(self, evidence: dict[str, Any]) -> dict[str, Any] | None:
        if not self.llm.enabled:
            return None

        system = """You are an intake triage assistant for a software delivery knowledge base.
Interpret ONLY the evidence supplied by the application. Do not invent facts.

Classify the intake using one of: new_work, enhancement, existing_work,
duplicate_candidate, related_work, clarification_needed.

Rules:
- Semantic similarity is evidence of possible overlap, not proof of duplication.
- A dependency claim is valid only when it appears in dependency_impacts.
- Architecture matches are retrieval candidates, not proof that work belongs there.
- Preserve explicit constraints, measurable targets, dates, actors, and risks from the intake.
- If evidence is insufficient, choose clarification_needed.
- Do not manufacture ticket IDs, SAD IDs, names, dates, priorities, or relationships.
Return JSON only."""

        payload = {
            "intake": evidence["intake"],
            "architecture_areas": evidence["architecture_areas"],
            "related_tickets": evidence["related_tickets"],
            "overlap_candidates": evidence["overlap_candidates"],
            "dependency_impacts": evidence["dependency_impacts"],
            "dependency_cycles": evidence["dependency_cycles"],
        }
        user = f"Assess this intake from the supplied evidence:\n{json.dumps(payload, ensure_ascii=False, indent=2)}"
        return self.llm.generate_json(system, user, max_tokens=2200)

    def process(self, intake_text: str) -> dict[str, Any]:
        evidence = self.build_evidence(intake_text)
        assessment = self._llm_assess(evidence)
        report = dict(evidence)
        report["llm_assessment"] = assessment
        report["llm_provider"] = self.llm.provider
        return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Process arbitrary free-form Foreman intake")
    parser.add_argument("text", nargs="?", help="Intake text")
    parser.add_argument("--file", help="Read intake text from a UTF-8 text file")
    parser.add_argument("--top-k", type=int, default=8)
    parser.add_argument("--json", action="store_true", help="Print the full JSON report")
    args = parser.parse_args()

    if args.file:
        with open(args.file, "r", encoding="utf-8") as handle:
            text = handle.read()
    elif args.text:
        text = args.text
    else:
        parser.error("Provide intake text or --file")

    report = IntakeProcessor(top_k=args.top_k).process(text)
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False, default=str))
        return

    assessment = report.get("llm_assessment")
    print("\n=== Intake ===")
    print(report["intake"]["cleaned_text"])
    print("\n=== Architecture matches ===")
    for item in report["architecture_areas"]:
        sad_title = item.get("sad_title", "")
        section_number = item.get("section_number", "")
        section_title = item.get("section_title") or item.get("title", "")
        label = f"{item['sad_section_id']}"
        if section_number:
            label += f" ({section_number})"
        print(f"- {label} — {section_title}" + (f" [{sad_title}]" if sad_title else ""))
    print("\n=== Related tickets ===")
    for item in report["related_tickets"]:
        print(f"- {item['ticket_id']} — {item['title']} [{item['status']}]")
    print("\n=== Dependency impacts ===")
    for item in report["dependency_impacts"]:
        print(f"- {item['ticket_id']} depends on {item['depends_on']} [{item['dependency_id']}; {item['dependency_type']}] target={item['target_status']}")
    print("\n=== LLM assessment ===")
    print(json.dumps(assessment, indent=2, ensure_ascii=False) if assessment else "LLM disabled. Set LLM_PROVIDER=groq or bedrock to enable interpretation.")


if __name__ == "__main__":
    main()
