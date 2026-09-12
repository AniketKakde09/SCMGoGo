from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from pipeline import process_user_input
from jira_sync import router as jira_router
from api_response import build_api_response

# =========================================================
# APPLICATION
# =========================================================

app = FastAPI(
    title="AI Scrum Master API",
    description="Backend API for the AI Scrum Master",
    version="1.5.0",
)


# =========================================================
# CORS
# =========================================================

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# =========================================================
# JIRA ROUTES
# =========================================================

app.include_router(jira_router)

# =========================================================
# SESSION STORAGE
# =========================================================

sessions: dict[str, dict] = {}


# =========================================================
# INITIAL STATE
# =========================================================

def create_initial_state(session_id: str) -> dict:
    """
    Create a fresh workflow state for a new session.
    """

    return {
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

        "response": "",
        "pending_action": "",

        "error": "",
    }


# =========================================================
# REQUEST MODEL
# =========================================================

class ChatRequest(BaseModel):
    session_id: str | None = Field(
        default=None,
        description="Existing session ID. Omit for the first request.",
    )

    message: str = Field(
        ...,
        min_length=1,
        description="User message.",
    )


# =========================================================
# HEALTH CHECK
# =========================================================

@app.get("/health")
def health():
    return {
        "success": True,
        "status": "ok",
        "service": "ai-scrum-master",
        "version": "1.5.0",
    }


# =========================================================
# MAIN PROCESS ENDPOINT
# =========================================================

@app.post("/api/process")
def process(request: ChatRequest):
    """
    Main AI Scrum Master processing endpoint.

    The workflow automatically generates and validates
    the Jira payload.

    No yes/no approval is required.
    """

    # -----------------------------------------------------
    # CREATE OR RESTORE SESSION
    # -----------------------------------------------------

    if request.session_id:

        state = sessions.get(request.session_id)

        if state is None:
            raise HTTPException(
                status_code=404,
                detail={
                    "success": False,
                    "request_received": False,
                    "response_available": False,
                    "status": "session_not_found",
                    "session_id": request.session_id,
                    "message": (
                        "The supplied session_id "
                        "does not exist."
                    ),
                },
            )

    else:

        session_id = str(uuid4())

        state = create_initial_state(
            session_id
        )

        sessions[session_id] = state

    # -----------------------------------------------------
    # UPDATE STATE
    # -----------------------------------------------------

    state["raw_input"] = request.message
    state["error"] = ""

    # -----------------------------------------------------
    # RUN PIPELINE
    # -----------------------------------------------------

    try:

        state = process_user_input(state)

    except Exception as error:

        print(
            "\n========== PIPELINE ERROR =========="
        )

        print(
            str(error)
        )

        print(
            "====================================\n"
        )

        state["error"] = str(error)
        state["current_stage"] = "end"

        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": {
                    "message": str(error)
                },
                "session_id": state.get(
                    "session_id",
                    ""
                ),
            },
        )

    # -----------------------------------------------------
    # SAVE SESSION
    # -----------------------------------------------------

    sessions[
        state["session_id"]
    ] = state

    # -----------------------------------------------------
    # HANDLE PIPELINE ERROR
    # -----------------------------------------------------

    if state.get("error"):

        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": {
                    "message": state["error"]
                },
                "session_id": state.get(
                    "session_id",
                    ""
                ),
            },
        )

    # -----------------------------------------------------
    # BUILD FRONTEND RESPONSE
    # -----------------------------------------------------

    result = build_api_response(
        state
    )

    # -----------------------------------------------------
    # MAP INTERNAL STATUS -> FRONTEND STATUS
    #
    # The frontend (Canvas.jsx) only understands:
    #   "general"             -> non-Scrum chit-chat
    #   "needs_clarification" -> pipeline needs more info
    #   "complete"            -> jira_payload is ready
    #   "error"               -> handled above
    #
    # build_api_response() uses different internal labels
    # ("completed", "waiting_for_approval", "processing"),
    # so translate them here rather than changing the
    # frontend.
    # -----------------------------------------------------

    internal_status = result.get("status")

    status_map = {
        "completed": "complete",
        "waiting_for_approval": "needs_clarification",
        "processing": "processing",
    }

    frontend_status = status_map.get(
        internal_status,
        internal_status,
    )

    if state.get("intent") == "GENERAL":
        frontend_status = "general"

    data = result.get("data", {})

    return {
        "success": result.get("success", True),

        "session_id": result.get(
            "session_id",
            state.get("session_id", "")
        ),

        "status": frontend_status,

        "message": (result.get("response") or {}).get(
            "message",
            ""
        ),

        "jira_payload": data.get(
            "jira_payload",
            []
        ),

        "intent": state.get(
            "intent",
            ""
        ),

        "questions": [],

        "data": data,

        "response": result.get(
            "response",
            {"message": ""}
        ),
    }
