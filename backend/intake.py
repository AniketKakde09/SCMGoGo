from __future__ import annotations

import argparse
import json
import re
import uuid
from typing import Any

import pandas as pd

from llm import LLMClient
from search import ForemanSearch


TICKET_RE = re.compile(r"\b(?:EPIC|F|T)-\d+\b", re.IGNORECASE)

# Words that, in proximity to each other, signal the user explicitly wants a
# new ticket/story/issue created — as opposed to just asking about existing
# work. Kept as simple word-proximity matching rather than a rigid phrase
# list so "create a ticket to delete the S3 bucket" and "can we raise a new
# story for this" both match.
_CREATE_VERBS = {"create", "add", "make", "open", "raise", "file", "log", "draft", "start", "new"}
_TICKET_NOUNS = {"ticket", "tickets", "story", "stories", "issue", "issues", "task", "tasks", "feature", "features", "epic", "epics", "item", "items"}
_WORD_RE = re.compile(r"[a-z']+")


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
        results = self.searcher.search(intake_text, top_k=self.top_k)
        return [self._normalize_result(r) for r in results]

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

    @staticmethod
    def _clean(value: Any) -> str:
        try:
            if pd.isna(value):
                return ""
        except (TypeError, ValueError):
            pass
        return str(value).strip()

    def _backlog_row(self, ticket_id: str) -> "pd.Series | None":
        if not ticket_id:
            return None
        df = self.searcher.backlog
        rows = df[df["TicketID"].astype(str).str.strip().str.upper() == ticket_id.upper()]
        if rows.empty:
            return None
        return rows.iloc[0]

    def _sad_row(self, sad_id: str) -> "pd.Series | None":
        if not sad_id:
            return None
        df = self.sad_sections
        rows = df[df["SectionID"].astype(str).str.strip().str.upper() == sad_id.upper()]
        if rows.empty:
            return None
        return rows.iloc[0]

    def _item_from_row(self, row: "pd.Series") -> dict[str, Any]:
        return {
            "id": self._clean(row.get("TicketID")),
            "type": self._clean(row.get("Type")),
            "title": self._clean(row.get("Title")),
            "parent_id": self._clean(row.get("ParentID")),
            "sad_section_id": self._clean(row.get("SADSectionID")),
            "layer": self._clean(row.get("Layer")),
            "story_points": row.get("StoryPoints") if pd.notna(row.get("StoryPoints")) else None,
            "priority": self._clean(row.get("Priority")),
            "status": self._clean(row.get("Status")),
            "sprint_id": self._clean(row.get("SprintID")),
            "assignee_id": self._clean(row.get("AssigneeID")),
            "labels": self._clean(row.get("Labels")),
        }

    def _sad_item_from_row(self, row: "pd.Series") -> dict[str, Any]:
        return {
            "id": self._clean(row.get("SectionID")),
            "title": self._clean(row.get("SADTitle")),
            "section_number": self._clean(row.get("SectionNumber")),
            "section_title": self._clean(row.get("SectionTitle")),
            "architecture_layer": self._clean(row.get("ArchitectureLayer")),
            "summary": self._clean(row.get("Summary")),
        }

    def build_canvas_graph(
        self,
        ticket_ids: list[str],
        dependency_impacts: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Canvas-ready subgraph: matched tickets plus the full SAD -> Epic ->
        Issue hierarchy path up to the root for each one, in the same node/edge
        shape as the full-dataset ``/canvas`` endpoint so the frontend can
        render either with one component.

        Tickets referenced only as dependency endpoints (not directly matched
        by retrieval) are still resolved and included so every dependency
        edge has both of its nodes present.
        """
        matched = {tid.upper() for tid in ticket_ids}
        sad_nodes: dict[str, dict[str, Any]] = {}
        epic_nodes: dict[str, dict[str, Any]] = {}
        issue_nodes: dict[str, dict[str, Any]] = {}
        hierarchy_edges: list[dict[str, Any]] = []
        seen_hierarchy_edges: set[str] = set()

        def add_hierarchy_edge(source: str, target: str) -> None:
            if not source or not target:
                return
            edge_id = f"hierarchy-{source}-{target}"
            if edge_id in seen_hierarchy_edges:
                return
            seen_hierarchy_edges.add(edge_id)
            hierarchy_edges.append({
                "id": edge_id,
                "source": source,
                "target": target,
                "kind": "hierarchy",
                "relation": "contains",
            })

        def ensure_sad(sad_id: str) -> None:
            if not sad_id or sad_id in sad_nodes:
                return
            row = self._sad_row(sad_id)
            if row is not None:
                sad_nodes[sad_id] = self._sad_item_from_row(row)

        def walk_to_root(ticket_id: str) -> None:
            if not ticket_id or ticket_id in issue_nodes or ticket_id in epic_nodes:
                return
            row = self._backlog_row(ticket_id)
            if row is None:
                return
            item = self._item_from_row(row)
            item["matched"] = item["id"].upper() in matched
            item_type = item["type"].lower()

            if item_type == "epic":
                epic_nodes[item["id"]] = item
                ensure_sad(item["sad_section_id"])
                add_hierarchy_edge(item["sad_section_id"], item["id"])
                return

            issue_nodes[item["id"]] = item
            parent_row = self._backlog_row(item["parent_id"])

            if parent_row is not None and self._clean(parent_row.get("Type")).lower() == "epic":
                parent_item = self._item_from_row(parent_row)
                parent_item["matched"] = parent_item["id"].upper() in matched
                epic_nodes.setdefault(parent_item["id"], parent_item)
                ensure_sad(parent_item["sad_section_id"])
                add_hierarchy_edge(parent_item["sad_section_id"], parent_item["id"])
                add_hierarchy_edge(parent_item["id"], item["id"])
            elif item["sad_section_id"]:
                # Orphaned issue: attach directly to its SAD section, matching
                # the fallback used by the full-dataset canvas endpoint.
                ensure_sad(item["sad_section_id"])
                add_hierarchy_edge(item["sad_section_id"], item["id"])

        all_ticket_ids = list(dict.fromkeys(
            ticket_ids
            + [impact["ticket_id"] for impact in dependency_impacts]
            + [impact["depends_on"] for impact in dependency_impacts]
        ))
        for ticket_id in all_ticket_ids:
            walk_to_root(ticket_id)

        dependency_edges: list[dict[str, Any]] = []
        seen_dep_edges: set[tuple[str, str, str]] = set()
        for impact in dependency_impacts:
            key = (impact["ticket_id"], impact["depends_on"], impact.get("dependency_id", ""))
            if key in seen_dep_edges:
                continue
            seen_dep_edges.add(key)
            dependency_edges.append({
                "id": impact.get("dependency_id") or f"dependency-{impact['ticket_id']}-{impact['depends_on']}",
                "source": impact["ticket_id"],
                "target": impact["depends_on"],
                "kind": "dependency",
                "dependency_type": impact.get("dependency_type", ""),
            })

        return {
            "sad_sections": list(sad_nodes.values()),
            "epics": list(epic_nodes.values()),
            "issues": list(issue_nodes.values()),
            "hierarchy_edges": hierarchy_edges,
            "dependencies": dependency_edges,
        }

    def _matched_sad_ids(self, evidence: dict[str, Any], story: dict[str, Any] | None = None) -> list[str]:
        """SAD section IDs the current conversational turn is actually about.

        Empty result means the message was generic / nothing grounded was
        found, and the frontend should keep showing the default full canvas
        instead of a filtered one.
        """
        ids: list[str] = []
        for area in evidence.get("architecture_areas", []):
            sid = str(area.get("sad_section_id", "")).strip()
            if sid:
                ids.append(sid)
        for ticket in evidence.get("related_tickets", []):
            sid = str(ticket.get("sad_section_id", "")).strip()
            if sid:
                ids.append(sid)
        if story:
            sid = str(story.get("sad_section_id", "")).strip()
            if sid:
                ids.append(sid)
        return self._unique(ids)

    def build_scoped_canvas(
        self,
        sad_ids: list[str],
        story: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        """Canvas subgraph scoped to only the matched SAD section(s).

        Includes: the SAD node(s), every Epic filed under them, every
        Issue/Story/Feature filed under those Epics (plus any issue attached
        directly to the SAD with no Epic parent), and a Story just drafted
        in this turn if it belongs to one of those Epics/SADs. Dependency
        edges are kept only when both endpoints are already in scope, so a
        cross-SAD dependency won't pull unrelated tickets back onto the
        canvas. Returns None if no SAD was matched at all — same shape as
        the full-dataset canvas.py output, so the frontend can swap it in
        with the existing renderer.
        """
        scope_sad_ids = {str(s).strip().upper() for s in sad_ids if str(s).strip()}
        if not scope_sad_ids:
            return None

        sad_nodes: dict[str, dict[str, Any]] = {}
        for sid in sad_ids:
            row = self._sad_row(sid)
            if row is not None:
                item = self._sad_item_from_row(row)
                sad_nodes[item["id"].upper()] = item

        backlog = self.searcher.backlog
        sad_col = backlog["SADSectionID"].astype(str).str.strip().str.upper()
        type_col = backlog["Type"].astype(str).str.strip().str.lower()

        epic_nodes: dict[str, dict[str, Any]] = {}
        for _, row in backlog.loc[sad_col.isin(scope_sad_ids) & (type_col == "epic")].iterrows():
            item = self._item_from_row(row)
            epic_nodes[item["id"].upper()] = item

        issue_nodes: dict[str, dict[str, Any]] = {}
        parent_col = backlog["ParentID"].astype(str).str.strip().str.upper()
        under_epic = parent_col.isin(set(epic_nodes.keys()))
        orphaned_in_scope = sad_col.isin(scope_sad_ids) & (type_col != "epic")
        for _, row in backlog.loc[under_epic | orphaned_in_scope].iterrows():
            if self._clean(row.get("Type")).lower() == "epic":
                continue
            item = self._item_from_row(row)
            issue_nodes[item["id"].upper()] = item

        # Fold in a Story drafted this turn, even though it isn't in the
        # workbook yet, as long as it belongs to a matched Epic/SAD.
        if story:
            parent_id = str(story.get("parent_id", "")).strip()
            story_sad = str(story.get("sad_section_id", "")).strip()
            if parent_id.upper() in epic_nodes or story_sad.upper() in scope_sad_ids:
                new_id = str(story.get("id", "")).strip() or "NEW-STORY"
                issue_nodes[new_id.upper()] = {
                    "id": new_id,
                    "type": story.get("type", "Story"),
                    "title": story.get("title", ""),
                    "parent_id": parent_id,
                    "sad_section_id": story_sad,
                    "layer": story.get("layer", ""),
                    "story_points": story.get("story_points"),
                    "priority": story.get("priority", ""),
                    "status": story.get("status", "Draft"),
                    "sprint_id": story.get("sprint_id", ""),
                    "assignee_id": story.get("assignee_id", ""),
                    "labels": story.get("labels", ""),
                    "matched": False,
                }

        hierarchy_edges: list[dict[str, Any]] = []
        seen_edges: set[str] = set()

        def add_edge(source: str, target: str) -> None:
            if not source or not target:
                return
            edge_id = f"hierarchy-{source}-{target}"
            if edge_id in seen_edges:
                return
            seen_edges.add(edge_id)
            hierarchy_edges.append({
                "id": edge_id,
                "source": source,
                "target": target,
                "kind": "hierarchy",
                "relation": "contains",
            })

        for epic in epic_nodes.values():
            if str(epic.get("sad_section_id", "")).upper() in scope_sad_ids:
                add_edge(epic["sad_section_id"], epic["id"])

        for issue in issue_nodes.values():
            parent_id = str(issue.get("parent_id", "")).strip()
            if parent_id.upper() in epic_nodes:
                add_edge(epic_nodes[parent_id.upper()]["id"], issue["id"])
            elif str(issue.get("sad_section_id", "")).upper() in scope_sad_ids:
                add_edge(issue["sad_section_id"], issue["id"])

        in_scope_ids = set(epic_nodes.keys()) | set(issue_nodes.keys())
        real_ids = [n["id"] for n in list(epic_nodes.values()) + list(issue_nodes.values()) if n["id"].upper() in in_scope_ids]
        dependency_impacts = self._dependency_impacts(real_ids)
        dependency_edges: list[dict[str, Any]] = []
        seen_dep: set[tuple[str, str, str]] = set()
        for impact in dependency_impacts:
            if impact["ticket_id"].upper() not in in_scope_ids or impact["depends_on"].upper() not in in_scope_ids:
                # Cross-SAD dependency: drop it rather than pulling an
                # unrelated ticket back onto the filtered canvas.
                continue
            key = (impact["ticket_id"], impact["depends_on"], impact.get("dependency_id", ""))
            if key in seen_dep:
                continue
            seen_dep.add(key)
            dependency_edges.append({
                "id": impact.get("dependency_id") or f"dependency-{impact['ticket_id']}-{impact['depends_on']}",
                "source": impact["ticket_id"],
                "target": impact["depends_on"],
                "kind": "dependency",
                "dependency_type": impact.get("dependency_type", ""),
            })

        return {
            "sad_sections": list(sad_nodes.values()),
            "epics": list(epic_nodes.values()),
            "issues": list(issue_nodes.values()),
            "hierarchy_edges": hierarchy_edges,
            "dependencies": dependency_edges,
        }

    def build_evidence(self, intake_text: str) -> dict[str, Any]:
        text = self.clean_text(intake_text)
        if not text:
            raise ValueError("Intake text cannot be empty.")

        results = self.retrieve(text)
        ticket_ids = self._ticket_ids(results)
        architecture = self._architecture_areas(results)
        dependencies = self._dependency_impacts(ticket_ids)
        cycles = self._cycles(ticket_ids)
        canvas_graph = self.build_canvas_graph(ticket_ids, dependencies)

        return {
            "intake": {"raw_text": intake_text, "cleaned_text": text},
            "retrieval": results,
            "architecture_areas": architecture,
            "related_tickets": self._related_tickets(ticket_ids),
            "overlap_candidates": self._overlap_candidates(results),
            "dependency_impacts": dependencies,
            "dependency_cycles": cycles,
            "canvas_graph": canvas_graph,
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

    @staticmethod
    def _wants_ticket_creation(user_texts: list[str]) -> bool:
        """True only if the user has explicitly asked to create/add/raise a
        new ticket/story/issue/feature/task, anywhere in the conversation so
        far (so a later reply like "under EPIC-04" still counts once the
        user has asked once). Everything else is treated as an information
        request — no Story is drafted and no placement questions are asked.
        """
        words = _WORD_RE.findall(" ".join(user_texts).lower())
        verb_positions = [i for i, w in enumerate(words) if w in _CREATE_VERBS]
        if not verb_positions:
            return False
        noun_positions = [i for i, w in enumerate(words) if w in _TICKET_NOUNS]
        return any(abs(v - n) <= 4 for v in verb_positions for n in noun_positions)

    def _info_summary(self, evidence: dict[str, Any]) -> str:
        """Deterministic, LLM-free summary of what the evidence found — used
        as the fallback message when the user hasn't asked to create
        anything (and as the message when the LLM is disabled)."""
        context = self._candidate_context(evidence)
        sad_sections = context.get("sad_sections", [])
        epics = [x for x in context.get("backlog_candidates", []) if str(x.get("type", "")).lower() == "epic"]
        related = evidence.get("related_tickets", [])

        if not sad_sections and not epics and not related:
            return "I couldn't find anything in the workbook related to that. Try rephrasing, or ask me to create a ticket if you'd like to add new work."

        parts = []
        if sad_sections:
            desc = "; ".join(f"{s['id']} ({s.get('section_title') or s.get('title') or 'untitled'})" for s in sad_sections)
            parts.append(f"Architecture area(s): {desc}.")
        if epics:
            desc = ", ".join(f"{e['id']} – {e.get('title', '')}" for e in epics)
            parts.append(f"Existing Epic(s): {desc}.")
        if related:
            desc = ", ".join(f"{t['ticket_id']} – {t.get('title', '')} [{t.get('status', '')}]" for t in related)
            parts.append(f"Related ticket(s): {desc}.")
        parts.append("Let me know if you'd like me to create a new ticket for this.")
        return " ".join(parts)

    def _candidate_context(self, evidence: dict[str, Any]) -> dict[str, Any]:
        """Build a compact, workbook-backed context for conversational Story creation."""
        sad_ids = [a["sad_section_id"] for a in evidence.get("architecture_areas", []) if a.get("sad_section_id")]
        candidate_rows = []
        seen = set()

        # Include directly retrieved tickets first, then all Epics in matched SAD
        # sections. The workbook is the source of truth for hierarchy.
        direct_ids = [t.get("ticket_id") for t in evidence.get("related_tickets", [])]
        for ticket_id in direct_ids:
            row = self._backlog_row(ticket_id)
            if row is not None:
                item = self._item_from_row(row)
                key = item["id"].upper()
                if key not in seen:
                    seen.add(key)
                    candidate_rows.append(item)

        if sad_ids:
            sad_mask = self.searcher.backlog["SADSectionID"].astype(str).str.strip().str.upper().isin(
                {str(x).upper() for x in sad_ids}
            )
            for _, row in self.searcher.backlog.loc[sad_mask].iterrows():
                if self._clean(row.get("Type")).lower() != "epic":
                    continue
                item = self._item_from_row(row)
                key = item["id"].upper()
                if key not in seen:
                    seen.add(key)
                    candidate_rows.append(item)

        sad_sections = []
        for a in evidence.get("architecture_areas", []):
            row = self._sad_row(a.get("sad_section_id"))
            if row is not None:
                sad_sections.append(self._sad_item_from_row(row))

        return {
            "sad_sections": sad_sections,
            "backlog_candidates": candidate_rows,
            "related_tickets": evidence.get("related_tickets", []),
        }

    def _llm_conversation(self, history: list[dict[str, str]], evidence: dict[str, Any], creation_intent: bool) -> dict[str, Any] | None:
        if not self.llm.enabled:
            return None

        context = self._candidate_context(evidence)
        system = """You are Foreman's conversational intake assistant for a software delivery canvas.
Use ONLY the supplied conversation and workbook-backed evidence. Never invent an Epic or S-AD.

The application has already determined whether the user is asking to create a
new ticket, in a field called "creation_intent" in the payload. Follow it
exactly — do not override it based on your own reading of the wording.

If creation_intent is false, you are in INFO mode: the user only wants
information about existing work. Return status "info", write a helpful
"message" summarizing the related SAD section(s), Epic(s), and ticket(s)
found in "evidence", set "questions" to an empty list, and do NOT include a
"story" field at all.

If creation_intent is true, you are in CREATE mode: understand the user's
request, ask only necessary clarification questions, and then draft ONE new
Story for the canvas.

Return JSON only with this shape:
{
  "status": "info" | "clarification_needed" | "story_ready",
  "message": "short natural-language response",
  "questions": ["question", ...],
  "story": {
    "title": "...",
    "description": "...",
    "acceptance_criteria": ["..."],
    "story_points": 1,
    "priority": "...",
    "parent_id": "existing EPIC id",
    "sad_section_id": "existing SAD section id",
    "layer": "..."
  }
}
("story" is omitted entirely in INFO mode.)

CREATE mode rules (only apply when creation_intent is true):
- Ask a question when a missing detail would materially change the Story, its scope, or its placement.
- Do not ask about information that can be safely inferred from the user's request and evidence.
- When the available context is sufficient, return story_ready.
- For story_ready, parent_id MUST be one of the supplied Epic candidate IDs and sad_section_id MUST be a supplied SAD section ID.
- Keep acceptance criteria concrete and testable. Do not invent IDs, names, integrations, dates, or requirements.
- If no suitable Epic can be grounded in evidence, ask the user to clarify which existing Epic the Story belongs under.
- Never create a Jira ticket; this is only a canvas Story draft.
"""
        payload = {
            "creation_intent": creation_intent,
            "conversation": history,
            "evidence": context,
            "retrieval": evidence.get("retrieval", []),
        }
        user = "Process the following conversational intake:\n" + json.dumps(payload, ensure_ascii=False, indent=2)
        return self.llm.generate_json(system, user, max_tokens=2600)

    def process_conversation(self, history: list[dict[str, str]], latest_text: str) -> dict[str, Any]:
        latest = self.clean_text(latest_text)
        if not latest:
            raise ValueError("Intake text cannot be empty.")
        if not isinstance(history, list):
            raise ValueError("Conversation history must be a list.")

        normalized_history = []
        for item in history[-20:]:
            if not isinstance(item, dict):
                continue
            role = str(item.get("role", "")).strip().lower()
            content = self.clean_text(item.get("content", ""))
            if role in {"user", "assistant"} and content:
                normalized_history.append({"role": role, "content": content})
        normalized_history.append({"role": "user", "content": latest})

        creation_intent = self._wants_ticket_creation(
            [item["content"] for item in normalized_history if item["role"] == "user"]
        )

        evidence = self.build_evidence(" ".join(x["content"] for x in normalized_history if x["role"] == "user"))
        assessment = self._llm_conversation(normalized_history, evidence, creation_intent)

        if assessment is None:
            if not creation_intent:
                # No LLM configured, and the user hasn't asked to create
                # anything: just report what the workbook has, don't draft
                # a Story or ask placement questions.
                assessment = {
                    "status": "info",
                    "message": self._info_summary(evidence),
                    "questions": [],
                }
            else:
                # Safe fallback when no LLM is configured. We only auto-place
                # a Story when exactly one grounded Epic is available.
                candidates = self._candidate_context(evidence)["backlog_candidates"]
                epics = [x for x in candidates if str(x.get("type", "")).lower() == "epic"]
                if len(epics) != 1:
                    assessment = {
                        "status": "clarification_needed",
                        "message": "I found multiple or no existing Epics for this request. Which existing Epic should this new Story belong under?",
                        "questions": ["Which existing Epic should this Story be added under?"],
                    }
                else:
                    epic = epics[0]
                    sad_id = epic.get("sad_section_id", "")
                    words = latest.split()
                    title = latest[:90].rstrip(" .")
                    if words and len(words) > 12:
                        title = " ".join(words[:12]).rstrip(" .")
                    assessment = {
                        "status": "story_ready",
                        "message": "I have enough context and drafted a new Story for the canvas.",
                        "questions": [],
                        "story": {
                            "title": title,
                            "description": latest,
                            "acceptance_criteria": [],
                            "story_points": None,
                            "priority": "",
                            "parent_id": epic["id"],
                            "sad_section_id": sad_id,
                            "layer": epic.get("layer", ""),
                        },
                    }

        if not creation_intent:
            # Deterministic guard: never let a Story be created unless the
            # user explicitly asked for one, regardless of what the LLM
            # returned (in case it ignored the creation_intent instruction).
            assessment["status"] = "info"
            assessment.pop("story", None)
            if not str(assessment.get("message", "")).strip():
                assessment["message"] = self._info_summary(evidence)
        else:
            status = str(assessment.get("status", "clarification_needed")).lower()
            if status == "story_ready":
                story = assessment.get("story") or {}
                candidate_context = self._candidate_context(evidence)
                epic_ids = {x["id"].upper() for x in candidate_context["backlog_candidates"] if str(x.get("type", "")).lower() == "epic"}
                sad_ids = {x["id"].upper() for x in candidate_context["sad_sections"]}
                parent_id = str(story.get("parent_id", "")).strip()
                sad_id = str(story.get("sad_section_id", "")).strip()
                if not parent_id or parent_id.upper() not in epic_ids or not sad_id or sad_id.upper() not in sad_ids:
                    assessment["status"] = "clarification_needed"
                    assessment["questions"] = ["Which existing Epic should this Story belong under?"]
                    assessment["message"] = "I have the Story details, but I need the existing Epic confirmed before I add it to the canvas."
                    assessment.pop("story", None)
                else:
                    story["id"] = f"NEW-STORY-{uuid.uuid4().hex[:8].upper()}"
                    story["type"] = "Story"
                    story["matched"] = False
                    assessment["story"] = story

        story = assessment.get("story")
        matched_sad_ids = self._matched_sad_ids(evidence, story)
        canvas_focus = self.build_scoped_canvas(matched_sad_ids, story) if matched_sad_ids else None

        return {
            "status": assessment.get("status", "info"),
            "message": assessment.get("message", ""),
            "questions": assessment.get("questions", []),
            "story": story,
            "creation_intent": creation_intent,
            "evidence": {
                "architecture_areas": evidence.get("architecture_areas", []),
                "related_tickets": evidence.get("related_tickets", []),
                "retrieval": evidence.get("retrieval", []),
            },
            # None => nothing specific was grounded this turn (a generic
            # question); the frontend should keep showing the default full
            # canvas. Otherwise this is a subgraph in the same shape as the
            # /canvas endpoint, scoped to the matched SAD(s) only.
            "canvas_focus": canvas_focus,
            "conversation": normalized_history + ([{"role": "assistant", "content": assessment.get("message", "")}] if assessment.get("message") else []),
        }

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
