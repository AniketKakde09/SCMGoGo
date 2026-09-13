from typing import Any


# =========================================================
# CONSTANTS
# =========================================================

ALLOWED_ISSUE_TYPES = {
    "Epic",
    "Story",
    "Task",
}


# =========================================================
# MAIN VALIDATOR
# =========================================================

def validate_jira_payload(
    payload: Any,
) -> None:
    """
    Validate Jira payload structure and relationships.

    Raises:
        ValueError: If the payload is invalid.
    """

    # -----------------------------------------------------
    # PAYLOAD TYPE
    # -----------------------------------------------------

    if not isinstance(payload, list):

        raise ValueError(
            "Jira payload must be a list."
        )

    epic_names = set()
    story_names = set()

    # -----------------------------------------------------
    # FIRST PASS
    #
    # Validate basic structure and register Epics.
    # -----------------------------------------------------

    for index, issue in enumerate(payload):

        if not isinstance(issue, dict):

            raise ValueError(
                f"Issue at index {index} "
                "must be an object."
            )

        issue_type = issue.get(
            "issue_type"
        )

        summary = issue.get(
            "summary"
        )

        description = issue.get(
            "description"
        )

        # -------------------------------------------------
        # ISSUE TYPE
        # -------------------------------------------------

        if issue_type not in ALLOWED_ISSUE_TYPES:

            raise ValueError(
                f"Issue at index {index} has invalid "
                f"issue_type '{issue_type}'."
            )

        # -------------------------------------------------
        # SUMMARY
        # -------------------------------------------------

        if (
            not isinstance(summary, str)
            or not summary.strip()
        ):

            raise ValueError(
                f"{issue_type} at index {index} "
                "must have a non-empty summary."
            )

        # -------------------------------------------------
        # DESCRIPTION
        # -------------------------------------------------

        if not isinstance(
            description,
            str,
        ):

            raise ValueError(
                f"{issue_type} '{summary}' "
                "description must be a string."
            )

        # -------------------------------------------------
        # REGISTER EPIC
        # -------------------------------------------------

        if issue_type == "Epic":

            epic_names.add(
                summary.strip()
            )

    # -----------------------------------------------------
    # SECOND PASS
    #
    # Validate Stories and register them.
    # -----------------------------------------------------

    for index, issue in enumerate(payload):

        if issue.get(
            "issue_type"
        ) != "Story":

            continue

        summary = issue[
            "summary"
        ]

        # -------------------------------------------------
        # STORY POINTS
        # -------------------------------------------------

        if "story_points" not in issue:

            raise ValueError(
                f"Story '{summary}' is missing "
                "'story_points'."
            )

        story_points = issue[
            "story_points"
        ]

        if (
            isinstance(story_points, bool)
            or not isinstance(
                story_points,
                int,
            )
        ):

            raise ValueError(
                f"Story '{summary}' "
                "story_points must be an integer."
            )

        if story_points <= 0:

            raise ValueError(
                f"Story '{summary}' "
                "story_points must be greater than 0."
            )

        # -------------------------------------------------
        # DEPENDENCIES
        # -------------------------------------------------

        if "dependencies" not in issue:

            raise ValueError(
                f"Story '{summary}' is missing "
                "'dependencies'."
            )

        dependencies = issue[
            "dependencies"
        ]

        if not isinstance(
            dependencies,
            list,
        ):

            raise ValueError(
                f"Story '{summary}' "
                "dependencies must be a list."
            )

        # -------------------------------------------------
        # ACCEPTANCE CRITERIA
        # -------------------------------------------------

        if "acceptance_criteria" not in issue:

            raise ValueError(
                f"Story '{summary}' is missing "
                "'acceptance_criteria'."
            )

        acceptance_criteria = issue[
            "acceptance_criteria"
        ]

        if not isinstance(
            acceptance_criteria,
            list,
        ):

            raise ValueError(
                f"Story '{summary}' "
                "acceptance_criteria must be a list."
            )

        # -------------------------------------------------
        # STORY → EPIC RELATIONSHIP
        # -------------------------------------------------

        if "parent" in issue:

            parent = issue[
                "parent"
            ]

            if (
                not isinstance(
                    parent,
                    str,
                )
                or not parent.strip()
            ):

                raise ValueError(
                    f"Story '{summary}' parent "
                    "must be a non-empty string."
                )

            if parent.strip() not in epic_names:

                raise ValueError(
                    f"Story '{summary}' references "
                    f"unknown Epic '{parent}'."
                )

        # -------------------------------------------------
        # REGISTER STORY
        # -------------------------------------------------

        story_names.add(
            summary.strip()
        )

    # -----------------------------------------------------
    # THIRD PASS
    #
    # Validate Tasks.
    # -----------------------------------------------------

    for index, issue in enumerate(payload):

        if issue.get(
            "issue_type"
        ) != "Task":

            continue

        summary = issue[
            "summary"
        ]

        # -------------------------------------------------
        # TASK PARENT
        # -------------------------------------------------

        if "parent" not in issue:

            raise ValueError(
                f"Task '{summary}' "
                "is missing 'parent'."
            )

        parent = issue[
            "parent"
        ]

        if (
            not isinstance(
                parent,
                str,
            )
            or not parent.strip()
        ):

            raise ValueError(
                f"Task '{summary}' parent "
                "must be a non-empty string."
            )

        if parent.strip() not in story_names:

            raise ValueError(
                f"Task '{summary}' references "
                f"unknown Story '{parent}'."
            )

    # -----------------------------------------------------
    # DUPLICATE CHECK
    # -----------------------------------------------------

    validate_duplicate_summaries(
        payload
    )


# =========================================================
# DUPLICATE VALIDATOR
# =========================================================

def validate_duplicate_summaries(
    payload: list,
) -> None:
    """
    Prevent duplicate summaries within
    the same Jira issue type.
    """

    seen = {
        "Epic": set(),
        "Story": set(),
        "Task": set(),
    }

    for issue in payload:

        issue_type = issue[
            "issue_type"
        ]

        summary = issue[
            "summary"
        ].strip()

        if summary in seen[
            issue_type
        ]:

            raise ValueError(
                f"Duplicate {issue_type} "
                f"summary found: '{summary}'."
            )

        seen[
            issue_type
        ].add(summary)


# =========================================================
# BACKWARD COMPATIBILITY
# =========================================================

def validate_jira_relationships(
    payload: list,
) -> None:
    """
    Backward-compatible wrapper.
    """

    validate_jira_payload(
        payload
    )
