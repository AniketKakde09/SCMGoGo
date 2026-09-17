"""Read-only, full-workbook Story screening. Never writes to the dataset or Jira."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/planning/stories", tags=["Story intelligence"])


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
    story: Draft
    local_drafts: list[Draft] = Field(default_factory=list, max_length=5000)


def _read(path: Path, sheet: str) -> pd.DataFrame:
    return pd.read_excel(path, sheet_name=sheet).fillna("")


def review_story(path: Path, req: ReviewRequest, model=None) -> dict[str, Any]:
    if not path.is_file():
        raise ValueError("Dataset workbook is unavailable")
    backlog = _read(path, "Backlog")
    required = {"TicketID", "Title", "Type", "ParentID"}
    if not required.issubset(backlog.columns):
        raise ValueError("Backlog lacks required columns: " + ", ".join(sorted(required - set(backlog.columns))))
    candidates = []
    for _, row in backlog.iterrows():
        candidates.append({"id": str(row["TicketID"]).strip(), "title": str(row["Title"]).strip(),
                           "parent_id": str(row["ParentID"]).strip(), "source": "original backlog"})
    for draft in req.local_drafts:
        if draft.id == req.story.id or normalized(draft.type) == "note":
            continue
        candidates.append({"id": draft.id, "title": draft.title, "parent_id": draft.parent_id,
                           "source": "approved local draft"})
    if not candidates:
        return {"decision": "new", "matches": [], "suggested_parent_id": "", "suggested_sprint": "",
                "placement_reason": "No comparable work or grounded placement found; choose a parent and sprint manually."}
    titles = [c["title"] for c in candidates]
    query = req.story.title
    # Semantic model uses the same sentence-transformer already used by ForemanSearch.
    if model is None:
        from search import get_embedding_model
        model = get_embedding_model()
    vectors = np.asarray(model.encode([query] + titles, normalize_embeddings=True))
    scores = vectors[1:] @ vectors[0]
    ranked = sorted(zip(candidates, scores), key=lambda x: float(x[1]), reverse=True)
    matches = []
    for candidate, score in ranked[:8]:
        left, right = set(normalized(query).split()), set(normalized(candidate["title"]).split())
        overlap = len(left & right) / max(1, len(left | right))
        exact = normalized(query) == normalized(candidate["title"])
        # Semantic similarity identifies candidates; only identical normalized titles are
        # automatically equivalent. Paraphrases remain review-required, never auto-created.
        if exact or float(score) >= 0.68 or overlap >= 0.6:
            matches.append({**candidate, "semantic_similarity": round(float(score), 3),
                            "decision": "equivalent" if exact else "needs_review",
                            "reason": "Identical normalized title" if exact else "Similar meaning or scope; compare acceptance criteria before deciding"})
    decision = "equivalent" if any(m["decision"] == "equivalent" for m in matches) else "needs_review" if matches else "new"
    # Existing hierarchy is a suggestion, not an automatic parent mutation.
    parent = next((c["parent_id"] for c, _ in ranked if c["parent_id"]), "")
    parent_ids = set(backlog["TicketID"].astype(str).str.strip()) | {d.id for d in req.local_drafts}
    if parent not in parent_ids:
        parent = ""
    if parent:
        parent_rows = backlog[backlog["TicketID"].astype(str).str.strip() == parent]
        parent_type = str(parent_rows.iloc[0]["Type"]).strip().lower() if not parent_rows.empty else next((d.type.lower() for d in req.local_drafts if d.id == parent), "")
        if parent_type != "feature":
            parent = ""
    # Do not claim a feasible sprint without dependency/capacity verification.
    return {"decision": decision, "matches": matches, "suggested_parent_id": parent,
            "suggested_sprint": "", "placement_reason": "Parent inferred from related work; sprint remains unscheduled until the dependency-aware planner confirms capacity, holidays and committed-sprint constraints.",
            "checked_original_count": len(backlog), "checked_local_count": len(req.local_drafts)}


@router.post("/datasets/{dataset_id}/review")
def review_dataset_story(dataset_id: str, req: ReviewRequest):
    from backend.main import manager
    meta = manager.read_metadata(dataset_id)
    if meta.get("status") != "ready":
        raise HTTPException(status_code=409, detail="Dataset is not ready")
    try:
        return review_story(manager.paths(dataset_id)["excel"], req)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
