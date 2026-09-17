# Security / PII Sanitization

The application uses a lightweight security boundary based on **Microsoft Presidio** instead of the full Guardrails AI framework.

## What is protected

Incoming dataset cells and user text are sanitized before they reach ChromaDB, RAG, Intake, Forecast/Canvas processing, or an LLM.

PII categories include:

- PERSON
- EMAIL_ADDRESS
- PHONE_NUMBER
- CREDIT_CARD
- IBAN_CODE
- selected US identifiers
- Indian PAN / Aadhaar / passport / vehicle registration / voter identifiers
- IP_ADDRESS

A deterministic secret layer also masks common:

- AWS access keys
- Bearer tokens
- JWTs
- private keys
- passwords
- API keys / access tokens / client secrets
- database connection strings

Business identifiers such as Jira ticket IDs, Epic IDs, SAD IDs, sprint IDs and planning dates are intentionally preserved.

## Installation

The required Python packages are already in `requirements.txt`.

```bash
pip install -r requirements.txt
```

Presidio's analyzer uses spaCy as its default NLP engine. The small English model must be available for PERSON detection:

```bash
python -m spacy download en_core_web_sm
```

If the model is not installed, the application still starts and uses its deterministic fallback for email, phone, Indian identifiers and secrets. The `/security/status` endpoint shows whether Presidio is ready.

## Verify security setup

```bash
python test_security.py
```

```bash
curl http://localhost:8000/security/status
```

A ready installation should report:

```json
{
  "presidio_installed": true,
  "presidio_ready": true,
  "secret_detection": true,
  "masking": true
}
```

## Runtime flow

```text
Raw input
   |
   v
Presidio + deterministic secret detector
   |
   v
Sanitized input
   |
   +--> Search
   +--> RAG
   +--> Intake
   +--> ChromaDB ingestion
   +--> Canvas / Forecast
   |
   v
LLM
```

The uploaded workbook is sanitized immediately during upload. Only the sanitized workbook is retained as `datasets/<dataset_id>/dataset.xlsx`; the raw upload is written only to a temporary file during sanitization and is deleted immediately afterward. Downstream Search, RAG, Intake, Canvas, Forecast, ChromaDB, and the dependency graph use only the sanitized workbook. Existing dataset workspaces created before this change are migrated in place on their next ingestion before indexing.

## Output protection

RAG and Intake responses are sanitized again before they are returned to the frontend. This protects against an LLM or downstream component reproducing sensitive values.

The API reports only entity categories (for example `EMAIL_ADDRESS` or `PHONE_NUMBER`) and never logs or returns the original matched value.
