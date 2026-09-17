import json
import os
import queue
import threading
import uuid
from typing import Any, Dict, List, Optional

import requests
from requests.auth import HTTPBasicAuth

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel


# ============================================================
# Jira Server Configuration
# ============================================================

JIRA_URL = os.environ.get(
    "JIRA_URL",
    "https://Jiraserver.com/jira",
).rstrip("/")

USER_ID = os.environ.get(
    "JIRA_USER_ID",
    "",
)

API_TOKEN = os.environ.get(
    "JIRA_API_TOKEN",
    "",
)

PROJECT_KEY = os.environ.get(
    "JIRA_PROJECT_KEY",
    "",
)


# ============================================================
# Jira Custom Fields
#
# Taken from your working Jira Server implementation.
# ============================================================

EPIC_NAME_FIELD = os.environ.get(
    "JIRA_EPIC_NAME_FIELD",
    "customfield_10002"
)


EPIC_LINK_FIELD = os.environ.get(
    "JIRA_EPIC_LINK_FIELD",
    "customfield_10000",
)

STORY_POINTS_FIELD = os.environ.get(
    "JIRA_STORY_POINTS_FIELD",
    "customfield_10006",
)

SPRINT_FIELD = os.environ.get(
    "JIRA_SPRINT_FIELD",
    "customfield_10004",
)

ACCEPTANCE_CRITERIA_FIELD = os.environ.get(
    "JIRA_ACCEPTANCE_CRITERIA_FIELD",
    "customfield_10335",
)

# Optional Jira custom field for Definition of Done. Leave unset if the Jira
# project has no dedicated DoD field.
DEFINITION_OF_DONE_FIELD = os.environ.get(
    "JIRA_DEFINITION_OF_DONE_FIELD",
    "",
)


# ============================================================
# Jira API router
# ============================================================

router = APIRouter()

# ============================================================
# Models
# ============================================================


class SyncRequest(BaseModel):
    issues: List[Dict[str, Any]]


# ============================================================
# In-memory sync jobs
# ============================================================

jobs: Dict[str, Dict[str, Any]] = {}

jobs_lock = threading.Lock()


def create_job() -> str:
    job_id = str(uuid.uuid4())

    with jobs_lock:
        jobs[job_id] = {
            "queue": queue.Queue(),
            "status": "running",
        }

    return job_id


def publish(
    job_id: str,
    payload: Dict[str, Any],
) -> None:
    """
    Publishes one real-time update for React.
    """

    with jobs_lock:
        job = jobs.get(job_id)

    if not job:
        return

    job["queue"].put(payload)


def finish_job(
    job_id: str,
    status: str,
) -> None:
    with jobs_lock:
        job = jobs.get(job_id)

        if job:
            job["status"] = status


# ============================================================
# Configuration validation
# ============================================================


def validate_configuration() -> None:
    missing = []

    if not JIRA_URL:
        missing.append("JIRA_URL")

    if not USER_ID:
        missing.append("JIRA_USER_ID")

    if not API_TOKEN:
        missing.append("JIRA_API_TOKEN")

    if not PROJECT_KEY:
        missing.append("JIRA_PROJECT_KEY")

    if missing:
        raise RuntimeError(
            "Missing Jira environment variables: "
            + ", ".join(missing)
        )


# ============================================================
# Utility functions
# ============================================================


def has_value(value: Any) -> bool:
    """
    Equivalent idea to pd.notna() for our JSON payload.

    Returns False for:
      None
      ""
      whitespace-only strings
    """

    if value is None:
        return False

    if isinstance(value, str):
        return bool(value.strip())

    return True


def get_issue_type(
    issue: Dict[str, Any],
) -> str:
    return str(
        issue.get("issue_type")
        or issue.get("issueType")
        or "Task"
    ).strip()


def get_node_id(
    issue: Dict[str, Any],
) -> Optional[str]:
    value = (
        issue.get("nodeId")
        or issue.get("node_id")
    )

    if value is None:
        return None

    return str(value)


def get_existing_jira_key(
    issue: Dict[str, Any],
) -> Optional[str]:
    value = (
        issue.get("jiraKey")
        or issue.get("jira_key")
    )

    if not has_value(value):
        return None

    return str(value).strip()


# ============================================================
# Acceptance Criteria
# ============================================================


def build_acceptance_criteria(
    value: Any,
) -> List[Dict[str, Any]]:
    """
    Jira field customfield_10335 from your existing program expects:

    [
        {
            "name": "...",
            "checked": false
        }
    ]
    """

    if not has_value(value):
        return []

    criteria = []

    # --------------------------------------------------------
    # Already provided as list
    # --------------------------------------------------------

    if isinstance(value, list):

        for item in value:

            if isinstance(item, str):
                name = item.strip()

            elif isinstance(item, dict):
                name = str(
                    item.get("name")
                    or item.get("text")
                    or item.get("description")
                    or item.get("criterion")
                    or ""
                ).strip()

            else:
                name = str(item).strip()

            if name:
                criteria.append(
                    {
                        "name": name,
                        "checked": False,
                    }
                )

        return criteria

    # --------------------------------------------------------
    # String separated using ;
    # --------------------------------------------------------

    for item in str(value).split(";"):
        name = item.strip()

        if name:
            criteria.append(
                {
                    "name": name,
                    "checked": False,
                }
            )

    return criteria


# ============================================================
# Jira payload creation
# ============================================================


def build_jira_payload(
    issue: Dict[str, Any],
    epic_key: Optional[str] = None,
    parent_key: Optional[str] = None,
) -> Dict[str, Any]:

    issue_type = get_issue_type(issue)

    summary = str(
        issue.get(
            "summary",
            "",
        )
    ).strip()

    description = str(
        issue.get(
            "description",
            "",
        )
        or ""
    ).strip()

    priority = str(
        issue.get(
            "priority",
            "Medium",
        )
        or "Medium"
    ).strip()

    if not summary:
        raise ValueError(
            "Summary is required."
        )

    # ========================================================
    # Base fields
    # ========================================================

    payload = {
        "fields": {
            "project": {
                "key": PROJECT_KEY
            },
            "summary": summary,
            "description": description,
            "issuetype": {
                "name": issue_type
            },
            "priority": {
                "name": priority
            },
        }
    }

    fields = payload["fields"]

    # ========================================================
    # Epic Name
    # ========================================================

    if issue_type.lower() == "epic":
        fields[EPIC_NAME_FIELD] = summary


    # ========================================================
    # Assignee
    # ========================================================

    assignee = (
        issue.get("assignee")
        or issue.get("Assignee")
    )

    if has_value(assignee):

        if isinstance(assignee, dict):
            assignee = (
                assignee.get("name")
                or assignee.get("username")
            )

        if has_value(assignee):
            fields["assignee"] = {
                "name": str(
                    assignee
                ).strip()
            }

    # ========================================================
    # Reporter
    # ========================================================

    reporter = (
        issue.get("reporter")
        or issue.get("Reporter")
    )

    if has_value(reporter):

        if isinstance(reporter, dict):
            reporter = (
                reporter.get("name")
                or reporter.get("username")
            )

        if has_value(reporter):
            fields["reporter"] = {
                "name": str(
                    reporter
                ).strip()
            }

    # ========================================================
    # Labels
    # ========================================================

    labels = (
        issue.get("labels")
        or issue.get("Labels")
    )

    if has_value(labels):

        if isinstance(labels, str):
            labels = [
                label.strip()
                for label in labels.split(",")
                if label.strip()
            ]

        elif isinstance(labels, list):
            labels = [
                str(label).strip()
                for label in labels
                if has_value(label)
            ]

        if labels:
            fields["labels"] = labels

    # ========================================================
    # Fix Version
    # ========================================================

    fix_version = (
        issue.get("fix_version")
        or issue.get("fixVersion")
        or issue.get("Fix Version")
    )

    if has_value(fix_version):
        fields["fixVersions"] = [
            {
                "name": str(
                    fix_version
                ).strip()
            }
        ]

    # ========================================================
    # Story Points
    # ========================================================

    story_points = (
        issue.get("story_points")
        or issue.get("storyPoints")
        or issue.get("Story Points")
    )

    if has_value(story_points):
        try:
            fields[
                STORY_POINTS_FIELD
            ] = int(
                float(story_points)
            )

        except (
            ValueError,
            TypeError,
        ):
            print(
                f"Invalid Story Points for "
                f"'{summary}': {story_points}"
            )



    # ========================================================
    # Sub-task Parent
    # ========================================================

    if (
        issue_type.lower()
        in ("sub-task", "subtask")
        and parent_key
    ):
        fields["parent"] = {
            "key": parent_key
        }

    # ========================================================
    # Sprint
    # ========================================================

    sprint = (
        issue.get("sprint")
        or issue.get("Sprint")
    )

    if has_value(sprint):
        try:
            fields[
                SPRINT_FIELD
            ] = int(sprint)

        except (
            ValueError,
            TypeError,
        ):
            print(
                f"Invalid Sprint ID for "
                f"'{summary}': {sprint}"
            )

    # ========================================================
    # Acceptance Criteria
    # ========================================================

    acceptance_criteria = (
        issue.get(
            "acceptance_criteria"
        )
        or issue.get(
            "acceptanceCriteria"
        )
        or issue.get(
            "Acceptance Criteria"
        )
    )

    if has_value(
        acceptance_criteria
    ):
        criteria = (
            build_acceptance_criteria(
                acceptance_criteria
            )
        )

        if criteria:
            fields[
                ACCEPTANCE_CRITERIA_FIELD
            ] = criteria

    # ========================================================
    # Definition of Done
    # ========================================================

    definition_of_done = (
        issue.get("definition_of_done")
        or issue.get("definitionOfDone")
        or issue.get("dod")
        or issue.get("Definition of Done")
    )

    if has_value(definition_of_done) and DEFINITION_OF_DONE_FIELD:
        dod_items = (
            definition_of_done
            if isinstance(definition_of_done, list)
            else str(definition_of_done).splitlines()
        )
        dod_items = [str(x).strip() for x in dod_items if str(x).strip()][:2]
        if dod_items:
            fields[DEFINITION_OF_DONE_FIELD] = "\n".join(
                f"• {item}" for item in dod_items
            )

    # ========================================================
    # Epic Link
    #
    # Jira Server:
    #
    # Story -> Epic
    #
    # customfield_10000 = ABC-101
    #
    # Do NOT add Epic Link to the Epic itself.
    # ========================================================

    if (
        epic_key
        and issue_type.lower()
        != "epic"
    ):
        fields[
            EPIC_LINK_FIELD
        ] = epic_key

    return payload


# ============================================================
# Actual Jira API call
# ============================================================


def create_jira_ticket(
    issue: Dict[str, Any],
    epic_key: Optional[str] = None,
    parent_key: Optional[str] = None,
) -> str:

    payload = build_jira_payload(
        issue,
        epic_key,
        parent_key,
    )

    url = (
        f"{JIRA_URL}"
        "/rest/api/2/issue"
    )

    response = requests.post(
        url,
        auth=HTTPBasicAuth(
            USER_ID,
            API_TOKEN,
        ),
        headers={
            "Content-Type":
                "application/json"
        },
        data=json.dumps(
            payload
        ),
        timeout=30,
    )

    # ========================================================
    # Success
    # ========================================================

    if response.status_code == 201:

        result = response.json()

        issue_key = result.get(
            "key",
            "",
        )

        if not issue_key:
            raise RuntimeError(
                "Jira returned HTTP 201 "
                "but no issue key."
            )

        print(
            f"Created ticket "
            f"{issue_key} for: "
            f"{issue.get('summary')}"
        )

        return issue_key

    # ========================================================
    # Failure
    # ========================================================

    try:
        error_response = (
            response.json()
        )

        error_message = (
            json.dumps(
                error_response,
                indent=2,
            )
        )

    except Exception:
        error_message = (
            response.text
        )

    raise RuntimeError(
        f"Jira returned HTTP "
        f"{response.status_code}: "
        f"{error_message}"
    )


# ============================================================
# Parent / Epic resolution
# ============================================================


def get_parent_reference(
    issue: Dict[str, Any],
) -> Optional[str]:

    parent = issue.get(
        "parent"
    )

    if not parent:
        return None

    if isinstance(
        parent,
        str,
    ):
        return parent.strip()

    if isinstance(
        parent,
        dict,
    ):
        value = (
            parent.get("nodeId")
            or parent.get("node_id")
            or parent.get("summary")
            or parent.get("key")
            or parent.get("id")
        )

        if value:
            return str(
                value
            ).strip()

    return None


def resolve_epic_key(
    issue: Dict[str, Any],
    epic_by_node_id: Dict[str, str],
    epic_by_summary: Dict[str, str],
) -> Optional[str]:

    # --------------------------------------------------------
    # Explicit Jira Epic Key
    # --------------------------------------------------------

    epic_link = (
        issue.get("epic_link")
        or issue.get("epicLink")
        or issue.get("Epic Link")
    )

    if has_value(epic_link):
        return str(
            epic_link
        ).strip()

    # --------------------------------------------------------
    # Resolve using frontend parent
    # --------------------------------------------------------

    parent_reference = (
        get_parent_reference(
            issue
        )
    )

    if not parent_reference:
        return None

    if (
        parent_reference
        in epic_by_node_id
    ):
        return epic_by_node_id[
            parent_reference
        ]

    if (
        parent_reference
        in epic_by_summary
    ):
        return epic_by_summary[
            parent_reference
        ]

    # --------------------------------------------------------
    # Maybe parent already contains Jira key
    # Example: ABC-123
    # --------------------------------------------------------

    if "-" in parent_reference:
        return parent_reference

    return None


def resolve_story_key(
    issue: Dict[str, Any],
    story_by_node_id: Dict[str, str],
    story_by_summary: Dict[str, str],
) -> Optional[str]:

    parent_reference = (
        get_parent_reference(
            issue
        )
    )

    if not parent_reference:
        return None

    if (
        parent_reference
        in story_by_node_id
    ):
        return story_by_node_id[
            parent_reference
        ]

    if (
        parent_reference
        in story_by_summary
    ):
        return story_by_summary[
            parent_reference
        ]

    # Parent may already contain a Jira key
    # Example: ABC-123
    if "-" in parent_reference:
        return parent_reference

    return None


# ============================================================
# Process single issue
# ============================================================


def process_issue(
    job_id: str,
    issue: Dict[str, Any],
    epic_key: Optional[str] = None,
    parent_key: Optional[str] = None,
) -> Optional[str]:

    node_id = get_node_id(
        issue
    )

    issue_type = get_issue_type(
        issue
    )

    summary = str(
        issue.get(
            "summary",
            "Unnamed issue",
        )
    ).strip()

    existing_jira_key = (
        get_existing_jira_key(
            issue
        )
    )

    # ========================================================
    # Already created previously
    # ========================================================

    if existing_jira_key:

        publish(
            job_id,
            {
                "status":
                    "skipped",

                "nodeId":
                    node_id,

                "issue_type":
                    issue_type,

                "summary":
                    summary,

                "key":
                    existing_jira_key,

                "message":
                    "Issue already exists in Jira",
            },
        )

        return existing_jira_key

    # ========================================================
    # Notify frontend that creation started
    # ========================================================

    publish(
        job_id,
        {
            "status":
                "syncing",

            "nodeId":
                node_id,

            "issue_type":
                issue_type,

            "summary":
                summary,
        },
    )

    try:

        jira_key = (
            create_jira_ticket(
                issue,
                epic_key,
                parent_key,
            )
        )

        # ====================================================
        # Immediately tell React
        # ====================================================

        publish(
            job_id,
            {
                "status":
                    "created",

                "nodeId":
                    node_id,

                "issue_type":
                    issue_type,

                "summary":
                    summary,

                "key":
                    jira_key,
            },
        )

        return jira_key

    except Exception as exc:

        print(
            f"Error creating "
            f"'{summary}': {exc}"
        )

        publish(
            job_id,
            {
                "status":
                    "failed",

                "nodeId":
                    node_id,

                "issue_type":
                    issue_type,

                "summary":
                    summary,

                "error":
                    str(exc),
            },
        )

        return None


# ============================================================
# Main synchronization
# ============================================================


def run_sync(job_id: str, issues: List[Dict[str, Any]]) -> None:
    """Create submitted drafts in hierarchy order, never orphan a failed child."""
    try:
        validate_configuration()
        rank = {"epic": 0, "feature": 1, "story": 2, "task": 2, "sub-task": 3, "subtask": 3}
        ordered = sorted(issues, key=lambda item: rank.get(get_issue_type(item).lower(), 4))
        submitted = {get_node_id(item): item for item in ordered if get_node_id(item)}
        created: Dict[str, str] = {}
        failed: set = set()
        for issue in ordered:
            node_id = get_node_id(issue)
            issue_type = get_issue_type(issue).lower()
            parent_id = str(issue.get("parentNodeId") or "").strip()
            epic_id = str(issue.get("epicNodeId") or "").strip()
            if parent_id and parent_id in submitted and parent_id not in created:
                publish(job_id, {"status": "failed", "nodeId": node_id,
                                 "error": "Parent was not created; child was not submitted to Jira."})
                failed.add(node_id)
                continue
            if epic_id and epic_id in submitted and epic_id not in created:
                publish(job_id, {"status": "failed", "nodeId": node_id,
                                 "error": "Epic was not created; child was not submitted to Jira."})
                failed.add(node_id)
                continue
            epic_key = created.get(epic_id) if epic_id else issue.get("epic_link")
            parent_key = created.get(parent_id) if parent_id else None
            if issue_type in ("sub-task", "subtask") and not parent_key:
                # Existing Jira parents can be supplied explicitly; never use dataset IDs as keys.
                parent_key = issue.get("parentJiraKey")
                if not parent_key:
                    publish(job_id, {"status": "failed", "nodeId": node_id,
                                     "error": "Sub-task requires a created Jira parent."})
                    failed.add(node_id)
                    continue
            key = process_issue(job_id, issue, epic_key=epic_key,
                                parent_key=parent_key if issue_type in ("sub-task", "subtask") else None)
            if key and node_id:
                created[node_id] = key
            elif node_id:
                failed.add(node_id)
        publish(job_id, {"status": "completed", "created": len(created),
                         "failed": len(failed), "total": len(ordered)})
        finish_job(job_id, "completed")
    except Exception as exc:
        publish(job_id, {"status": "job_failed", "error": str(exc)})
        finish_job(job_id, "failed")


# ============================================================
# REST API
# ============================================================


@router.get("/api/jira/health")
def health():

    return {
        "status": "UP",
        "jira": "Server",
        "project": PROJECT_KEY,
    }


@router.post("/api/jira/sync")
def start_jira_sync(
    request: SyncRequest,
):

    if not request.issues:

        raise HTTPException(
            status_code=400,
            detail=(
                "No issues were "
                "provided for Jira sync."
            ),
        )

    # Defense in depth for Foreman Story requests carrying dataset context.
    # Legacy integrations without dataset_id retain their existing contract.
    dataset_stories = [issue for issue in request.issues if str(issue.get("issue_type", "")).lower() == "story" and issue.get("dataset_id")]
    if dataset_stories:
        from backend.main import manager
        from story_intelligence import Draft, ReviewRequest, review_story
        for issue in dataset_stories:
            dataset_id = str(issue["dataset_id"])
            metadata = manager.read_metadata(dataset_id)
            if metadata.get("status") != "ready":
                raise HTTPException(status_code=409, detail="Dataset unavailable for duplicate recheck")
            peers = [Draft(id=str(other.get("nodeId", "")), title=str(other.get("summary", "")),
                           description=str(other.get("description", "")),
                           acceptance_criteria="\n".join(other.get("acceptance_criteria") or []),
                           type=str(other.get("issue_type", "Story")))
                     for other in request.issues if other is not issue and other.get("summary")]
            peers.extend(Draft.model_validate(item) for item in issue.get("local_drafts", [])[:5000])
            draft = Draft(id=str(issue.get("nodeId", "")), title=str(issue.get("summary", "")),
                          description=str(issue.get("description", "")),
                          acceptance_criteria="\n".join(issue.get("acceptance_criteria") or []))
            try:
                result = review_story(manager.paths(dataset_id)["excel"], ReviewRequest(story=draft, local_drafts=peers))
            except Exception as exc:
                raise HTTPException(status_code=409, detail=f"Duplicate recheck unavailable: {str(exc)[:160]}") from exc
            if result["decision"] == "equivalent":
                raise HTTPException(status_code=409, detail=f"Equivalent Story exists: {', '.join(m['id'] for m in result['matches'] if m['decision'] == 'equivalent')}")
            if result["decision"] == "needs_review" and len(str(issue.get("duplicate_override_reason") or "").strip()) < 12:
                raise HTTPException(status_code=409, detail="Similar Story needs a documented distinct-scope decision before Jira creation")

    job_id = create_job()

    # Jira API execution happens separately so that
    # the POST can immediately return jobId to React.
    worker = threading.Thread(
        target=run_sync,
        args=(
            job_id,
            request.issues,
        ),
        daemon=True,
    )

    worker.start()

    return {
        "jobId": job_id,
        "status": "started",
    }


# ============================================================
# Server-Sent Events
# ============================================================


@router.get(
    "/api/jira/sync/{job_id}/events"
)
def jira_sync_events(
    job_id: str,
):

    with jobs_lock:

        job = jobs.get(
            job_id
        )

    if not job:

        raise HTTPException(
            status_code=404,
            detail=(
                "Jira synchronization "
                "job not found."
            ),
        )

    event_queue: queue.Queue = (
        job["queue"]
    )

    def event_generator():

        while True:

            try:

                # Wait for Jira progress event
                event = (
                    event_queue.get(
                        timeout=15
                    )
                )

                yield (
                    "data: "
                    + json.dumps(
                        event
                    )
                    + "\n\n"
                )

                # Close SSE when job completes
                if event.get(
                    "status"
                ) in (
                    "completed",
                    "job_failed",
                ):

                    break

            except queue.Empty:

                # SSE keep-alive
                yield (
                    ": keep-alive\n\n"
                )

    return StreamingResponse(
        event_generator(),
        media_type=(
            "text/event-stream"
        ),
        headers={
            "Cache-Control":
                "no-cache",

            "Connection":
                "keep-alive",

            "X-Accel-Buffering":
                "no",
        },
    )
