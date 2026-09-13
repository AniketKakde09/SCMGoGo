// =========================================================
// Foreman (backend) analysis API client
// =========================================================
//
// This talks to the Python Foreman decision-support service, which is
// mounted inside the main backend at the /foreman prefix (see
// backend/app.py -> app.mount("/foreman", foreman_app)). It is a
// completely separate thing from src/utils/foremanDataset.js, which
// does a lighter, client-side-only analysis for the Canvas board.
//
// Override the backend origin with a Vite env var if needed:
//   VITE_API_BASE_URL=http://localhost:8000
// =========================================================

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";
const FOREMAN_PREFIX = "/foreman";

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${FOREMAN_PREFIX}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
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
      `Foreman request failed: ${response.status}`;
    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
  }

  return data;
}

// Loads the bundled synthetic dataset on the backend. The dataset lives
// in server memory, so this must succeed before any read endpoint works.
export function loadForemanDataset() {
  return request("/api/dataset/load", { method: "POST" });
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
