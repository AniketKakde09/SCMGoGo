from __future__ import annotations

"""Lightweight PII and secret sanitization boundary.

Uses Microsoft Presidio directly when available. Presidio is intentionally kept
outside the LLM stack: this module only detects and replaces sensitive values.
A deterministic regex layer remains active for secrets and Indian identifiers.
If the Presidio NLP model is not installed, the regex layer still protects the
most common sensitive values and reports the active method in the result.
"""

import re
import uuid
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from presidio_analyzer import (
    AnalyzerEngine,
    RecognizerRegistry,
)
from presidio_analyzer.nlp_engine import (
    NlpEngineProvider,
)

from typing import Any



try:
    from presidio_analyzer import AnalyzerEngine
    from presidio_anonymizer import AnonymizerEngine
    from presidio_anonymizer.entities import OperatorConfig

    _PRESIDIO_IMPORTS_AVAILABLE = True
except Exception:  # pragma: no cover - depends on deployment environment
    AnalyzerEngine = None
    AnonymizerEngine = None
    OperatorConfig = None
    _PRESIDIO_IMPORTS_AVAILABLE = False


# Keep Scrum/business identifiers and planning fields intact. In particular we
# intentionally do not mask generic LOCATION or DATE_TIME values because the
# forecasting and planning features use them.
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

# Technical and Agile terms that spaCy/Presidio frequently misidentifies as PERSON.
# These will be explicitly filtered out from PII masking.
EXCLUDED_PERSON_TERMS = {
    "sad", "api", "ui", "ux", "jira", "epic", "story", "feature", 
    "task", "bug", "subtask", "kanban", "scrum", "backlog", "sprint"
}
JIRA_KEY_PATTERN = re.compile(r"\b[A-Z]+-\d+\b")


@dataclass
class SanitizationResult:
    text: str
    changed: bool
    pii_detected: bool = False
    secrets_detected: bool = False
    method: str = "regex-fallback"
    categories: list[str] = field(default_factory=list)


# Secrets are not PII, so they get their own deterministic boundary.
SECRET_PATTERNS: list[tuple[str, re.Pattern[str], str]] = [
    ("AWS_ACCESS_KEY", re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "<SECRET_AWS_ACCESS_KEY>"),
    ("BEARER_TOKEN", re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{12,}"), "Bearer <SECRET_TOKEN>"),
    ("JWT", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"), "<SECRET_JWT>"),
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
        re.compile(r"(?i)(\b(?:password|passwd|pwd)\s*[:=]\s*)([^\s,;]+)"),
        r"\1<SECRET_PASSWORD>",
    ),
    (
        "API_KEY_ASSIGNMENT",
        re.compile(
            r"(?i)(\b(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|secret[_ -]?key)"
            r"\s*[:=]\s*)([^\s,;]+)"
        ),
        r"\1<SECRET_VALUE>",
    ),
    (
        "CONNECTION_STRING",
        re.compile(r"(?i)\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis)://[^\s]+"),
        "<SECRET_CONNECTION_STRING>",
    ),
]

# Deterministic patterns supplement Presidio, especially for Indian identifiers
# and secrets. These are deliberately conservative.
FALLBACK_PII_PATTERNS: list[tuple[str, re.Pattern[str], str]] = [
    ("EMAIL_ADDRESS", re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I), "<EMAIL_ADDRESS>"),
    (
        "PHONE_NUMBER",
        re.compile(r"(?<!\w)(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}(?!\w)"),
        "<PHONE_NUMBER>",
    ),
    ("IN_PAN", re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b", re.I), "<IN_PAN>"),
    ("IN_AADHAAR", re.compile(r"(?<!\d)\d{4}[ -]?\d{4}[ -]?\d{4}(?!\d)"), "<IN_AADHAAR>"),
    ("CREDIT_CARD", re.compile(r"(?<!\d)(?:\d[ -]?){13,19}(?!\d)"), "<CREDIT_CARD>"),
]


# @lru_cache(maxsize=1)
# def _presidio_engines():
#     """Create Presidio engines once per worker, lazily."""
#     if not _PRESIDIO_IMPORTS_AVAILABLE:
#         return None, None
#     return AnalyzerEngine(), AnonymizerEngine()



@lru_cache(maxsize=1)
def _presidio_engines():
    """Create Presidio engines using the installed small spaCy model."""

    if not _PRESIDIO_IMPORTS_AVAILABLE:
        return None, None

    configuration = {
        "nlp_engine_name": "spacy",
        "models": [
            {
                "lang_code": "en",
                "model_name": "en_core_web_sm"
            }
        ]
    }

    provider = NlpEngineProvider(
        nlp_configuration=configuration
    )

    nlp_engine = provider.create_engine()

    registry = RecognizerRegistry()
    registry.load_predefined_recognizers(
        nlp_engine=nlp_engine
    )

    analyzer = AnalyzerEngine(
        registry=registry,
        nlp_engine=nlp_engine,
        supported_languages=["en"]
    )

    anonymizer = AnonymizerEngine()

    return analyzer, anonymizer




def _get_unique_placeholder(entity_type: str, mapping: dict[str, str], original_value: str) -> str:
    """Generate or retrieve a unique placeholder per unique entity value with a UUID hex snippet."""
    key = f"{entity_type}:{original_value}"
    if key not in mapping:
        unique_id = uuid.uuid4().hex[:6]
        mapping[key] = f"<{entity_type}_{unique_id}>"
    return mapping[key]


def sanitize_text(text: Any) -> SanitizationResult:
    """Sanitize user/dataset text with unique IDs, filtering out false-positive technical terms."""
    original = "" if text is None else str(text)
    if not original:
        return SanitizationResult(text="", changed=False, method="none")

    method = "regex-fallback"
    spans: list[tuple[int, int, str]] = []  # (start, end, entity_type)
    pii_categories: set[str] = set()
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
                    matched_value = original[res.start:res.end]
                    cleaned_val_lower = matched_value.strip().lower()

                    # Filter out false-positive PERSON detections for Jira keys, SAD, Epics, Stories, etc.
                    if res.entity_type == "PERSON":
                        if JIRA_KEY_PATTERN.match(matched_value) or cleaned_val_lower in EXCLUDED_PERSON_TERMS:
                            continue
                        # Ignore single-character 'names' or obvious non-name artifacts
                        if len(matched_value.strip()) <= 1:
                            continue

                    spans.append((res.start, res.end, res.entity_type))
                    pii_categories.add(res.entity_type)
        except Exception:
            method = "regex-fallback-after-presidio-error"

    # Fallback / additional regex patterns
    for category, pattern, _ in FALLBACK_PII_PATTERNS:
        for match in pattern.finditer(original):
            start, end = match.span()
            # Avoid overlaps with existing presidio spans
            if not any(s <= start < e or s < end <= e for s, e, _ in spans):
                spans.append((start, end, category))
                pii_categories.add(category)

    # Sort spans in reverse order of start index to safely replace from back to front
    spans.sort(key=lambda x: x[0], reverse=True)

    placeholder_mapping: dict[str, str] = {}
    working_text = original

    for start, end, entity_type in spans:
        matched_value = working_text[start:end]
        placeholder = _get_unique_placeholder(entity_type, placeholder_mapping, matched_value)
        working_text = working_text[:start] + placeholder + working_text[end:]

    # Run secret sanitization (deterministic regex boundary)
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


def _secret_sanitize(text: str) -> tuple[str, list[str]]:
    sanitized = text
    categories: list[str] = []
    for category, pattern, replacement in SECRET_PATTERNS:
        sanitized, count = pattern.subn(replacement, sanitized)
        if count:
            categories.append(category)
    return sanitized, categories


def sanitize_dataframe(df):
    """Return a sanitized copy of an Excel dataframe without mutating input."""
    output = df.copy()
    for column in output.columns:
        output[column] = output[column].map(
            lambda value: value if _is_missing(value) else sanitize_text(value).text
        )
    return output


def _is_missing(value: Any) -> bool:
    try:
        import pandas as pd
        return bool(pd.isna(value))
    except Exception:
        return value is None


def sanitize_response_payload(value: Any) -> tuple[Any, list[str]]:
    """Sanitize string values in an API response without changing its shape."""
    categories: list[str] = []
    if isinstance(value, str):
        safe = sanitize_text(value)
        return safe.text, safe.categories
    if isinstance(value, list):
        output = []
        for item in value:
            clean, found = sanitize_response_payload(item)
            output.append(clean)
            categories.extend(found)
        return output, categories
    if isinstance(value, dict):
        output = {}
        for key, item in value.items():
            clean, found = sanitize_response_payload(item)
            output[key] = clean
            categories.extend(found)
        return output, categories
    return value, categories


def security_status() -> dict[str, Any]:
    presidio_ready = False
    presidio_error = None
    if _PRESIDIO_IMPORTS_AVAILABLE:
        try:
            _presidio_engines()
            presidio_ready = True
        except Exception as exc:
            presidio_error = str(exc)

    return {
        "presidio_installed": _PRESIDIO_IMPORTS_AVAILABLE,
        "presidio_ready": presidio_ready,
        "presidio_error": presidio_error,
        "pii_entities": PII_ENTITIES,
        "secret_detection": True,
        "masking": True,
        "fallback_enabled": True,
    }