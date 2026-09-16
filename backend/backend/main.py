from __future__ import annotations

import json
import os
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from ingest import ingest
from intake import IntakeProcessor
from rag import ForemanRAG
from search import ForemanSearch
from forecast import generate_forecast
from canvas import build_canvas_graph
from jira_sync import router as jira_router
from security import sanitize_response_payload, sanitize_text, security_status

BASE_DIR = Path(__file__).resolve().parents[1]
DATASETS_DIR = Path(os.getenv("FOREMAN_DATASETS_DIR", str(BASE_DIR / "datasets")))
DATASETS_DIR.mkdir(parents=True, exist_ok=True)
COLLECTION_PREFIX = os.getenv("CHROMA_COLLECTION_PREFIX", "foreman_")

app = FastAPI(
    title="Foreman Knowledge API",
    version="1.0.0",
    description="Upload an Excel knowledge base, ingest it into ChromaDB, query it through hybrid RAG, and generate dataset-driven OR-Tools delivery forecasts.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ALLOW_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Jira sync endpoints (/api/jira/health, /api/jira/sync, /api/jira/sync/{job_id}/events)
app.include_router(jira_router)

class QueryRequest(BaseModel):
    question: str = Field(min_length=1)
    top_k: int = Field(default=6, ge=1, le=30)
    graph_depth: int = Field(default=2, ge=1, le=10)

class IntakeRequest(BaseModel):
    text: str = Field(min_length=1)
    top_k: int = Field(default=8, ge=1, le=30)

class IntakeConversationRequest(BaseModel):
    message: str = Field(min_length=1)
    history: list[dict[str, str]] = Field(default_factory=list)
    top_k: int = Field(default=8, ge=1, le=30)

class SearchRequest(BaseModel):
    query: str = Field(min_length=1)
    top_k: int = Field(default=5, ge=1, le=30)

class DatasetManager:
    def __init__(self):
        self._locks: dict[str, threading.RLock] = {}
        self._registry_lock = threading.RLock()

    def lock(self, dataset_id: str) -> threading.RLock:
        with self._registry_lock:
            return self._locks.setdefault(dataset_id, threading.RLock())

    def root(self, dataset_id: str) -> Path:
        return DATASETS_DIR / dataset_id

    def paths(self, dataset_id: str) -> dict[str, Path]:
        root = self.root(dataset_id)
        # dataset.xlsx is always the sanitized workbook. The raw upload is
        # never retained on disk after the upload request completes.
        return {
            "root": root,
            "excel": root / "dataset.xlsx",
            "chroma": root / "chroma",
            "graph": root / "dependency_graph.graphml",
            "metadata": root / "metadata.json",
        }

    def read_metadata(self, dataset_id: str) -> dict[str, Any]:
        path = self.paths(dataset_id)["metadata"]
        if not path.exists():
            raise HTTPException(status_code=404, detail="Dataset not found")
        return json.loads(path.read_text(encoding="utf-8"))

    def write_metadata(self, dataset_id: str, data: dict[str, Any]) -> None:
        self.paths(dataset_id)["metadata"].write_text(
            json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
        )

    def create(self, filename: str) -> tuple[str, dict[str, Path]]:
        dataset_id = uuid.uuid4().hex
        paths = self.paths(dataset_id)
        paths["root"].mkdir(parents=True, exist_ok=False)
        now = datetime.now(timezone.utc).isoformat()
        self.write_metadata(dataset_id, {
            "dataset_id": dataset_id,
            "filename": filename,
            "status": "uploaded",
            "created_at": now,
            "updated_at": now,
            "collection_name": COLLECTION_PREFIX + dataset_id,
            "sanitized": False,
        })
        return dataset_id, paths

    def update_status(self, dataset_id: str, status: str, **extra: Any) -> None:
        metadata = self.read_metadata(dataset_id)
        metadata.update(status=status, updated_at=datetime.now(timezone.utc).isoformat(), **extra)
        self.write_metadata(dataset_id, metadata)

    def searcher(self, dataset_id: str) -> ForemanSearch:
        paths = self.paths(dataset_id)
        metadata = self.read_metadata(dataset_id)
        if metadata.get("status") != "ready":
            raise HTTPException(status_code=409, detail=f"Dataset is not ready: {metadata.get('status')}")
        return ForemanSearch(
            excel_path=paths["excel"],
            chroma_path=paths["chroma"],
            graph_path=paths["graph"],
            collection_name=metadata["collection_name"],
        )

manager = DatasetManager()


def ingest_dataset(dataset_id: str) -> None:
    paths = manager.paths(dataset_id)
    metadata = manager.read_metadata(dataset_id)
    lock = manager.lock(dataset_id)
    with lock:
        manager.update_status(dataset_id, "ingesting", error=None)
        try:
            # New uploads are sanitized before they reach this background
            # task. For older dataset workspaces created before the
            # sanitized-only storage change, migrate dataset.xlsx in place
            # once before indexing so a legacy raw workbook cannot be
            # accidentally ingested.
            if not metadata.get("sanitized", False):
                from ingest import sanitize_workbook
                migration_path = paths["root"] / ".sanitize_migration.xlsx"
                sanitize_workbook(paths["excel"], migration_path)
                os.replace(migration_path, paths["excel"])
                metadata = manager.read_metadata(dataset_id)
                metadata["sanitized"] = True
                metadata["updated_at"] = datetime.now(timezone.utc).isoformat()
                manager.write_metadata(dataset_id, metadata)

            result = ingest(
                reset=True,
                excel_path=paths["excel"],
                chroma_path=paths["chroma"],
                graph_path=paths["graph"],
                collection_name=metadata["collection_name"],
            )
            manager.update_status(
                dataset_id,
                "ready",
                document_count=result.get("document_count"),
                graph=result.get("graph"),
            )
        except Exception as exc:
            manager.update_status(dataset_id, "failed", error=str(exc))


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/security/status")
def security():
    return security_status()


@app.post("/datasets", status_code=202)
async def upload_dataset(background_tasks: BackgroundTasks, file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith((".xlsx", ".xls")):
        raise HTTPException(status_code=400, detail="Upload an Excel .xlsx or .xls dataset")

    dataset_id, paths = manager.create(file.filename)
    temp_upload = paths["root"] / f".raw_upload{Path(file.filename).suffix.lower()}"
    try:
        # Write the upload only to a temporary file, sanitize it, then keep
        # only the sanitized workbook as dataset.xlsx.
        with temp_upload.open("wb") as handle:
            shutil.copyfileobj(file.file, handle)

        from ingest import sanitize_workbook
        sanitize_workbook(temp_upload, paths["excel"])
        temp_upload.unlink(missing_ok=True)

        metadata = manager.read_metadata(dataset_id)
        metadata["sanitized"] = True
        metadata["sanitized_at"] = datetime.now(timezone.utc).isoformat()
        metadata["updated_at"] = datetime.now(timezone.utc).isoformat()
        manager.write_metadata(dataset_id, metadata)
    except Exception:
        temp_upload.unlink(missing_ok=True)
        shutil.rmtree(paths["root"], ignore_errors=True)
        raise

    background_tasks.add_task(ingest_dataset, dataset_id)
    return {
        "dataset_id": dataset_id,
        "status": "ingesting",
        "message": "Dataset uploaded. Ingestion is running in the background.",
    }


@app.post("/datasets/{dataset_id}/ingest", status_code=202)
def reingest_dataset(dataset_id: str, background_tasks: BackgroundTasks):
    manager.read_metadata(dataset_id)
    background_tasks.add_task(ingest_dataset, dataset_id)
    return {"dataset_id": dataset_id, "status": "ingesting"}


@app.get("/datasets/{dataset_id}")
def dataset_status(dataset_id: str):
    return manager.read_metadata(dataset_id)


@app.post("/datasets/{dataset_id}/search")
def semantic_search(dataset_id: str, request: SearchRequest):
    searcher = manager.searcher(dataset_id)
    safe = sanitize_text(request.query)
    return {
        "dataset_id": dataset_id,
        "query": safe.text,
        "results": searcher.search(safe.text, top_k=request.top_k),
        "security": {"sanitized": safe.changed, "categories": safe.categories},
    }


@app.post("/datasets/{dataset_id}/rag/query")
def rag_query(dataset_id: str, request: QueryRequest):
    searcher = manager.searcher(dataset_id)
    rag = ForemanRAG(
        top_k=request.top_k,
        graph_depth=request.graph_depth,
        searcher=searcher,
    )
    safe = sanitize_text(request.question)
    answer = rag.answer(safe.text)
    safe_answer = sanitize_text(answer)
    return {
        "dataset_id": dataset_id,
        "question": safe.text,
        "answer": safe_answer.text,
        "security": {
            "sanitized": safe.changed or safe_answer.changed,
            "input_categories": safe.categories,
            "output_categories": safe_answer.categories,
        },
    }


@app.get("/datasets/{dataset_id}/canvas")
def canvas(dataset_id: str):
    """Return the SAD -> Epic -> Issue hierarchy plus issue dependencies."""
    paths = manager.paths(dataset_id)
    metadata = manager.read_metadata(dataset_id)
    if metadata.get("status") != "ready":
        raise HTTPException(status_code=409, detail=f"Dataset is not ready: {metadata.get('status')}")
    source_excel = paths["excel"]
    if not source_excel.exists():
        raise HTTPException(status_code=404, detail="Dataset Excel file not found")
    try:
        return {"dataset_id": dataset_id, **build_canvas_graph(source_excel)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Canvas graph generation failed: {exc}") from exc


@app.post("/datasets/{dataset_id}/forecast")
def forecast(dataset_id: str):
    """Generate a dataset-driven velocity + OR-Tools delivery forecast for all teams."""
    paths = manager.paths(dataset_id)
    metadata = manager.read_metadata(dataset_id)
    if metadata.get("status") != "ready":
        raise HTTPException(status_code=409, detail=f"Dataset is not ready: {metadata.get('status')}")
    source_excel = paths["excel"]
    if not source_excel.exists():
        raise HTTPException(status_code=404, detail="Dataset Excel file not found")
    try:
        result = generate_forecast(source_excel)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Forecast generation failed: {exc}") from exc
    return {"dataset_id": dataset_id, **result}


@app.post("/datasets/{dataset_id}/intake")
def intake(dataset_id: str, request: IntakeRequest):
    searcher = manager.searcher(dataset_id)
    processor = IntakeProcessor(top_k=request.top_k, searcher=searcher)
    safe = sanitize_text(request.text)
    result = processor.process(safe.text)
    clean_result, output_categories = sanitize_response_payload(result)
    if isinstance(clean_result, dict):
        clean_result["security"] = {
            "sanitized": safe.changed or bool(output_categories),
            "input_categories": safe.categories,
            "output_categories": sorted(set(output_categories)),
        }
    return clean_result

@app.post("/datasets/{dataset_id}/intake/conversation")
def intake_conversation(dataset_id: str, request: IntakeConversationRequest):
    searcher = manager.searcher(dataset_id)
    processor = IntakeProcessor(top_k=request.top_k, searcher=searcher)
    safe_history = []
    history_changed = False
    history_categories = []
    for item in request.history:
        safe_item = {}
        for key, value in item.items():
            safe = sanitize_text(value)
            safe_item[key] = safe.text
            history_changed = history_changed or safe.changed
            history_categories.extend(safe.categories)
        safe_history.append(safe_item)
    safe_message = sanitize_text(request.message)
    result = processor.process_conversation(safe_history, safe_message.text)
    clean_result, output_categories = sanitize_response_payload(result)
    if isinstance(clean_result, dict):
        clean_result["security"] = {
            "sanitized": history_changed or safe_message.changed or bool(output_categories),
            "input_categories": sorted(set(history_categories + safe_message.categories)),
            "output_categories": sorted(set(output_categories)),
        }
    return clean_result
