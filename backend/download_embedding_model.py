"""Download an embedding model once and save it to a local folder.

Run this ONE time (with network access):

    python download_embedding_model.py

Then set this in your .env:

    EMBEDDING_MODEL=./models/all-MiniLM-L6-v2

From that point on, ingest.py and search.py (via search.get_embedding_model)
load the model straight from disk — sentence-transformers never contacts the
Hugging Face Hub, because EMBEDDING_MODEL is a filesystem path rather than a
Hub repo id.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from sentence_transformers import SentenceTransformer

DEFAULT_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
DEFAULT_OUTPUT = Path(__file__).resolve().parent / "models" / "all-MiniLM-L6-v2"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Download a sentence-transformers model and save it locally."
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help="Hugging Face model id to download (default: %(default)s)",
    )
    parser.add_argument(
        "--out",
        default=str(DEFAULT_OUTPUT),
        help="Local folder to save the model into (default: %(default)s)",
    )
    args = parser.parse_args()

    out_path = Path(args.out).resolve()
    out_path.mkdir(parents=True, exist_ok=True)

    print(f"Downloading '{args.model}' (this needs network access, one time only)...")
    model = SentenceTransformer(args.model)
    model.save(str(out_path))

    print(f"\nSaved to: {out_path}")
    print("Add this to your .env to use it with zero Hugging Face calls from now on:\n")
    print(f"    EMBEDDING_MODEL={out_path}\n")


if __name__ == "__main__":
    main()
