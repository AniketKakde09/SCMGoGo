"""Match newly-proposed Epics and SAD sections against what already exists.

Problem this solves: the LLM backlog pipeline (agents/backlog_agent.py) used
to always invent a brand-new Epic — and never checked whether the dataset
already loaded in Foreman (backend/foreman) has an Epic, or a SAD section,
that the new work really belongs under. That produced duplicate epics and
epics with no architecture traceability.

This module is intentionally dependency-free (no embeddings/ML libs) so it
works offline and needs no extra install. It combines:
  - Jaccard similarity over normalized keyword sets (catches paraphrases
    that share vocabulary, e.g. "Checkout flow" vs "Checkout Improvements")
  - difflib.SequenceMatcher ratio (catches near-identical titles/typos)

Confidence tiers:
  - HIGH   (>= HIGH_THRESHOLD)   -> safe to auto-reuse the existing item.
  - MEDIUM (>= MEDIUM_THRESHOLD) -> plausible, but a human should confirm
                                    before merging (see agents/backlog_agent.py,
                                    which turns this into a decision rather
                                    than silently guessing).
  - NONE   (below MEDIUM_THRESHOLD) -> no good match; create new.
"""

from __future__ import annotations

import difflib
import re
from dataclasses import dataclass, field
from typing import Any, Optional

HIGH_THRESHOLD = 0.55
MEDIUM_THRESHOLD = 0.30

_STOPWORDS = {
    "a", "an", "the", "and", "or", "for", "to", "of", "in", "on", "with",
    "is", "are", "be", "as", "by", "at", "this", "that", "it", "will",
    "should", "must", "can", "we", "our", "epic", "story", "feature",
    "system", "add", "new", "support", "update", "improve", "improvement",
}


def _tokens(text: str) -> set[str]:
    words = re.findall(r"[a-z0-9]+", (text or "").lower())
    return {w for w in words if len(w) > 2 and w not in _STOPWORDS}


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    intersection = len(a & b)
    union = len(a | b)
    return intersection / union if union else 0.0


def _score(candidate_text: str, existing_text: str) -> float:
    candidate_tokens = _tokens(candidate_text)
    existing_tokens = _tokens(existing_text)

    jaccard = _jaccard(candidate_tokens, existing_tokens)
    ratio = difflib.SequenceMatcher(
        None, (candidate_text or "").lower(), (existing_text or "").lower()
    ).ratio()

    return (0.6 * jaccard) + (0.4 * ratio)


@dataclass
class MatchResult:
    confidence: str  # "high" | "medium" | "none"
    score: float
    matched_id: Optional[str] = None
    matched_title: Optional[str] = None
    candidates: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "confidence": self.confidence,
            "score": round(self.score, 3),
            "matched_id": self.matched_id,
            "matched_title": self.matched_title,
            "candidates": self.candidates,
        }


def _confidence_for(score: float) -> str:
    if score >= HIGH_THRESHOLD:
        return "high"
    if score >= MEDIUM_THRESHOLD:
        return "medium"
    return "none"


def find_best_epic_match(
    candidate_title: str,
    candidate_description: str,
    existing_epics: list[dict[str, Any]],
    top_n: int = 3,
) -> MatchResult:
    """existing_epics: list of {"id": ..., "title": ..., "description": ...}"""

    candidate_text = f"{candidate_title} {candidate_description}"
    scored = []

    for epic in existing_epics:
        existing_text = f"{epic.get('title', '')} {epic.get('description', '')}"
        score = _score(candidate_text, existing_text)
        scored.append(
            {
                "id": epic.get("id"),
                "title": epic.get("title"),
                "score": round(score, 3),
            }
        )

    scored.sort(key=lambda x: x["score"], reverse=True)
    top = scored[:top_n]

    if not top or top[0]["score"] < MEDIUM_THRESHOLD:
        return MatchResult(confidence="none", score=top[0]["score"] if top else 0.0, candidates=top)

    best = top[0]
    return MatchResult(
        confidence=_confidence_for(best["score"]),
        score=best["score"],
        matched_id=best["id"],
        matched_title=best["title"],
        candidates=top,
    )


def find_best_sad_match(
    candidate_title: str,
    candidate_description: str,
    existing_sections: list[dict[str, Any]],
    top_n: int = 3,
) -> MatchResult:
    """existing_sections: list of {"id", "title", "summary", "layer"}.

    Weighs the architecture layer as a soft signal: an exact layer match
    gives a small boost, since two sections about very different layers
    (e.g. "Frontend" vs "Data") are unlikely to be the right home even if
    the wording overlaps.
    """

    candidate_text = f"{candidate_title} {candidate_description}"
    scored = []

    for section in existing_sections:
        existing_text = f"{section.get('title', '')} {section.get('summary', '')}"
        score = _score(candidate_text, existing_text)
        scored.append(
            {
                "id": section.get("id"),
                "title": section.get("title"),
                "layer": section.get("layer"),
                "score": round(score, 3),
            }
        )

    scored.sort(key=lambda x: x["score"], reverse=True)
    top = scored[:top_n]

    if not top or top[0]["score"] < MEDIUM_THRESHOLD:
        return MatchResult(confidence="none", score=top[0]["score"] if top else 0.0, candidates=top)

    best = top[0]
    return MatchResult(
        confidence=_confidence_for(best["score"]),
        score=best["score"],
        matched_id=best["id"],
        matched_title=best["title"],
        candidates=top,
    )
