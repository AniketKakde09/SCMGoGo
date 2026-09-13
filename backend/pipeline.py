"""Stage-based orchestration for the AI Scrum Master."""

import re

from agents.backlog_agent import run as run_backlog
from agents.clarification_agent import run as run_clarification
from agents.definition_of_done_agent import run as run_definition_of_done
from agents.general_response_agent import run as run_general_response
from agents.input_agent import run as run_input
from agents.jira_agent import build_jira_payload
from agents.requirement_agent import run as run_requirement
# =========================================================
# AI STAGES
# =========================================================

AI_STAGES = [
    {
        "name": "input",
        "runner": run_input,
    },
    {
        "name": "requirement",
        "runner": run_requirement,
    },
    {
        "name": "backlog",
        "runner": run_backlog,
    },
]


def input_includes_definition_of_done(text: str) -> bool:
    """Avoid replacing DoD criteria explicitly supplied by the user."""
    return bool(re.search(r"\bdefinition\s+of\s+done\b|\bDoD\b|\bdod\b", text or "", re.IGNORECASE))


# =========================================================
# SCRUM PIPELINE
# =========================================================

def run_scrum_pipeline(
    state: dict,
    start_at: str = "input",
) -> dict:
    """
    Run the AI stages sequentially and automatically
    generate the Jira payload after backlog generation.
    """

    # -----------------------------------------------------
    # FIND START STAGE
    # -----------------------------------------------------

    start_index = next(
        (
            index
            for index, stage in enumerate(AI_STAGES)
            if stage["name"] == start_at
        ),
        None,
    )

    if start_index is None:

        raise ValueError(
            f"Unknown pipeline stage: {start_at}"
        )

    # -----------------------------------------------------
    # RUN AI STAGES
    # -----------------------------------------------------

    for stage in AI_STAGES[start_index:]:

        stage_name = stage["name"]

        print(
            f"\n========== RUNNING STAGE: {stage_name} =========="
        )

        state["current_stage"] = stage_name

        state = stage["runner"](state)

        # -------------------------------------------------
        # DEBUG
        # -------------------------------------------------

        if stage_name == "backlog":

            epics = state.get(
                "epics",
                []
            )

            print(
                f"EPICS GENERATED: {len(epics)}"
            )

        # -------------------------------------------------
        # ERROR CHECK
        # -------------------------------------------------

        if state.get("error"):

            print(
                f"ERROR IN STAGE {stage_name}: "
                f"{state['error']}"
            )

            state["current_stage"] = "end"

            return state

    # -----------------------------------------------------
    # VERIFY BACKLOG
    # -----------------------------------------------------

    epics = state.get(
        "epics",
        []
    )

    print(
        "\n========== BEFORE JIRA PAYLOAD =========="
    )

    print(
        f"Number of epics: {len(epics)}"
    )

    # -----------------------------------------------------
    # GENERATE JIRA PAYLOAD
    # -----------------------------------------------------

    state["current_stage"] = "jira"

    state = build_jira_payload(
        state
    )

    # -----------------------------------------------------
    # ERROR CHECK
    # -----------------------------------------------------

    if state.get("error"):

        print(
            "JIRA PAYLOAD ERROR:",
            state["error"]
        )

        state["current_stage"] = "end"

        return state

    # -----------------------------------------------------
    # WORKFLOW COMPLETE
    # -----------------------------------------------------

    state["approved"] = True
    state["pending_action"] = ""

    state["current_stage"] = "end"

    state["response"] = {
        "message": (
            "Jira payload generated successfully."
        )
    }

    return state


# =========================================================
# RESET WORKFLOW
# =========================================================

def reset_workflow(state: dict) -> None:
    """
    Reset request-specific workflow fields while
    preserving the session ID.
    """

    session_id = state.get(
        "session_id",
        ""
    )

    state.clear()

    state.update({

        "session_id": session_id,

        "raw_input": "",
        "parsed_text": "",
        "source_type": "text",

        "intent": "",
        "current_stage": None,

        "goal": "",
        "scope": "",

        "requirements": [],
        "non_functional_requirements": [],
        "constraints": [],
        "dependencies": [],
        "personas": [],
        "assumptions": [],

        "epics": [],

        "jira_payload": [],

        "approved": False,
        "clarifications_enabled": False,
        "clarification_questions": [],
        "definition_of_done": [],
        "has_definition_of_done": False,

        "response": "",
        "pending_action": "",

        "error": "",
    })


# =========================================================
# PROCESS USER INPUT
# =========================================================

def process_user_input(
    state: dict,
) -> dict:
    """
    Process a user request.

    For Scrum requests:
        input
        -> requirements
        -> backlog
        -> Jira payload

    Jira payload generation is automatic.
    """

    current_stage = state.get(
        "current_stage"
    )

    # -----------------------------------------------------
    # NEW REQUEST AFTER COMPLETED WORKFLOW
    # -----------------------------------------------------

    if current_stage == "end":

        reset_workflow(
            state
        )

    # -----------------------------------------------------
    # INPUT STAGE
    # -----------------------------------------------------

    state["current_stage"] = "input"

    state = run_input(
        state
    )

    if state.get("error"):

        state["current_stage"] = "end"

        return state

    # -----------------------------------------------------
    # SCRUM WORKFLOW
    # -----------------------------------------------------

    if state.get("intent") == "SCRUM":

        if input_includes_definition_of_done(state.get("parsed_text", "")):
            state["has_definition_of_done"] = True
        else:
            state = run_definition_of_done(state)

        if state.get("clarifications_enabled"):
            state = run_clarification(state)
            questions = state.get("clarification_questions", [])
            if questions:
                state["current_stage"] = "waiting_for_approval"
                state["pending_action"] = "answer_clarifications"
                state["response"] = {"message": "Please answer these questions before I create the PI plan."}
                return state

        return run_scrum_pipeline(
            state,
            start_at="requirement",
        )

    # -----------------------------------------------------
    # GENERAL RESPONSE
    # -----------------------------------------------------

    state = run_general_response(
        state
    )

    if state.get("error"):

        state["current_stage"] = "end"

        return state

    state["current_stage"] = "end"

    return state
