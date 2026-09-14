import json
from uuid import uuid4

from utlis.json_parser import parse_json
from services.llm import call_llm
from services.backlog_context import get_existing_epics, get_existing_sad_sections
from services.epic_matcher import find_best_epic_match, find_best_sad_match
from prompts.backlog_prompt import BACKLOG_AGENT_PROMPT


def _resolve_epic_placement(epic: dict, existing_epics: list[dict], existing_sad: list[dict]) -> dict:
    """Checks a single freshly-generated epic against what already exists
    before treating it as brand new.

    Mutates and returns `epic` with a "placement" block:
      - {"status": "reuse_epic", ...}       -> confidently the same epic;
                                                the caller should attach the
                                                new stories to the existing
                                                epic instead of creating one.
      - {"status": "needs_confirmation", ...} -> plausible match, but not
                                                confident enough to merge
                                                automatically; surfaced as a
                                                decision for a human.
      - {"status": "new", ...}              -> no good match; safe to create,
                                                with a SAD section attached
                                                if one was found.
    """
    title = epic.get("title") or ""
    description = epic.get("description") or ""

    epic_match = find_best_epic_match(title, description, existing_epics)
    sad_match = find_best_sad_match(title, description, existing_sad)

    placement: dict = {
        "epic_match": epic_match.to_dict(),
        "sad_match": sad_match.to_dict(),
    }

    if epic_match.confidence == "high":
        placement["status"] = "reuse_epic"
        placement["reuse_epic_id"] = epic_match.matched_id
        placement["note"] = (
            f"Matches existing epic '{epic_match.matched_title}' "
            f"({epic_match.matched_id}) closely enough to reuse it — "
            "new stories will be attached there instead of a new epic."
        )
    elif epic_match.confidence == "medium":
        placement["status"] = "needs_confirmation"
        placement["note"] = (
            f"This looks similar to existing epic '{epic_match.matched_title}' "
            f"({epic_match.matched_id}), but not similar enough to merge "
            "automatically. A human should confirm reuse vs. creating new."
        )
    else:
        placement["status"] = "new"
        if sad_match.confidence in ("high", "medium"):
            placement["sad_section_id"] = sad_match.matched_id
            placement["note"] = (
                f"No matching epic found; linked to existing SAD section "
                f"'{sad_match.matched_title}' ({sad_match.matched_id})."
            )
        else:
            placement["note"] = (
                "No matching epic or SAD section found — this looks like "
                "genuinely new scope. Flagged for a human to assign or "
                "approve a new SAD section."
            )

    epic["placement"] = placement
    return epic


def respond_to_epic_decision(state: dict, decision_id: str, hint: str | None) -> dict:
    """Handles the one-time optional prompt for a single epic decision.

    This is intentionally NOT a retry loop: it fires once, whether the
    person supplies a hint or explicitly skips. If a hint is given, the
    matcher re-scores that one epic with the hint folded in as extra
    context; if the new score clears the bar, the decision resolves
    automatically. If it still doesn't clear the bar (or the person
    skipped), the decision is left in place for manual review later —
    there is no second attempt.

    Raises KeyError if decision_id or the epic it points to can't be found.
    """

    decisions = state.get("epic_decisions", [])
    decision = next((d for d in decisions if d["decision_id"] == decision_id), None)

    if decision is None:
        raise KeyError(f"No epic decision found with id {decision_id}")

    if decision.get("answered"):
        # Already resolved (or already skipped) — asked-once means we don't
        # re-prompt or re-score a second time.
        return decision

    epics = state.get("epics", [])
    epic_index = decision.get("epic_index")

    if epic_index is None or epic_index >= len(epics):
        raise KeyError(f"Epic for decision {decision_id} is no longer available")

    epic = epics[epic_index]

    decision["asked"] = True
    hint = (hint or "").strip()
    decision["hint"] = hint or None

    if not hint:
        decision["answered"] = True
        decision["resolution"] = "skipped"
        return decision

    augmented_description = f"{epic.get('description', '')} {hint}".strip()

    if decision["kind"] == "epic_match":
        match = find_best_epic_match(
            epic.get("title", ""),
            augmented_description,
            get_existing_epics(),
        )
        epic["placement"]["epic_match"] = match.to_dict()

        if match.confidence == "high":
            epic["placement"]["status"] = "reuse_epic"
            epic["placement"]["reuse_epic_id"] = match.matched_id
            epic["placement"]["note"] = (
                f"Resolved after your input — matches existing epic "
                f"'{match.matched_title}' ({match.matched_id})."
            )
            decision["resolution"] = "reuse_epic"
        else:
            epic["placement"]["note"] = (
                "Still not a confident match after one round of input — "
                "left for manual review."
            )
            decision["resolution"] = "still_unresolved"

    else:  # kind == "sad_match"
        match = find_best_sad_match(
            epic.get("title", ""),
            augmented_description,
            get_existing_sad_sections(),
        )
        epic["placement"]["sad_match"] = match.to_dict()

        if match.confidence in ("high", "medium"):
            epic["placement"]["sad_section_id"] = match.matched_id
            epic["placement"]["note"] = (
                f"Resolved after your input — linked to SAD section "
                f"'{match.matched_title}' ({match.matched_id})."
            )
            decision["resolution"] = "sad_linked"
        else:
            epic["placement"]["note"] = (
                "Still no SAD section match after one round of input — "
                "left for manual review or a new section."
            )
            decision["resolution"] = "still_unresolved"

    decision["answered"] = True
    return decision


def run(state: dict) -> dict:
    print("\n============= Backlog Stage =============")
    
    prompt = f"""
    {BACKLOG_AGENT_PROMPT}
    Goal:

    {state.get('goal', '')}
    Scope:

    {state.get('scope', '')}
    Requirements:

    {state.get('requirements', [])}
    Non Functional Requirements:

    {state.get('non_functional_requirements', [])}
    Constraints:

    {state.get('constraints', [])}
    Dependencies:

    {state.get('dependencies', [])}
    Personas:

    {state.get('personas', [])}
    Assumptions:

    {state.get('assumptions', [])}
    """
    
    try:
        response = call_llm(
            prompt,
            json_mode=True
        )

        try:
            result = parse_json(response)
        except Exception as parse_error:
            print(
                "Initial backlog JSON parsing failed: "
                f"{parse_error}"
            )

            repair_prompt = f"""
            Convert the following model response into valid JSON.
            Rules:

            Return ONLY valid JSON.
            Preserve the backlog content exactly where possible.
            The top-level object must contain an epics array.
            Do not add commentary.
            Do not add Markdown fences.
            Do not add new requirements.
            Do not add new integrations.
            Do not add new technologies.
            Do not add new business rules.
            Model response:
            {response}
            """
            
            repaired_response = call_llm(repair_prompt)
            result = parse_json(repaired_response)

        epics = result.get("epics", [])

        if not isinstance(epics, list):
            epics = []

        # -----------------------------------------------------
        # Check each proposed epic against what already exists
        # (Foreman dataset, if one is loaded) before treating it
        # as new scope. See services/epic_matcher.py.
        # -----------------------------------------------------

        existing_epics = get_existing_epics()
        existing_sad = get_existing_sad_sections()
        epic_decisions = []

        for epic_index, epic in enumerate(epics):
            if epic.get("placeholder"):
                # SIMPLE requirements have no epic-level title/description
                # to match against — nothing to check.
                continue

            _resolve_epic_placement(epic, existing_epics, existing_sad)

            status = epic.get("placement", {}).get("status")
            if status == "needs_confirmation":
                epic_decisions.append(
                    {
                        "decision_id": f"ED-{uuid4().hex[:8]}",
                        "epic_index": epic_index,
                        "kind": "epic_match",
                        "epic_title": epic.get("title"),
                        "question": (
                            f"Does \"{epic.get('title')}\" belong under the "
                            f"existing epic '{epic['placement']['epic_match']['matched_title']}', "
                            "or is it new scope?"
                        ),
                        "options": ["Reuse existing epic", "Create as new epic"],
                        "match": epic["placement"]["epic_match"],
                        # Asked-once semantics: we prompt for optional extra
                        # context a single time (see respond_to_epic_decision
                        # below). "asked" flips true the moment the person
                        # is shown the prompt; "answered" flips true once
                        # they respond (with a hint) or explicitly skip.
                        # There is no retry loop here — this is deliberately
                        # separate from the 4-round missing-data mechanism.
                        "asked": False,
                        "answered": False,
                        "hint": None,
                        "resolution": None,
                    }
                )
            elif status == "new" and not epic.get("placement", {}).get("sad_section_id"):
                epic_decisions.append(
                    {
                        "decision_id": f"ED-{uuid4().hex[:8]}",
                        "epic_index": epic_index,
                        "kind": "sad_match",
                        "epic_title": epic.get("title"),
                        "question": (
                            f"\"{epic.get('title')}\" doesn't match an existing "
                            "SAD section. Assign one, or approve creating a new one?"
                        ),
                        "options": ["Assign existing SAD section", "Create new SAD section"],
                        "match": epic["placement"]["sad_match"],
                        "asked": False,
                        "answered": False,
                        "hint": None,
                        "resolution": None,
                    }
                )

        state["epics"] = epics
        state["epic_decisions"] = epic_decisions

        print("\n========== GENERATED BACKLOG ==========")
        print(json.dumps(state["epics"], indent=4))
        print("=======================================\n")

    except Exception as error:
        print(f"Backlog stage failed: {error}")
        state["epics"] = []
        state["error"] = (
            "I couldn't generate a valid backlog "
            "from that requirement."
        )

    return state