# Foreman Knowledge — Frontend

A React + Vite + React Flow frontend, restyled from the original
ScrumMasterGoGo PI-planning UI, rebuilt to talk to the new **Foreman
Knowledge API** backend (`backend/main.py`) instead of the old
Jira-sync backend.

## Pages

1. **/signin** — sign-in shell (same visual language as before).
2. **/start** — upload a new dataset, reopen your last dataset, or
   open one by ID.
3. **/upload** — uploads an `.xlsx`/`.xls` workbook to `POST /datasets`
   and polls `GET /datasets/{id}` until ingestion finishes.
4. **/canvas** — the interactive canvas:
   - Runs `POST /datasets/{id}/forecast` and lays out the result as a
     React Flow graph: one dark **Team** card per team, connected to a
     chain of light **Sprint** cards (capacity, utilization, scheduled
     tickets), ending in an amber **Unscheduled backlog** card when
     not everything fit the forecast horizon.
   - Double-click any card to open a detail panel (velocity, risks,
     backlog, ticket list, holiday adjustments...).
   - Top-right toolbar: re-ingest the dataset, re-run the forecast,
     and open **Ask** (hybrid RAG chat via `/rag/query`), **Search**
     (semantic search via `/search`), and **Intake** (free-form triage
     via `/intake`) as slide-in panels.
   - Top-left stat strip is clickable and opens the raw forecast JSON.

## Run

```bash
npm install
npm run dev
```

By default the app calls the backend directly at
`http://localhost:8000` (CORS is already open there — see
`backend/main.py`). Override with a `.env` file:

```
VITE_API_BASE_URL=http://localhost:8000
```

Start the backend separately, per `README_API.md`:

```bash
pip install -r requirements-api.txt
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```
