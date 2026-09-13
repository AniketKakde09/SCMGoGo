from uuid import uuid4

from fastapi import FastAPI, HTTPException, UploadFile, File, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from pipeline import process_user_input
from jira_sync import router as jira_router
from api_response import build_api_response
from services.document_converter import extract_text_from_file


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
# RESPONSE MODEL
# =========================================================

class ChatResponse(BaseModel):
    success: bool
    request_received: bool
    response_available: bool
    status: str
    session_id: str
    stage: str | None
    pending_action: str | None
    response: dict
    data: dict | None
    error: dict | None


# =========================================================
# API RESPONSE BUILDER
# =========================================================

def build_api_response(state: dict) -> dict:
    """
    Convert internal workflow state into a stable frontend API response.

    The frontend should consume this structure rather than the
    internal pipeline state directly.
    """

    error = state.get("error")
    stage = state.get("current_stage")

    # -----------------------------------------------------
    # Determine API status
    # -----------------------------------------------------

    if error:
        status = "error"

    elif stage == "waiting_for_approval":
        status = "waiting_for_input"

    elif stage == "jira":
        status = "completed"

    elif stage == "end":
        status = "completed"

    else:
        status = "processing"

    success = not bool(error)

    # -----------------------------------------------------
    # Normalize response
    # -----------------------------------------------------

    raw_response = state.get("response")

    if isinstance(raw_response, str):
        response = {
            "message": raw_response
        }

    elif isinstance(raw_response, dict):
        response = {
            "message": raw_response.get("message", "")
        }

    elif raw_response is None:
        response = {
            "message": ""
        }

    else:
        response = {
            "message": str(raw_response)
        }

    # -----------------------------------------------------
    # Frontend data
    # -----------------------------------------------------

    data = {
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
    }

    # -----------------------------------------------------
    # Error
    # -----------------------------------------------------

    error_data = None

    if error:
        error_data = {
            "message": error
        }

    # -----------------------------------------------------
    # Final frontend response
    # -----------------------------------------------------

    return {
        "success": success,

        "request_received": True,

        "response_available": True,

        "status": status,

        "session_id": state.get(
            "session_id",
            ""
        ),

        "stage": stage,

        "pending_action": (
            state.get("pending_action")
            or None
        ),

        "response": response,

        "data": data,

        "error": error_data,
    }


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

@app.post("/process")
@app.post("/api/process")
def process(request: ChatRequest):
    """
    Main AI Scrum Master processing endpoint.

    Creates a session for the first request and reuses the
    session for subsequent requests.
    """

    # -----------------------------------------------------
    # CREATE OR RESTORE SESSION
    # -----------------------------------------------------

    if request.session_id:

        state = sessions.get(
            request.session_id
        )

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

        # IMPORTANT:
        # create_initial_state now requires session_id.

        session_id = str(uuid4())

        state = create_initial_state(
            session_id
        )

        sessions[session_id] = state

    # -----------------------------------------------------
    # UPDATE STATE WITH USER INPUT
    # -----------------------------------------------------

    state["raw_input"] = request.message

    state["error"] = ""

    # -----------------------------------------------------
    # RUN PIPELINE
    # -----------------------------------------------------

    try:

        state = process_user_input(
            state
        )

    except Exception as error:

        print(
            f"Pipeline processing failed: {error}"
        )

        # Keep the actual error while developing.
        state["error"] = str(error)

        state["current_stage"] = "end"

        state["response"] = {
            "message": (
                "I couldn't process your request."
            )
        }

    # -----------------------------------------------------
    # SAVE UPDATED SESSION
    # -----------------------------------------------------

    sessions[
        state["session_id"]
    ] = state

    # -----------------------------------------------------
    # BUILD FRONTEND RESPONSE
    # -----------------------------------------------------

    result = build_api_response(
        state
    )

    # -----------------------------------------------------
    # RETURN STABLE RESPONSE EVEN ON ERROR
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
    # MAP INTERNAL STATUS -> FRONTEND STATUS
    #
    # The frontend (Canvas.jsx) only understands:
    #   "general"             -> non-Scrum chit-chat
    #   "needs_clarification" -> pipeline needs more info
    #   "complete"            -> jira_payload is ready
    #   "error"               -> handled above
    #
    # build_api_response() uses different internal labels
    # ("completed", "waiting_for_input", "processing"), so
    # translate them here rather than changing the frontend.
    # -----------------------------------------------------

    internal_status = result.get("status")

    status_map = {
        "completed": "complete",
        "waiting_for_input": "needs_clarification",
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

        "message": result.get(
            "response", {}
        ).get("message", ""),

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


# =========================================================
# FILE PROCESS ENDPOINT
# =========================================================

@app.post("/process/file")
@app.post("/api/process/file")
async def process_file(
    file: UploadFile = File(...),
    session_id: str | None = Query(default=None),
):
    """
    File intake processing endpoint.

    Extracts text from uploaded documents (.pdf, .docx, .txt, .md, .csv,
    .pptx, .xlsx, .html, etc.) and processes it through the AI Scrum Master pipeline.
    """

    # -----------------------------------------------------
    # READ FILE CONTENTS
    # -----------------------------------------------------

    try:
        content_bytes = await file.read()
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail={
                "success": False,
                "error": {"message": f"Failed to read uploaded file: {str(e)}"},
                "session_id": session_id or "",
            },
        )

    # -----------------------------------------------------
    # EXTRACT TEXT FROM DOCUMENT
    # -----------------------------------------------------

    try:
        extracted_text = extract_text_from_file(
            file.filename or "",
            content_bytes,
        )
    except ValueError as val_err:
        raise HTTPException(
            status_code=400,
            detail={
                "success": False,
                "error": {"message": str(val_err)},
                "session_id": session_id or "",
            },
        )
    except Exception as err:
        raise HTTPException(
            status_code=500,
            detail={
                "success": False,
                "error": {"message": f"Document extraction error: {str(err)}"},
                "session_id": session_id or "",
            },
        )

    # -----------------------------------------------------
    # CREATE OR RESTORE SESSION
    # -----------------------------------------------------

    if session_id:
        state = sessions.get(session_id)

        if state is None:
            raise HTTPException(
                status_code=404,
                detail={
                    "success": False,
                    "request_received": False,
                    "response_available": False,
                    "status": "session_not_found",
                    "session_id": session_id,
                    "message": "The supplied session_id does not exist.",
                },
            )
    else:
        session_id = str(uuid4())
        state = create_initial_state(session_id)
        sessions[session_id] = state

    # -----------------------------------------------------
    # UPDATE STATE WITH EXTRACTED DOCUMENT TEXT
    # -----------------------------------------------------

    state["raw_input"] = extracted_text
    state["parsed_text"] = extracted_text
    state["source_type"] = "file"
    state["filename"] = file.filename or ""
    state["error"] = ""

    # -----------------------------------------------------
    # RUN PIPELINE
    # -----------------------------------------------------

    try:
        state = process_user_input(state)
    except Exception as error:
        print("\n========== PIPELINE ERROR (FILE) ==========")
        print(str(error))
        print("===========================================\n")

        state["error"] = str(error)
        state["current_stage"] = "end"

        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": {"message": str(error)},
                "session_id": state.get("session_id", ""),
            },
        )

    # -----------------------------------------------------
    # SAVE SESSION
    # -----------------------------------------------------

    sessions[state["session_id"]] = state

    # -----------------------------------------------------
    # HANDLE PIPELINE ERROR
    # -----------------------------------------------------

    if state.get("error"):
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": {"message": state["error"]},
                "session_id": state.get("session_id", ""),
            },
        )

    # -----------------------------------------------------
    # BUILD FRONTEND RESPONSE
    # -----------------------------------------------------

    result = build_api_response(state)

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
