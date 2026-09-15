# Foreman Knowledge API

The project is now exposed as a backend service. A client uploads an Excel dataset, the API creates an isolated dataset workspace, ingests it into ChromaDB, builds the NetworkX dependency graph, and then exposes semantic search, hybrid RAG, and generic intake endpoints.

## Architecture

```text
Client / Frontend
       |
       v
    FastAPI
       |
       +--> POST /datasets
       |       |
       |       +--> datasets/<dataset_id>/dataset.xlsx
       |       +--> Sentence Transformers -> ChromaDB
       |       +--> Pandas -> structured workbook access
       |       +--> NetworkX -> dependency graph
       |
       +--> POST /datasets/{id}/search
       +--> POST /datasets/{id}/rag/query
       +--> POST /datasets/{id}/intake
       +--> GET  /datasets/{id}
```

Every uploaded dataset has its own Chroma collection and dependency graph, so multiple datasets can coexist.

## Run

```bash
pip install -r requirements-api.txt
cp .env.example .env
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

Swagger UI:

```text
http://localhost:8000/docs
```

## API flow

### 1. Upload dataset

```bash
curl -X POST http://localhost:8000/datasets \
  -F "file=@data/Foreman_Synthetic_Dataset.xlsx"
```

Response:

```json
{
  "dataset_id": "...",
  "status": "ingesting"
}
```

### 2. Poll ingestion status

```bash
curl http://localhost:8000/datasets/<dataset_id>
```

Wait until `status` is `ready`.

### 3. Ask RAG

```bash
curl -X POST http://localhost:8000/datasets/<dataset_id>/rag/query \
  -H 'Content-Type: application/json' \
  -d '{"question":"What is blocking the authentication work?"}'
```

### 4. Generic intake

```bash
curl -X POST http://localhost:8000/datasets/<dataset_id>/intake \
  -H 'Content-Type: application/json' \
  -d '{"text":"Make it possible for a customer to book a service in under two minutes."}'
```

### 5. Direct semantic search

```bash
curl -X POST http://localhost:8000/datasets/<dataset_id>/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"booking availability"}'
```

## Jira sync

The API also exposes Jira Server sync endpoints (ported from the previous backend), mounted under `/api/jira`:

- `GET  /api/jira/health` — reports whether the Jira integration is reachable/configured.
- `POST /api/jira/sync` — accepts `{"issues": [...]}` (epics/stories/tasks/sub-tasks/other), creates them in Jira in dependency order (Epics → Stories → Tasks/Sub-tasks → other), and returns `{"jobId": "...", "status": "started"}` immediately while the sync runs in a background thread.
- `GET  /api/jira/sync/{job_id}/events` — Server-Sent Events stream of live progress (`syncing`, `created`, `skipped`, `failed`, `completed`, `job_failed`) for a sync job started above.

Configure via environment variables before starting the server:

```bash
JIRA_URL=https://your-jira-server.example.com/jira
JIRA_USER_ID=your-jira-username
JIRA_API_TOKEN=your-jira-password-or-token
JIRA_PROJECT_KEY=YOUR_PROJECT_KEY

# Optional: override if your Jira instance uses different custom field IDs
JIRA_EPIC_NAME_FIELD=customfield_10002
JIRA_EPIC_LINK_FIELD=customfield_10000
JIRA_STORY_POINTS_FIELD=customfield_10006
JIRA_SPRINT_FIELD=customfield_10004
JIRA_ACCEPTANCE_CRITERIA_FIELD=customfield_10335
```

`JIRA_URL`, `JIRA_USER_ID`, `JIRA_API_TOKEN`, and `JIRA_PROJECT_KEY` are required — `POST /api/jira/sync` will fail fast with a clear error if any are missing at sync time. Existing dataset/RAG/forecast endpoints are untouched by this addition.

## Important production note

This version is a clean single-service MVP. For production, move background ingestion to a worker/queue (Celery, RQ, Dramatiq, or a managed job system), store dataset metadata in PostgreSQL instead of JSON files, and put Chroma persistence on durable shared storage. The API contract can remain unchanged.
