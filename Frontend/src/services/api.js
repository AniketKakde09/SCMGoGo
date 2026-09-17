// =========================================================
// Foreman Knowledge API client
//
// Mirrors backend/main.py exactly:
//   POST /datasets                          upload + kick off ingestion
//   POST /datasets/{id}/ingest              re-run ingestion
//   GET  /datasets/{id}                     dataset status/metadata
//   POST /datasets/{id}/search               semantic search
//   POST /datasets/{id}/rag/query            hybrid RAG question answering
//   POST /datasets/{id}/forecast             velocity + OR-Tools forecast
//   POST /datasets/{id}/intake               free-form intake triage
// =========================================================

const API_BASE_URL =
  import.meta.env?.VITE_API_BASE_URL || "http://localhost:8000";

async function parseJsonSafe(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, options);
  const data = await parseJsonSafe(response);

  if (!response.ok) {
    const message =
      (data && (data.detail || data.message || data.error)) ||
      `Request failed: ${response.status}`;
    const error = new Error(
      typeof message === "string" ? message : JSON.stringify(message),
    );
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

// ---------------------------------------------------------
// Health
// ---------------------------------------------------------

export function getHealth() {
  return request("/health");
}

// ---------------------------------------------------------
// Datasets
// ---------------------------------------------------------

export async function uploadDataset(file, { onProgress } = {}) {
  const formData = new FormData();
  formData.append("file", file);

  // Use XHR (not fetch) only so we can report upload progress on the
  // dropzone; falls back cleanly if progress isn't needed.
  if (typeof onProgress === "function") {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API_BASE_URL}/datasets`);

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          onProgress(Math.round((event.loaded / event.total) * 100));
        }
      };

      xhr.onload = () => {
        let data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          data = null;
        }

        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
        } else {
          const message =
            (data && (data.detail || data.message)) ||
            `Upload failed: ${xhr.status}`;
          reject(new Error(message));
        }
      };

      xhr.onerror = () => reject(new Error("Network error during upload."));

      xhr.send(formData);
    });
  }

  return request("/datasets", {
    method: "POST",
    body: formData,
  });
}

export function getDatasetStatus(datasetId) {
  return request(`/datasets/${datasetId}`);
}

export function reingestDataset(datasetId) {
  return request(`/datasets/${datasetId}/ingest`, { method: "POST" });
}

/**
 * Poll a dataset's status until it reaches "ready" or "failed".
 * Resolves with the final metadata object, or rejects if the dataset
 * fails to ingest.
 */
export function waitForDatasetReady(
  datasetId,
  { intervalMs = 1800, timeoutMs = 5 * 60 * 1000, onTick } = {},
) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    async function poll() {
      try {
        const metadata = await getDatasetStatus(datasetId);
        if (onTick) onTick(metadata);

        if (metadata.status === "ready") {
          resolve(metadata);
          return;
        }

        if (metadata.status === "failed") {
          reject(new Error(metadata.error || "Dataset ingestion failed."));
          return;
        }

        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error("Timed out waiting for dataset ingestion."));
          return;
        }

        setTimeout(poll, intervalMs);
      } catch (err) {
        reject(err);
      }
    }

    poll();
  });
}

// ---------------------------------------------------------
// Search / RAG / Intake / Forecast
// ---------------------------------------------------------

export function searchDataset(datasetId, query, topK = 5) {
  return request(`/datasets/${datasetId}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, top_k: topK }),
  });
}

export function askRag(datasetId, question, { topK = 6, graphDepth = 2 } = {}) {
  return request(`/datasets/${datasetId}/rag/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question,
      top_k: topK,
      graph_depth: graphDepth,
    }),
  });
}

export function runIntake(datasetId, text, topK = 8) {
  return request(`/datasets/${datasetId}/intake`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, top_k: topK }),
  });
}

export function runIntakeConversation(datasetId, message, history = [], topK = 8) {
  return request(`/datasets/${datasetId}/intake/conversation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history, top_k: topK }),
  });
}

export function generateForecast(datasetId) {
  return request(`/datasets/${datasetId}/forecast`, { method: "POST" });
}

export function getCanvasGraph(datasetId) {
  return request(`/datasets/${datasetId}/canvas`);
}

export { API_BASE_URL };

// ---------------------------------------------------------
// Jira publishing (human-approved Playground drafts)
// ---------------------------------------------------------

export function getJiraHealth() {
  return request("/api/jira/health");
}

export function startJiraSync(issues) {
  return request("/api/jira/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ issues }),
  });
}

export function watchJiraSync(jobId, { onEvent, onError } = {}) {
  const source = new EventSource(`${API_BASE_URL}/api/jira/sync/${jobId}/events`);
  source.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      onEvent?.(payload);
      if (["completed", "job_failed"].includes(payload.status)) source.close();
    } catch (error) {
      onError?.(error);
    }
  };
  source.onerror = (error) => {
    source.close();
    onError?.(error);
  };
  return () => source.close();
}

// SAD proposal generation; these endpoints never create Jira issues.
export function generateSADText(datasetId, text, title) {
  return request(`/datasets/${encodeURIComponent(datasetId)}/sad/generate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, title }),
  });
}
export function generateSADFile(datasetId, file) {
  const body = new FormData(); body.append("file", file);
  return request(`/datasets/${encodeURIComponent(datasetId)}/sad/upload`, { method: "POST", body });
}
