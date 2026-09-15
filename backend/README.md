# Foreman Knowledge — Generic Intake + Hybrid Vector / Graph RAG

This project uses the original **Sentence Transformers + ChromaDB** approach and adds **NetworkX** for exact dependency reasoning plus an optional provider-neutral LLM layer.

## Architecture

```text
                 Foreman Excel
                      |
          +-----------+-----------+
          |                       |
          v                       v
  Semantic records          Dependencies
          |                       |
          v                       v
Sentence Transformers        NetworkX
          |                       |
          v                       v
       ChromaDB              Dependency Graph
          |                       |
          +-----------+-----------+
                      |
                      v
              Generic Intake
                      |
             Evidence package
                      |
              Optional LLM
          /                    \
       Groq                  Bedrock
```

### Design principle

**The intake processor is generic.** It does not hardcode business domains, actors, capabilities, keywords, SAD IDs, ticket IDs, or expected request types. Any free-form intake is treated as input and matched against the knowledge base using semantic retrieval and exact graph/Excel evidence.

The LLM is an interpretation layer, not the source of truth.

## Install

```bash
pip install -r requirements.txt
```

Copy `.env.example` to `.env` and configure the provider you want. Never commit real API keys.

### Embedding model / Hugging Face downloads

`EMBEDDING_MODEL` (default `sentence-transformers/all-MiniLM-L6-v2`) is pulled
from the Hugging Face Hub the first time it's used, then cached under
`~/.cache/huggingface`. After that, `search.get_embedding_model()` (used by
both `ingest.py` and `search.py`) loads it from cache with `HF_HUB_OFFLINE=1`
automatically — no network call, no warning, no rate limiting. You don't need
to configure anything for this.

If you'd rather skip Hugging Face entirely — not even the automatic cache
check — download the model to a local folder once and point `EMBEDDING_MODEL`
at that folder instead of the Hub repo id:

```bash
python download_embedding_model.py
```

Then in `.env`:

```bash
EMBEDDING_MODEL=./models/all-MiniLM-L6-v2
```

Because that's a filesystem path rather than a Hub repo id, `sentence-transformers`
never talks to Hugging Face again — this is the same model already used by
default, just loaded from disk. Useful for air-gapped environments or if you
want a fully reproducible, network-independent setup.

## Build the knowledge base

```bash
python ingest.py
```

This creates/updates:

- `vectorstore/chroma/`
- `vectorstore/dependency_graph.graphml`

The graph convention is:

```text
A -> B
```

meaning **A depends on B**.

## Generic intake

You can submit any free-form text:

```bash
python intake.py "Make it possible for a customer to book a service in under two minutes."
```

Or from a file:

```bash
python intake.py --file intake.txt --json
```

The processor produces:

- semantic retrieval results
- architecture/SAD matches discovered from the data
- related ticket candidates
- semantic overlap candidates
- exact dependency impacts from NetworkX
- dependency cycles touching retrieved tickets
- optional LLM classification/interpretation

The processor deliberately does **not** label a semantic match as a duplicate or blocker without supporting evidence.

## LLM providers

Set:

```dotenv
LLM_PROVIDER=groq
```

and provide:

```dotenv
GROQ_API_KEY=your-key
GROQ_MODEL=llama-3.3-70b-versatile
```

Or use AWS Bedrock:

```dotenv
LLM_PROVIDER=bedrock
AWS_REGION=us-east-1
BEDROCK_MODEL=amazon.nova-micro-v1:0
```

For Bedrock, `boto3` uses the normal AWS credential chain/environment configuration.

Disable LLM interpretation with:

```dotenv
LLM_PROVIDER=none
```

When disabled, the application still performs semantic retrieval and exact structured/graph analysis.

## Existing RAG queries

The existing hybrid RAG interface remains available:

```bash
python rag.py "What is blocking the authentication work?"
python rag.py "Is there a dependency cycle involving T-188?"
```

For exact dependency questions, NetworkX is used instead of relying only on semantic similarity.

## Important evidence rule

Semantic retrieval tells Foreman what may be relevant. It does not prove a dependency, blocker, or duplicate.

For example, a semantically relevant ticket with no corresponding row in the `Dependencies` sheet is not reported as an explicit dependency.
