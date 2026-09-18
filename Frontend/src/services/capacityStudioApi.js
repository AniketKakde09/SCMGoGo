import { API_BASE_URL } from "./api";

async function call(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE_URL}/api/capacity${path}`, {
      ...options,
      headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
    });
  } catch {
    throw new Error("Capacity API is unreachable. Check that FastAPI is running and Patch 1 is registered.");
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.detail || payload?.message || `HTTP ${response.status}`;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return payload;
}
export const getCapacityMembers = (datasetId) => call(`/${encodeURIComponent(datasetId)}/members`);
export const saveCapacityMember = (datasetId, member) => call(`/${encodeURIComponent(datasetId)}/members/${encodeURIComponent(member.member_id)}`, { method: "PUT", body: JSON.stringify(member) });
export const getCapacityScenarios = (datasetId) => call(`/${encodeURIComponent(datasetId)}/scenarios`);
export const createCapacityScenario = (datasetId, scenario) => call(`/${encodeURIComponent(datasetId)}/scenarios`, { method: "POST", body: JSON.stringify(scenario) });
export const updateCapacityScenario = (datasetId, id, scenario) => call(`/${encodeURIComponent(datasetId)}/scenarios/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(scenario) });
