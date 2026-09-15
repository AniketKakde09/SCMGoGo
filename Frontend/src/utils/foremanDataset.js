import bundledDataset from "../data/foremanDataset.json";

const SHEET_MAP = {
  Backlog: "backlog",
  Dependencies: "dependencies",
  SAD_Sections: "sadSections",
  Sprints: "sprints",
  Teams: "teams",
  TeamMembers: "teamMembers",
  Holidays: "holidays",
  ChangeRequests: "changeRequests",
  Intake_Samples: "intakeSamples",
};

function cleanCell(value) {
  if (value === undefined || value === null || value === "") return null;
  return value;
}

function normalizeKeys(row) {
  return Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [String(key).trim(), cleanCell(value)]));
}

export function getBundledForemanDataset() {
  return JSON.parse(JSON.stringify(bundledDataset));
}

export async function parseForemanWorkbook(file) {
  if (!file) throw new Error("Choose an .xlsx file first.");
  const XLSX = await import("xlsx");
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", cellDates: false });
  const result = { source: file.name };

  for (const [sheetName, targetKey] of Object.entries(SHEET_MAP)) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      result[targetKey] = [];
      continue;
    }
    result[targetKey] = XLSX.utils.sheet_to_json(sheet, { defval: null }).map(normalizeKeys);
  }

  validateForemanDataset(result);
  return result;
}

export function validateForemanDataset(dataset) {
  const problems = [];
  if (!Array.isArray(dataset?.backlog) || dataset.backlog.length === 0) {
    problems.push("Backlog sheet is missing or empty.");
  }
  const first = dataset?.backlog?.[0] || {};
  for (const required of ["TicketID", "Type", "Title"]) {
    if (!(required in first)) problems.push(`Backlog.${required} is required.`);
  }
  if (problems.length) throw new Error(problems.join(" "));
  return true;
}

export function analyzeForemanDataset(dataset) {
  const backlog = dataset?.backlog || [];
  const dependencies = dataset?.dependencies || [];
  const sadSections = dataset?.sadSections || [];
  const sprints = dataset?.sprints || [];
  const teamMembers = dataset?.teamMembers || [];
  const holidays = dataset?.holidays || [];

  const byId = new Map(backlog.map((item) => [item.TicketID, item]));
  const sadIds = new Set(sadSections.map((item) => item.SectionID));
  const sprintById = new Map(sprints.map((item) => [item.SprintID, item]));
  const findings = [];

  const add = (finding) => findings.push({ severity: "warning", ...finding });

  for (const item of backlog) {
    if (["Story", "Task"].includes(item.Type) && Number(item.StoryPoints || 0) <= 0) {
      add({ category: "readiness", code: "missing-estimate", severity: "error", ticketId: item.TicketID, title: "Missing estimate", detail: `${item.TicketID} has no usable story-point estimate.` });
    }
    if (["Story", "Task"].includes(item.Type) && String(item.HasAcceptanceCriteria || "N").toUpperCase() !== "Y") {
      add({ category: "readiness", code: "missing-ac", ticketId: item.TicketID, title: "Missing acceptance criteria", detail: `${item.TicketID} is not refinement-ready because acceptance criteria are missing.` });
    }
    if (["Story", "Task"].includes(item.Type) && String(item.HasDoD || "N").toUpperCase() !== "Y") {
      add({ category: "readiness", code: "missing-dod", ticketId: item.TicketID, title: "Missing Definition of Done", detail: `${item.TicketID} is missing DoD confirmation.` });
    }
    if (item.ParentID && !byId.has(item.ParentID)) {
      add({ category: "hierarchy", code: "orphan-parent", severity: "error", ticketId: item.TicketID, title: "Broken parent", detail: `${item.TicketID} references ${item.ParentID}, which does not exist.` });
    }
    if (["Epic", "Feature"].includes(item.Type) && item.SADSectionID && !sadIds.has(item.SADSectionID)) {
      add({ category: "traceability", code: "invalid-sad", severity: "error", ticketId: item.TicketID, title: "Invalid S-AD mapping", detail: `${item.TicketID} references ${item.SADSectionID}, which is not in SAD_Sections.` });
    }
  }

  const graph = new Map();
  const validDependencies = [];
  for (const dep of dependencies) {
    const from = dep.FromTicketID;
    const to = dep["ToTicketID (depends on)"] ?? dep.ToTicketID;
    if (!byId.has(from) || !byId.has(to)) {
      add({ category: "dependency", code: "orphan-dependency", severity: "error", ticketId: byId.has(from) ? from : null, title: "Broken dependency", detail: `${dep.DependencyID}: ${from} depends on ${to}, but an endpoint is missing.` });
      continue;
    }
    if (!graph.has(from)) graph.set(from, []);
    graph.get(from).push(to);
    validDependencies.push({ ...dep, from, to });

    const fromSprint = sprintById.get(byId.get(from)?.SprintID);
    const toSprint = sprintById.get(byId.get(to)?.SprintID);
    if (fromSprint && toSprint) {
      const fromStart = String(fromSprint.StartDate || "");
      const toStart = String(toSprint.StartDate || "");
      if (fromStart && toStart && fromStart < toStart) {
        add({ category: "dependency", code: "dependency-inversion", severity: "error", ticketId: from, title: "Dependency scheduled too late", detail: `${from} is scheduled before prerequisite ${to}.` });
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const cycleSignatures = new Set();
  function dfs(node, stack) {
    if (visiting.has(node)) {
      const idx = stack.indexOf(node);
      const cycle = [...stack.slice(idx), node];
      const signature = [...new Set(cycle)].sort().join("|");
      if (!cycleSignatures.has(signature)) {
        cycleSignatures.add(signature);
        add({ category: "dependency", code: "cycle", severity: "error", ticketId: node, ticketIds: [...new Set(cycle)], title: "Circular dependency", detail: cycle.join(" → ") });
      }
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    stack.push(node);
    for (const next of graph.get(node) || []) dfs(next, stack);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  }
  for (const node of graph.keys()) dfs(node, []);

  for (const sprint of sprints) {
    const capacity = Number(sprint.PlannedCapacityPts || 0);
    const committed = Number(sprint.CommittedPts || 0);
    if (capacity > 0 && committed > capacity) {
      add({ category: "capacity", code: "over-capacity", severity: "error", ticketId: null, sprintId: sprint.SprintID, title: "Sprint over capacity", detail: `${sprint.SprintName || sprint.SprintID}: ${committed} pts committed vs ${capacity} pts capacity.` });
    }
  }

  for (const member of teamMembers) {
    if (Number(member.AllocationPct || 0) > 100) {
      add({ category: "capacity", code: "over-allocation", ticketId: null, title: "Team member over-allocated", detail: `${member.Name || member.MemberID} is allocated at ${member.AllocationPct}%.` });
    }
  }

  for (const holiday of holidays) {
    for (const sprint of sprints) {
      if (holiday.ImpactedTeamID !== sprint.TeamID) continue;
      const date = String(holiday.Date || "");
      if (date && date >= String(sprint.StartDate || "") && date <= String(sprint.EndDate || "")) {
        add({ category: "capacity", code: "holiday-in-sprint", ticketId: null, sprintId: sprint.SprintID, title: "Holiday affects sprint capacity", detail: `${holiday.HolidayName} (${date}) falls inside ${sprint.SprintName || sprint.SprintID}.` });
      }
    }
  }

  const healthByTicket = new Map();
  for (const finding of findings) {
    for (const ticketId of finding.ticketIds || (finding.ticketId ? [finding.ticketId] : [])) {
      if (!healthByTicket.has(ticketId)) healthByTicket.set(ticketId, []);
      healthByTicket.get(ticketId).push(finding);
    }
  }

  return { findings, healthByTicket, validDependencies };
}

export function buildCanvasIssues(dataset, analysis = analyzeForemanDataset(dataset)) {
  const backlog = dataset?.backlog || [];
  const byId = new Map(backlog.map((item) => [item.TicketID, item]));
  const memberById = new Map((dataset?.teamMembers || []).map((m) => [m.MemberID, m]));
  const sadById = new Map((dataset?.sadSections || []).map((s) => [s.SectionID, s]));

  const orphaned = backlog.filter((item) => item.ParentID && !byId.has(item.ParentID));
  const orphanIds = new Set(orphaned.map((item) => item.TicketID));
  const issues = [];

  if (orphaned.length) {
    issues.push({
      issue_type: "Epic",
      summary: "Unmapped / Orphaned Work",
      description: "Foreman holding area for tickets whose parent reference cannot be resolved.",
      nodeId: "FOREMAN-ORPHANS",
      jiraKey: null,
      changeState: "new",
      sad_section_id: "",
      priority: "High",
      status: "Needs refinement",
      sourceOrigin: "foreman",
      healthWarnings: ["Broken hierarchy"],
    });
  }

  for (const item of backlog) {
    const parent = item.ParentID ? byId.get(item.ParentID) : null;
    const health = analysis.healthByTicket.get(item.TicketID) || [];
    const acceptanceCriteria = String(item.HasAcceptanceCriteria || "N").toUpperCase() === "Y"
      ? ["Acceptance criteria present in source backlog"]
      : [];
    const sad = sadById.get(item.SADSectionID);
    issues.push({
      issue_type: item.Type,
      summary: item.Title,
      description: sad?.Summary || `${item.Layer || "Delivery"} backlog item imported from ${dataset.source || "Excel"}.`,
      nodeId: item.TicketID,
      jiraKey: item.TicketID,
      changeState: "existing",
      parent: orphanIds.has(item.TicketID) ? "Unmapped / Orphaned Work" : parent?.Title || "",
      originalParentId: item.ParentID || null,
      sad_section_id: item.SADSectionID || "",
      sadSectionTitle: sad?.SectionTitle || "",
      story_points: item.StoryPoints,
      priority: item.Priority || "Medium",
      status: item.Status || "To Do",
      sprint: item.SprintID || "",
      sprintId: item.SprintID || "",
      assignee: memberById.get(item.AssigneeID)?.Name || item.AssigneeID || "",
      assigneeId: item.AssigneeID || "",
      acceptance_criteria: acceptanceCriteria,
      hasDoD: String(item.HasDoD || "N").toUpperCase() === "Y",
      hasAcceptanceCriteria: String(item.HasAcceptanceCriteria || "N").toUpperCase() === "Y",
      layer: item.Layer || "",
      labels: item.Labels || "",
      createdDate: item.CreatedDate || "",
      sourceOrigin: "dataset",
      healthWarnings: health.map((f) => f.title),
    });
  }
  return issues;
}

export function getDatasetSummary(dataset, analysis = analyzeForemanDataset(dataset)) {
  const backlog = dataset?.backlog || [];
  const count = (type) => backlog.filter((item) => item.Type === type).length;
  return {
    total: backlog.length,
    epics: count("Epic"),
    features: count("Feature"),
    stories: count("Story"),
    tasks: count("Task"),
    dependencies: (dataset?.dependencies || []).length,
    findings: analysis.findings.length,
    errors: analysis.findings.filter((f) => f.severity === "error").length,
  };
}
