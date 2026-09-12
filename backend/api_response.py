def build_api_response(state: dict) -> dict:
    """
    Convert internal pipeline state into a stable API response
    for the frontend.
    """

    if state.get("error"):
        return {
            "success": False,
            "request_received": True,
            "response_available": False,
            "status": "error",
            "stage": state.get("current_stage"),
            "pending_action": state.get("pending_action", ""),
            "session_id": state.get("session_id"),
            "response": None,
            "data": {},
            "error": state.get("error"),
        }

    current_stage = state.get("current_stage")

    if current_stage == "waiting_for_approval":
        status = "waiting_for_approval"

    elif current_stage == "end":
        status = "completed"

    else:
        status = "processing"

    response = state.get("response")

    return {
        "success": True,
        "request_received": True,
        "response_available": response is not None,

        "status": status,

        "stage": current_stage,

        "pending_action": state.get(
            "pending_action",
            ""
        ),

        "session_id": state.get("session_id"),

        "response": response,

        "data": {
            "goal": state.get("goal", ""),
            "scope": state.get("scope", ""),
            "requirements": state.get(
                "requirements",
                []
            ),
            "non_functional_requirements": state.get(
                "non_functional_requirements",
                []
            ),
            "constraints": state.get(
                "constraints",
                []
            ),
            "dependencies": state.get(
                "dependencies",
                []
            ),
            "personas": state.get(
                "personas",
                []
            ),
            "assumptions": state.get(
                "assumptions",
                []
            ),
            "epics": state.get(
                "epics",
                []
            ),
            "jira_payload": state.get(
                "jira_payload",
                []
            ),
        },

        "error": None,
    }
