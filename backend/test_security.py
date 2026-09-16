from __future__ import annotations

import pandas as pd

from security.sanitizer import sanitize_dataframe, sanitize_response_payload, sanitize_text, security_status


def test_pii_and_secret_masking():
    text = (
        "Create a story for John Smith. Email john.smith@example.com, "
        "phone +91 9876543210. API_KEY=sk-test-secret. "
        "Sprint 2 starts 2026-07-21 and ticket PAY-1234."
    )
    result = sanitize_text(text)
    assert result.changed
    assert "john.smith@example.com" not in result.text
    assert "9876543210" not in result.text
    assert "sk-test-secret" not in result.text
    assert "2026-07-21" in result.text
    assert "PAY-1234" in result.text
    assert result.secrets_detected


def test_secret_variants():
    text = (
        "Authorization: Bearer abcdefghijklmnop "
        "JWT=eyJabcdefgh.ijklmnop.qrstuvwx "
        "password=super-secret "
        "postgresql://user:secret@db.example.com/app"
    )
    result = sanitize_text(text)
    assert "abcdefghijklmnop" not in result.text
    assert "eyJabcdefgh.ijklmnop.qrstuvwx" not in result.text
    assert "super-secret" not in result.text
    assert "postgresql://user:secret@db.example.com/app" not in result.text
    assert result.secrets_detected


def test_business_text_is_preserved():
    result = sanitize_text("EPIC-01 Cloud Landing Zone Sprint 2 PAY-1234")
    assert result.text == "EPIC-01 Cloud Landing Zone Sprint 2 PAY-1234"
    assert not result.changed


def test_planning_dates_and_ticket_ids_survive():
    result = sanitize_text("Sprint 2 runs from 2026-07-21 to 2026-08-04 for PAY-1234")
    assert "2026-07-21" in result.text
    assert "2026-08-04" in result.text
    assert "PAY-1234" in result.text


def test_dataframe_is_not_mutated_and_business_ids_survive():
    original = pd.DataFrame({
        "Name": ["Alice Example"],
        "Email": ["alice@example.com"],
        "Sprint": ["2026-07-21"],
        "Ticket": ["PAY-1234"],
    })
    sanitized = sanitize_dataframe(original)
    assert original.loc[0, "Email"] == "alice@example.com"
    assert sanitized.loc[0, "Email"] != "alice@example.com"
    assert sanitized.loc[0, "Sprint"] == "2026-07-21"
    assert sanitized.loc[0, "Ticket"] == "PAY-1234"


def test_nested_response_sanitization():
    clean, categories = sanitize_response_payload({
        "message": "Contact John Smith at john@example.com",
        "ticket": "PAY-1234",
        "nested": ["phone +91 9876543210"],
    })
    assert "john@example.com" not in clean["message"]
    assert "9876543210" not in clean["nested"][0]
    assert clean["ticket"] == "PAY-1234"
    assert categories


def test_security_status():
    status = security_status()
    assert status["secret_detection"] is True
    assert status["masking"] is True
    assert "PERSON" in status["pii_entities"]
    assert "presidio_installed" in status
    assert "presidio_ready" in status


def test_dataset_storage_contract():
    """Upload code keeps only dataset.xlsx after temporary sanitization."""
    from pathlib import Path

    main_source = Path(__file__).parent / "backend" / "main.py"
    source = main_source.read_text(encoding="utf-8")
    assert '"sanitized_excel"' not in source
    assert 'temp_upload = paths["root"] / f".raw_upload{Path(file.filename).suffix.lower()}"' in source
    assert 'sanitize_workbook(temp_upload, paths["excel"])' in source
    assert 'temp_upload.unlink(missing_ok=True)' in source



if __name__ == "__main__":
    tests = [
        test_pii_and_secret_masking,
        test_secret_variants,
        test_business_text_is_preserved,
        test_planning_dates_and_ticket_ids_survive,
        test_dataframe_is_not_mutated_and_business_ids_survive,
        test_nested_response_sanitization,
        test_security_status,
        test_dataset_storage_contract,
    ]
    for test in tests:
        test()
        print(f"PASS: {test.__name__}")
