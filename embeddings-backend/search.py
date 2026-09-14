from __future__ import annotations

import os
from pathlib import Path

import chromadb
import networkx as nx
from sentence_transformers import SentenceTransformer
import pandas as pd

from graph import load_graph

BASE_DIR = Path(__file__).resolve().parent
EXCEL_PATH = BASE_DIR / "data" / "Foreman_Synthetic_Dataset.xlsx"
CHROMA_PATH = BASE_DIR / "vectorstore" / "chroma"
GRAPH_PATH = BASE_DIR / "vectorstore" / "dependency_graph.graphml"
COLLECTION_NAME = os.getenv("CHROMA_COLLECTION", "foreman_knowledge")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")

_MODEL_CACHE: dict[str, SentenceTransformer] = {}


def get_embedding_model(model_name: str = EMBEDDING_MODEL) -> SentenceTransformer:
    model = _MODEL_CACHE.get(model_name)
    if model is None:
        model = SentenceTransformer(model_name)
        _MODEL_CACHE[model_name] = model
    return model


class ForemanSearch:
    def __init__(
        self,
        excel_path: Path | str = EXCEL_PATH,
        chroma_path: Path | str = CHROMA_PATH,
        graph_path: Path | str = GRAPH_PATH,
        collection_name: str = COLLECTION_NAME,
    ):
        self.excel_path = Path(excel_path)
        self.chroma_path = Path(chroma_path)
        self.graph_path = Path(graph_path)
        self.collection_name = collection_name
        self.graph = load_graph(self.graph_path, self.excel_path)
        self.backlog = pd.read_excel(self.excel_path, sheet_name="Backlog").fillna("")
        self.sad_sections = pd.read_excel(self.excel_path, sheet_name="SAD_Sections").fillna("")
        self.client = chromadb.PersistentClient(path=str(self.chroma_path))
        self.collection = self.client.get_collection(self.collection_name)
        self.model = get_embedding_model()

    def ticket(self, ticket_id: str):
        rows = self.backlog[self.backlog["TicketID"].astype(str).str.strip().str.upper() == ticket_id.upper()]
        if rows.empty:
            return None
        row = rows.iloc[0]
        return {k: ("" if pd.isna(v) else str(v).strip()) for k, v in row.items()}

    def dependencies(self, ticket_id: str, max_depth: int = 3):
        from graph import dependency_chain
        return dependency_chain(ticket_id, graph=self.graph, max_depth=max_depth)

    def blocking_candidates(self, ticket_id: str):
        from graph import blocking_candidates
        return blocking_candidates(ticket_id, graph=self.graph)

    def reverse_dependents(self, ticket_id: str):
        from graph import reverse_dependents
        return reverse_dependents(ticket_id, graph=self.graph)

    def cycles_for(self, ticket_id: str):
        return [c for c in nx.simple_cycles(self.graph) if ticket_id.upper() in [x.upper() for x in c]]

    def all_cycles(self):
        return list(nx.simple_cycles(self.graph))

    def sad_ids_from_results(self, results):
        ids = []
        for result in results:
            sid = result.get("metadata", {}).get("sad_section_id")
            if sid and sid not in ids:
                ids.append(sid)
        return ids

    def tickets_for_sad_sections(self, sad_ids):
        mask = self.backlog["SADSectionID"].astype(str).str.strip().isin(sad_ids)
        return self.backlog.loc[mask, "TicketID"].astype(str).str.strip().tolist()

    def search(self, query: str, top_k: int = 5, where: dict | None = None):
        query_embedding = self.model.encode([query], normalize_embeddings=True).tolist()
        kwargs = {
            "query_embeddings": query_embedding,
            "n_results": top_k,
            "include": ["documents", "metadatas", "distances"],
        }
        if where:
            kwargs["where"] = where
        result = self.collection.query(**kwargs)

        output = []
        documents = result.get("documents", [[]])[0]
        metadatas = result.get("metadatas", [[]])[0]
        distances = result.get("distances", [[]])[0]
        ids = result.get("ids", [[]])[0]
        for doc_id, text, metadata, distance in zip(ids, documents, metadatas, distances):
            output.append({"id": doc_id, "text": text, "metadata": metadata, "distance": distance})
        return output
