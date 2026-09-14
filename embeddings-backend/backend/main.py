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

BASE_DIR = Path(__file__).resolve().parents[1]
DATASETS_DIR = Path(os.getenv("FOREMAN_DATASETS_DIR", str(BASE_DIR / "datasets")))
DATASETS_DIR.mkdir(parents=True, exist_ok=True)
COLLECTION_PREFIX = os.getenv("CHROMA_COLLECTION_PREFIX", "foreman_")

app = FastAPI(
    title="Foreman Knowledge API",
    version="1.0.0",
    description="Upload an Excel knowledge base, ingest it into ChromaDB, and query it through hybrid RAG.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ALLOW_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class QueryRequest(BaseModel):
    question: str = Field(min_length=1)
    top_k: int = Field(default=6, ge=1, le=30)
    graph_depth: int = Field(default=2, ge=1, le=10)

class IntakeRequest(BaseModel):
    text: str = Field(min_length=1)
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


@app.post("/datasets", status_code=202)
async def upload_dataset(background_tasks: BackgroundTasks, file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith((".xlsx", ".xls")):
        raise HTTPException(status_code=400, detail="Upload an Excel .xlsx or .xls dataset")

    dataset_id, paths = manager.create(file.filename)
    try:
        with paths["excel"].open("wb") as handle:
            shutil.copyfileobj(file.file, handle)
    except Exception:
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
    return {
        "dataset_id": dataset_id,
        "query": request.query,
        "results": searcher.search(request.query, top_k=request.top_k),
    }


@app.post("/datasets/{dataset_id}/rag/query")
def rag_query(dataset_id: str, request: QueryRequest):
    searcher = manager.searcher(dataset_id)
    rag = ForemanRAG(
        top_k=request.top_k,
        graph_depth=request.graph_depth,
        searcher=searcher,
    )
    answer = rag.answer(request.question)
    return {
        "dataset_id": dataset_id,
        "question": request.question,
        "answer": answer,
    }


@app.post("/datasets/{dataset_id}/intake")
def intake(dataset_id: str, request: IntakeRequest):
    searcher = manager.searcher(dataset_id)
    processor = IntakeProcessor(top_k=request.top_k, searcher=searcher)
    return processor.process(request.text)
