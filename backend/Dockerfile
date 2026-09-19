# ---------- Build stage ----------
FROM python:3.11-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# System packages required to build Python dependencies
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        gcc \
    && rm -rf /var/lib/apt/lists/*

# Create isolated Python environment
RUN python -m venv /opt/venv

ENV PATH="/opt/venv/bin:$PATH"

# Copy dependency file first for Docker layer caching
COPY requirements*.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements-api.txt


# ---------- Runtime stage ----------
FROM python:3.11-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH" \
    FOREMAN_DATASETS_DIR=/app/datasets

WORKDIR /app

# Runtime libraries
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
        libsm6 \
        libxrender1 \
        libxext6 \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Copy Python virtual environment
COPY --from=builder /opt/venv /opt/venv

# Copy entire application
COPY . .

# Create application user
RUN useradd --create-home --uid 10001 appuser \
    && mkdir -p /app/datasets \
    && chown -R appuser:appuser /app

# Run as non-root
USER appuser

EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s \
            --timeout=5s \
            --start-period=10s \
            --retries=3 \
    CMD curl --fail http://127.0.0.1:8000/health || exit 1

# Start FastAPI application
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]