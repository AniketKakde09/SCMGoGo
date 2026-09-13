import json

from agents.jira_validator import validate_jira_payload


# =========================================================
# JIRA PAYLOAD BUILDER
# =========================================================

def build_jira_payload(
    state: dict,
) -> dict:
    """
    Convert the generated backlog into a Jira payload.

    The payload is validated before being stored in state.
    """

    print(
        "\n============= Jira Payload Builder ============="
    )

    # -----------------------------------------------------
    # GET EPICS
    # -----------------------------------------------------

    epics = state.get(
        "epics",
        []
    )

    print(
        f"EPICS RECEIVED BY JIRA BUILDER: {len(epics)}"
    )

    # -----------------------------------------------------
    # SAFETY CHECK
    # -----------------------------------------------------

    if not isinstance(epics, list):

        raise ValueError(
            "Backlog 'epics' must be a list."
        )

    payload = []

    # -----------------------------------------------------
    # BUILD PAYLOAD
    # -----------------------------------------------------

    for epic in epics:

        if not isinstance(epic, dict):
            continue

        is_placeholder = epic.get(
            "placeholder",
            False
        )

        epic_title = epic.get(
            "title",
            ""
        )

        epic_description = epic.get(
            "description",
            ""
        )

        # -------------------------------------------------
        # EPIC
        # -------------------------------------------------

        if not is_placeholder:

            payload.append({
                "issue_type": "Epic",

                "summary": epic_title,

                "description": epic_description,
            })

        # -------------------------------------------------
        # STORIES
        # -------------------------------------------------

        stories = epic.get(
            "stories",
            []
        )

        if not isinstance(stories, list):
            continue

        for story in stories:

            if not isinstance(story, dict):
                continue

            story_title = story.get(
                "title",
                ""
            )

            story_description = story.get(
                "description",
                ""
            )

            story_points = story.get(
                "story_points",
                0
            )

            dependencies = story.get(
                "dependencies",
                []
            )

            acceptance_criteria = story.get(
                "acceptance_criteria",
                []
            )

            story_payload = {
                "issue_type": "Story",

                "summary": story_title,

                "description": story_description,

                "story_points": story_points,

                "dependencies": dependencies,

                "acceptance_criteria": acceptance_criteria,
            }

            # -------------------------------------------------
            # STORY → EPIC RELATIONSHIP
            # -------------------------------------------------

            if not is_placeholder:

                story_payload["parent"] = epic_title

            payload.append(
                story_payload
            )

            # -------------------------------------------------
            # TASKS
            # -------------------------------------------------

            tasks = story.get(
                "tasks",
                []
            )

            if not isinstance(tasks, list):
                continue

            for task in tasks:

                if not isinstance(task, dict):
                    continue

                task_title = task.get(
                    "title",
                    ""
                )

                task_description = task.get(
                    "description",
                    ""
                )

                payload.append({
                    "issue_type": "Task",

                    "summary": task_title,

                    "description": task_description,

                    "parent": story_title,
                })

    # -----------------------------------------------------
    # VALIDATE JIRA PAYLOAD
    # -----------------------------------------------------

    print(
        f"VALIDATING {len(payload)} JIRA ISSUES..."
    )

    validate_jira_payload(
        payload
    )

    # -----------------------------------------------------
    # SAVE PAYLOAD TO STATE
    # -----------------------------------------------------

    state["jira_payload"] = payload

    # -----------------------------------------------------
    # RESPONSE
    # -----------------------------------------------------

    state["response"] = {
        "message": (
            "Jira payload generated successfully."
        )
    }

    # -----------------------------------------------------
    # DEBUG OUTPUT
    # -----------------------------------------------------

    print(
        f"Prepared {len(payload)} Jira issue(s)."
    )

    print(
        "\n========== JIRA PAYLOAD =========="
    )

    print(
        json.dumps(
            payload,
            indent=4,
            ensure_ascii=False,
        )
    )

    print(
        "==================================\n"
    )

    return state
