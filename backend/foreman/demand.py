from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any


@dataclass(frozen=True)
class ShapedDemand:
    demand_id: str
    title: str
    goal: str
    candidate_type: str
    suggested_summary: str
    assumptions: list[str]
    clarification_questions: list[str]
    readiness_gaps: list[str]


class DemandShaper:
    """Provider-neutral raw-demand shaper.

    This is intentionally deterministic and auditable. Replace/augment this class
    with an LLM provider or LangGraph node later; keep the returned contract stable
    so the downstream graph/planner never depends on free-form model text.
    """

    QUESTION_PATTERNS = [
        ("acceptance", "What observable acceptance criteria prove this demand is complete?"),
        ("owner", "Who owns the business outcome and who can approve scope?"),
        ("dependency", "What systems, teams, vendors, or architecture components must be ready first?"),
        ("nonfunctional", "What security, performance, availability, audit, or compliance constraints apply?"),
    ]

    def shape(self, raw_content: str, title: str | None = None, demand_id: str = "INTAKE-001") -> dict[str, Any]:
        text = " ".join((raw_content or "").split())
        if not text:
            raise ValueError("raw_content cannot be empty")
        title = title or self._derive_title(text)
        lower = text.lower()

        candidate_type = "Story"
        if any(k in lower for k in ("platform", "capability", "service", "end to end")):
            candidate_type = "Feature"

        gaps: list[str] = []
        questions: list[str] = []
        if len(text) < 80:
            gaps.append("scope")
            questions.append("What is explicitly in scope and out of scope?")
        if not any(k in lower for k in ("when ", "given ", "must ", "shall ", "should ", "acceptance")):
            gaps.append("acceptance criteria")
        if not any(k in lower for k in ("depend", "integrat", "api", "system", "team")):
            gaps.append("dependencies")
        if not any(k in lower for k in ("security", "performance", "availability", "audit", "gdpr", "compliance")):
            gaps.append("non-functional requirements")

        for question in [q for _, q in self.QUESTION_PATTERNS]:
            if question not in questions:
                questions.append(question)

        return ShapedDemand(
            demand_id=demand_id,
            title=title,
            goal=text,
            candidate_type=candidate_type,
            suggested_summary=f"Deliver the capability described by: {text}",
            assumptions=[
                "The request describes the desired outcome, not an implementation design.",
                "Missing details should be clarified before commitment.",
            ],
            clarification_questions=questions[:5],
            readiness_gaps=gaps,
        ).__dict__

    @staticmethod
    def _derive_title(text: str) -> str:
        words = re.findall(r"\b\w+\b", text)
        if not words:
            return "Untitled demand"
        return " ".join(words[:10]).rstrip(".")
