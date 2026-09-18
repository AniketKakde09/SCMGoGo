
// Override the backend origin with a Vite env var if needed:
//   VITE_API_BASE_URL=http://localhost:8000
// =========================================================

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";
const FOREMAN_PREFIX = "/foreman";

async function request(path, options = {}) {
  // Don't force a JSON content-type onto FormData uploads — the browser
  // needs to set its own multipart boundary.
  const isFormData = options.body instanceof FormData;

  const response = await fetch(`${API_BASE_URL}${FOREMAN_PREFIX}${path}`, {
    ...options,
    headers: isFormData
      ? { ...options.headers }
      : { "Content-Type": "application/json", ...options.headers },
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message =
      (data && (data.detail || data.message)) ||
      `GOGO request failed: ${response.status}`;
    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
  }

  return data;
}

// Checks whether a dataset is currently loaded in the backend, without
// loading or changing anything. Used to decide whether to show the report
// or the empty/upload state on page load.
export function getForemanDatasetStatus() {
  return request("/api/dataset/status");
}

// Loads the bundled synthetic (sample) dataset on the backend. Only ever
// called when the user explicitly asks to try sample data — never on page
// load — so the report page starts empty until real data exists.
export function loadForemanSampleDataset() {
  return request("/api/dataset/load", { method: "POST" });
}

// Uploads a user's own .xlsx workbook to the backend.
export function uploadForemanDataset(file) {
  const formData = new FormData();
  formData.append("file", file);

  return request("/api/dataset/upload", {
    method: "POST",
    headers: {}, // let the browser set the multipart boundary
    body: formData,
  });
}

// Clears the currently loaded dataset so the UI can return to the empty
// state (e.g. "Use a different dataset").
export function clearForemanDataset() {
  return request("/api/dataset/clear", { method: "POST" });
}

// One-shot endpoint: health issues, dependency graph, readiness,
// forecast, sprint plan, and human decisions in a single response.
export function runForemanAnalysis(timeLimitSeconds = 10) {
  return request(`/api/agent/run?time_limit_seconds=${timeLimitSeconds}`, {
    method: "POST",
  });
}

export function getForemanBacklog() {
  return request("/api/backlog");
}
