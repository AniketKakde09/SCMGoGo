"""Read-only semantic screening against the complete original backlog and local drafts.

Candidates are flags, not proof of equivalence. This module never creates tickets,
changes sprints, or writes to Jira.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/planning/stories", tags=["Story intelligence"])
SUPPORTED_TYPES = {"epic", "feature", "story", "task", "bug"}


def normalized(value: Any) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", str(value or "").lower()))


class Draft(BaseModel):
    id: str = ""
    title: str = Field(min_length=3, max_length=500)
    description: str = Field(default="", max_length=12000)
    acceptance_criteria: str = Field(default="", max_length=12000)
    type: str = "Story"
    parent_id: str = ""
    sprint: str = ""


class ReviewRequest(BaseModel):
    story: Draft  # Legacy request field retained for existing frontend compatibility.
    local_drafts: list[Draft] = Field(default_factory=list, max_length=5000)


class BatchReviewRequest(BaseModel):
    tickets: list[Draft] = Field(min_length=1, max_length=1000)
    local_drafts: list[Draft] = Field(default_factory=list, max_length=5000)


def _read(path: Path, sheet: str) -> pd.DataFrame:
    return pd.read_excel(path, sheet_name=sheet).fillna("")


def _original_candidates(path: Path) -> list[dict[str, str]]:
    if not path.is_file():
        raise ValueError("Dataset workbook is unavailable")
    backlog = _read(path, "Backlog")
    required = {"TicketID", "Title", "Type", "ParentID"}
    if not required.issubset(backlog.columns):
        raise ValueError("Backlog lacks required columns: " + ", ".join(sorted(required - set(backlog.columns))))
    return [{"id": str(row["TicketID"]).strip(), "title": str(row["Title"]).strip(),
             "type": str(row["Type"]).strip(), "parent_id": str(row["ParentID"]).strip(),
             "description": str(row.get("Description", "")).strip(),
             "acceptance_criteria": str(row.get("AcceptanceCriteria", "")).strip(),
             "source": "original backlog"} for _, row in backlog.iterrows()
            if normalized(row["Type"]) in SUPPORTED_TYPES and normalized(row["Title"])]


def _draft_candidate(draft: Draft, source: str) -> dict[str, str]:
    return {"id": draft.id, "title": draft.title, "type": draft.type,
            "parent_id": draft.parent_id, "description": draft.description,
            "acceptance_criteria": draft.acceptance_criteria, "source": source}


def _review(ticket: Draft, originals: list[dict[str, str]], local: list[dict[str, str]],
            model: Any) -> dict[str, Any]:
    ticket_type = normalized(ticket.type)
    if ticket_type not in SUPPORTED_TYPES:
        raise ValueError(f"Unsupported ticket type: {ticket.type}")
    # Compare like-for-like: an Epic and Story with the same title are not duplicates.
    candidates = [c for c in originals + local if normalized(c["type"]) == ticket_type
                  and not (c["source"] != "original backlog" and ticket.id and c["id"] == ticket.id)]
    if not candidates:
        return {"decision": "new", "matches": [], "suggested_parent_id": "", "suggested_sprint": "",
                "placement_reason": "No comparable work found; placement requires review and a capacity-aware sprint preview.",
                "checked_original_count": len(originals), "checked_local_count": len(local)}
    # Embeddings retrieve paraphrases; title equality is the only automatic block.
    texts = [ticket.title] + [c["title"] for c in candidates]
    vectors = np.asarray(model.encode(texts, normalize_embeddings=True))
    if vectors.ndim != 2 or len(vectors) != len(texts):
        raise ValueError("Embedding model returned invalid vectors")
    scores = vectors[1:] @ vectors[0]
    ranked = sorted(zip(candidates, scores), key=lambda pair: float(pair[1]), reverse=True)
    matches = []
    for candidate, score in ranked:
        left, right = set(normalized(ticket.title).split()), set(normalized(candidate["title"]).split())
        overlap = len(left & right) / max(1, len(left | right))
        exact = normalized(ticket.title) == normalized(candidate["title"])
        if exact or float(score) >= 0.68 or overlap >= 0.6:
            matches.append({**candidate, "semantic_similarity": round(float(score), 3),
                            "decision": "equivalent" if exact else "needs_review",
                            "reason": "Identical normalized title and issue type" if exact else
                            "Potential semantic overlap; compare scope and acceptance criteria before deciding"})
        if len(matches) >= 8:
            break
    decision = ("equivalent" if any(m["decision"] == "equivalent" for m in matches)
                else "needs_review" if matches else "new")
    # Only propose an existing parent of the correct hierarchy level.
    required_parent_type = {"feature": "epic", "story": "feature", "task": "feature", "bug": "feature"}.get(ticket_type)
    all_items = {c["id"]: c for c in originals + local if c["id"]}
    parent = ""
    if required_parent_type:
        for candidate, _ in ranked:
            parent_id = candidate["parent_id"]
            if parent_id in all_items and normalized(all_items[parent_id]["type"]) == required_parent_type:
                parent = parent_id
                break
    return {"decision": decision, "matches": matches, "suggested_parent_id": parent,
            "suggested_sprint": "", "placement_reason":
            "Related-work parent suggestion only. Sprint requires dependency, holiday, capacity and committed-sprint validation.",
            "checked_original_count": len(originals), "checked_local_count": len(local)}


def review_story(path: Path, req: ReviewRequest, model=None) -> dict[str, Any]:
    originals = _original_candidates(path)
    local = [_draft_candidate(d, "approved local draft") for d in req.local_drafts
             if normalized(d.type) in SUPPORTED_TYPES]
    if model is None:
        from search import get_embedding_model
        model = get_embedding_model()
    return _review(req.story, originals, local, model)


def review_batch(path: Path, req: BatchReviewRequest, model=None) -> dict[str, Any]:
    originals = _original_candidates(path)
    local = [_draft_candidate(d, "approved local draft") for d in req.local_drafts
             if normalized(d.type) in SUPPORTED_TYPES]
    if model is None:
        from search import get_embedding_model
        model = get_embedding_model()
    results = []
    # Imported tickets are compared to each other as well as the ORIGINAL dataset.
    # Only earlier imports enter the candidate pool to avoid symmetric false blocks.
    seen = list(local)
    for ticket in req.tickets:
        result = _review(ticket, originals, seen, model)
        results.append({"id": ticket.id, "type": ticket.type, "title": ticket.title, **result})
        seen.append(_draft_candidate(ticket, "same import"))
    return {"results": results, "total": len(results),
            "flagged": sum(r["decision"] != "new" for r in results),
            "checked_original_count": len(originals)}


def _dataset_path(dataset_id: str) -> Path:
    from backend.main import manager
    meta = manager.read_metadata(dataset_id)
    if meta.get("status") != "ready":
        raise HTTPException(status_code=409, detail="Dataset is not ready")
    return manager.paths(dataset_id)["excel"]


@router.post("/datasets/{dataset_id}/review")
def review_dataset_story(dataset_id: str, req: ReviewRequest):
    try:
        return review_story(_dataset_path(dataset_id), req)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/datasets/{dataset_id}/review-batch")
def review_dataset_batch(dataset_id: str, req: BatchReviewRequest):
    try:
        return review_batch(_dataset_path(dataset_id), req)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
