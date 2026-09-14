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

## Important production note

This version is a clean single-service MVP. For production, move background ingestion to a worker/queue (Celery, RQ, Dramatiq, or a managed job system), store dataset metadata in PostgreSQL instead of JSON files, and put Chroma persistence on durable shared storage. The API contract can remain unchanged.
