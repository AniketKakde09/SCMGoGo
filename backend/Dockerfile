FROM python:3.11-slim

# Prevent Python from writing pyc files and buffer flushing
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# Install system dependencies commonly required for scientific and image/PDF libs
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       build-essential \
       gcc \
       libgl1 \
       libglib2.0-0 \
       libsm6 \
       libxrender1 \
       libxext6 \
       curl \
    && rm -rf /var/lib/apt/lists/*

# Copy the application code
COPY . .

# Copy requirements and install (use the API-specific requirements)
RUN pip install --no-cache-dir -r requirements-api.txt

# Default datasets dir (mounted from host via docker-compose)
ENV FOREMAN_DATASETS_DIR=/app/datasets

EXPOSE 8000

# Run uvicorn; module path points at backend.main:app
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
