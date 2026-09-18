from __future__ import annotations

"""Lightweight PII and secret sanitization boundary.

Uses Microsoft Presidio directly when available.

Presidio is intentionally kept outside the LLM stack: this module only
detects and replaces sensitive values.

A deterministic regex layer remains active for secrets and Indian
identifiers.

IMPORTANT:
- Presidio/spaCy is optional.
- The application NEVER downloads a spaCy model at runtime.
- If the local spaCy model is unavailable, the regex fallback remains active.
- A Presidio initialization failure must never break SAD processing.
"""

import re
import uuid
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any

# ---------------------------------------------------------------------------
# Optional Presidio imports
# ---------------------------------------------------------------------------

try:
    from presidio_analyzer import (
        AnalyzerEngine,
        RecognizerRegistry,
    )
    from presidio_analyzer.nlp_engine import (
        NlpEngineProvider,
    )
    from presidio_anonymizer import AnonymizerEngine
    from presidio_anonymizer.entities import OperatorConfig

    _PRESIDIO_IMPORTS_AVAILABLE = True

except Exception:  # pragma: no cover - depends on deployment environment
    AnalyzerEngine = None
    RecognizerRegistry = None
    NlpEngineProvider = None
    AnonymizerEngine = None
    OperatorConfig = None

    _PRESIDIO_IMPORTS_AVAILABLE = False


# ---------------------------------------------------------------------------
# PII configuration
# ---------------------------------------------------------------------------

# Keep Scrum/business identifiers and planning fields intact.
#
# In particular, we intentionally do not mask generic LOCATION or DATE_TIME
# values because the forecasting and planning features use them.

PII_ENTITIES = [
    "PERSON",
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "CREDIT_CARD",
    "IBAN_CODE",
    "US_SSN",
    "US_DRIVER_LICENSE",
    "US_PASSPORT",
    "US_BANK_NUMBER",
    "IN_PAN",
    "IN_AADHAAR",
    "IN_PASSPORT",
    "IN_VEHICLE_REGISTRATION",
    "IN_VOTER",
    "IP_ADDRESS",
]


# Technical and Agile terms that spaCy/Presidio frequently misidentifies
# as PERSON.
#
# These will be explicitly filtered out from PII masking.

EXCLUDED_PERSON_TERMS = {
    "sad",
    "api",
    "ui",
    "ux",
    "jira",
    "epic",
    "story",
    "feature",
    "task",
    "bug",
    "subtask",
    "kanban",
    "scrum",
    "backlog",
    "sprint",
}


JIRA_KEY_PATTERN = re.compile(r"\b[A-Z]+-\d+\b")


# ---------------------------------------------------------------------------
# Result model
# ---------------------------------------------------------------------------


@dataclass
class SanitizationResult:
    text: str
    changed: bool
    pii_detected: bool = False
    secrets_detected: bool = False
    method: str = "regex-fallback"
    categories: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Secret detection
# ---------------------------------------------------------------------------

# Secrets are not PII, so they get their own deterministic boundary.

SECRET_PATTERNS: list[tuple[str, re.Pattern[str], str]] = [
    (
        "AWS_ACCESS_KEY",
        re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
        "<SECRET_AWS_ACCESS_KEY>",
    ),
    (
        "BEARER_TOKEN",
        re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{12,}"),
        "Bearer <SECRET_TOKEN>",
    ),
    (
        "JWT",
        re.compile(
            r"\beyJ[A-Za-z0-9_-]{8,}" r"\.[A-Za-z0-9_-]{8,}" r"\.[A-Za-z0-9_-]{8,}\b"
        ),
        "<SECRET_JWT>",
    ),
    (
        "PRIVATE_KEY",
        re.compile(
            r"-----BEGIN(?: RSA| EC| OPENSSH)? PRIVATE KEY-----[\s\S]*?"
            r"-----END(?: RSA| EC| OPENSSH)? PRIVATE KEY-----"
        ),
        "<SECRET_PRIVATE_KEY>",
    ),
    (
        "PASSWORD_ASSIGNMENT",
        re.compile(r"(?i)" r"(\b(?:password|passwd|pwd)\s*[:=]\s*)" r"([^\s,;]+)"),
        r"\1<SECRET_PASSWORD>",
    ),
    (
        "API_KEY_ASSIGNMENT",
        re.compile(
            r"(?i)"
            r"(\b(?:api[_ -]?key|access[_ -]?token|"
            r"client[_ -]?secret|secret[_ -]?key)"
            r"\s*[:=]\s*)"
            r"([^\s,;]+)"
        ),
        r"\1<SECRET_VALUE>",
    ),
    (
        "CONNECTION_STRING",
        re.compile(
            r"(?i)" r"\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis)" r"://[^\s]+"
        ),
        "<SECRET_CONNECTION_STRING>",
    ),
]


# ---------------------------------------------------------------------------
# Deterministic PII fallback
# ---------------------------------------------------------------------------

# These patterns supplement Presidio, especially for Indian identifiers
# and secrets.
#
# They are deliberately conservative.

FALLBACK_PII_PATTERNS: list[tuple[str, re.Pattern[str], str]] = [
    (
        "EMAIL_ADDRESS",
        re.compile(
            r"\b[A-Z0-9._%+-]+" r"@[A-Z0-9.-]+\.[A-Z]{2,}\b",
            re.I,
        ),
        "<EMAIL_ADDRESS>",
    ),
    (
        "PHONE_NUMBER",
        re.compile(
            r"(?<!\w)"
            r"(?:\+?\d{1,3}[\s.-]?)?"
            r"(?:\(?\d{3}\)?[\s.-]?)"
            r"\d{3}[\s.-]?\d{4}"
            r"(?!\w)"
        ),
        "<PHONE_NUMBER>",
    ),
    (
        "IN_PAN",
        re.compile(
            r"\b[A-Z]{5}\d{4}[A-Z]\b",
            re.I,
        ),
        "<IN_PAN>",
    ),
    (
        "IN_AADHAAR",
        re.compile(r"(?<!\d)" r"\d{4}[ -]?\d{4}[ -]?\d{4}" r"(?!\d)"),
        "<IN_AADHAAR>",
    ),
    (
        "CREDIT_CARD",
        re.compile(r"(?<!\d)" r"(?:\d[ -]?){13,19}" r"(?!\d)"),
        "<CREDIT_CARD>",
    ),
]


# ---------------------------------------------------------------------------
# Presidio initialization
# ---------------------------------------------------------------------------


@lru_cache(maxsize=1)
def _presidio_engines():
    """Create Presidio engines using an already-installed local spaCy model.

    IMPORTANT:
    Presidio/spaCy must never download models during an API request.

    If the required local model is not installed, this function returns
    (None, None), allowing the deterministic regex fallback to handle
    sanitization.
    """

    if not _PRESIDIO_IMPORTS_AVAILABLE:
        return None, None

    try:
        import spacy

        model_name = "en_core_web_sm"

        # ---------------------------------------------------------------
        # IMPORTANT
        # ---------------------------------------------------------------
        # spacy.util.is_package() checks whether the model is installed.
        #
        # We deliberately DO NOT call:
        #
        #     spacy.cli.download(...)
        #
        # This prevents Presidio from attempting an internet connection
        # while processing an SAD upload.
        # ---------------------------------------------------------------

        if not spacy.util.is_package(model_name):
            return None, None

        configuration = {
            "nlp_engine_name": "spacy",
            "models": [
                {
                    "lang_code": "en",
                    "model_name": model_name,
                }
            ],
        }

        provider = NlpEngineProvider(nlp_configuration=configuration)

        nlp_engine = provider.create_engine()

        registry = RecognizerRegistry()

        registry.load_predefined_recognizers(nlp_engine=nlp_engine)

        analyzer = AnalyzerEngine(
            registry=registry,
            nlp_engine=nlp_engine,
            supported_languages=["en"],
        )

        anonymizer = AnonymizerEngine()

        return analyzer, anonymizer

    except Exception:
        # Presidio is an enhancement, not a hard dependency.
        #
        # If anything goes wrong during initialization, fall back to
        # deterministic regex sanitization.
        return None, None


# ---------------------------------------------------------------------------
# Placeholder generation
# ---------------------------------------------------------------------------


def _get_unique_placeholder(
    entity_type: str,
    mapping: dict[str, str],
    original_value: str,
) -> str:
    """Generate/retrieve a unique placeholder for an entity value."""

    key = f"{entity_type}:{original_value}"

    if key not in mapping:
        unique_id = uuid.uuid4().hex[:6]

        mapping[key] = f"<{entity_type}_{unique_id}>"

    return mapping[key]


# ---------------------------------------------------------------------------
# Main sanitization function
# ---------------------------------------------------------------------------


def sanitize_text(text: Any) -> SanitizationResult:
    """Sanitize user/dataset text.

    Presidio is used when its local spaCy model is available.

    Otherwise, deterministic regex detection continues to protect common
    PII and secrets.
    """

    original = "" if text is None else str(text)

    if not original:
        return SanitizationResult(
            text="",
            changed=False,
            method="none",
        )

    method = "regex-fallback"

    spans: list[tuple[int, int, str]] = []

    pii_categories: set[str] = set()

    # ------------------------------------------------------------------
    # Attempt Presidio
    # ------------------------------------------------------------------

    analyzer, _ = _presidio_engines()

    if analyzer is not None:

        try:
            results = analyzer.analyze(
                text=original,
                entities=PII_ENTITIES,
                language="en",
                score_threshold=0.45,
            )

            if results:
                method = "presidio+regex-secrets"

                for res in results:

                    matched_value = original[res.start : res.end]

                    cleaned_val_lower = matched_value.strip().lower()

                    # --------------------------------------------------
                    # Filter false-positive PERSON detections
                    # --------------------------------------------------

                    if res.entity_type == "PERSON":

                        if (
                            JIRA_KEY_PATTERN.match(matched_value)
                            or cleaned_val_lower in EXCLUDED_PERSON_TERMS
                        ):
                            continue

                        # Ignore single-character "names"
                        if len(matched_value.strip()) <= 1:
                            continue

                    spans.append(
                        (
                            res.start,
                            res.end,
                            res.entity_type,
                        )
                    )

                    pii_categories.add(res.entity_type)

        except Exception:
            # Presidio failed during analysis.
            #
            # Continue with deterministic regex protection.
            method = "regex-fallback-after-presidio-error"

    # ------------------------------------------------------------------
    # Deterministic PII fallback / supplement
    # ------------------------------------------------------------------

    for (
        category,
        pattern,
        _,
    ) in FALLBACK_PII_PATTERNS:

        for match in pattern.finditer(original):

            start, end = match.span()

            # Avoid overlapping existing Presidio spans.
            if not any(s <= start < e or s < end <= e for s, e, _ in spans):
                spans.append(
                    (
                        start,
                        end,
                        category,
                    )
                )

                pii_categories.add(category)

    # ------------------------------------------------------------------
    # Replace PII spans
    # ------------------------------------------------------------------

    # Replace from the end of the string so earlier indexes remain valid.

    spans.sort(
        key=lambda x: x[0],
        reverse=True,
    )

    placeholder_mapping: dict[str, str] = {}

    working_text = original

    for (
        start,
        end,
        entity_type,
    ) in spans:

        matched_value = working_text[start:end]

        placeholder = _get_unique_placeholder(
            entity_type,
            placeholder_mapping,
            matched_value,
        )

        working_text = working_text[:start] + placeholder + working_text[end:]

    # ------------------------------------------------------------------
    # Secret sanitization
    # ------------------------------------------------------------------

    final_text, secret_categories = _secret_sanitize(working_text)

    categories = sorted(list(pii_categories) + secret_categories)

    return SanitizationResult(
        text=final_text,
        changed=final_text != original,
        pii_detected=bool(pii_categories),
        secrets_detected=bool(secret_categories),
        method=method,
        categories=categories,
    )


# ---------------------------------------------------------------------------
# Secret sanitization
# ---------------------------------------------------------------------------


def _secret_sanitize(
    text: str,
) -> tuple[str, list[str]]:
    """Replace deterministic secret patterns."""

    sanitized = text

    categories: list[str] = []

    for (
        category,
        pattern,
        replacement,
    ) in SECRET_PATTERNS:

        sanitized, count = pattern.subn(
            replacement,
            sanitized,
        )

        if count:
            categories.append(category)

    return sanitized, categories


# ---------------------------------------------------------------------------
# DataFrame sanitization
# ---------------------------------------------------------------------------


def sanitize_dataframe(df):
    """Return a sanitized copy of an Excel dataframe.

    The original dataframe is never mutated.
    """

    output = df.copy()

    for column in output.columns:

        output[column] = output[column].map(
            lambda value: value if _is_missing(value) else sanitize_text(value).text
        )

    return output


# ---------------------------------------------------------------------------
# Missing-value helper
# ---------------------------------------------------------------------------


def _is_missing(
    value: Any,
) -> bool:
    """Safely determine whether a value is missing."""

    try:
        import pandas as pd

        return bool(pd.isna(value))

    except Exception:
        return value is None


# ---------------------------------------------------------------------------
# API response sanitization
# ---------------------------------------------------------------------------


def sanitize_response_payload(
    value: Any,
) -> tuple[Any, list[str]]:
    """Sanitize string values in an API response.

    The original response shape is preserved.
    """

    categories: list[str] = []

    # String
    if isinstance(value, str):

        safe = sanitize_text(value)

        return (
            safe.text,
            safe.categories,
        )

    # List
    if isinstance(value, list):

        output = []

        for item in value:

            clean, found = sanitize_response_payload(item)

            output.append(clean)

            categories.extend(found)

        return (
            output,
            categories,
        )

    # Dictionary
    if isinstance(value, dict):

        output = {}

        for key, item in value.items():

            clean, found = sanitize_response_payload(item)

            output[key] = clean

            categories.extend(found)

        return (
            output,
            categories,
        )

    # Other types remain unchanged.
    return value, categories


# ---------------------------------------------------------------------------
# Security status
# ---------------------------------------------------------------------------


def security_status() -> dict[str, Any]:
    """Return the current sanitization/security capabilities."""

    presidio_ready = False
    presidio_error = None

    if _PRESIDIO_IMPORTS_AVAILABLE:

        try:
            analyzer, anonymizer = _presidio_engines()

            if analyzer is not None:
                presidio_ready = True

            else:
                presidio_error = (
                    "Presidio is installed, but the local "
                    "spaCy model 'en_core_web_sm' is not installed. "
                    "Regex fallback is active."
                )

        except Exception as exc:

            presidio_error = str(exc)

    else:

        presidio_error = "Presidio is not installed. " "Regex fallback is active."

    return {
        "presidio_installed": (_PRESIDIO_IMPORTS_AVAILABLE),
        "presidio_ready": presidio_ready,
        "presidio_error": presidio_error,
        "pii_entities": PII_ENTITIES,
        "secret_detection": True,
        "masking": True,
        "fallback_enabled": True,
        "runtime_model_download": False,
    }
