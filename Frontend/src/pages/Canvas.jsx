import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";

import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  Panel,
  Handle,
  Position,
  ConnectionMode,
  useNodesState,
  useEdgesState,
  MarkerType,
  BaseEdge,
  getSmoothStepPath,
  useReactFlow,
  ReactFlowProvider,
  MiniMap,
} from "@xyflow/react";

import "@xyflow/react/dist/style.css";
import "../App.css";

import {
  getDatasetStatus,
  waitForDatasetReady,
  reingestDataset,
  generateForecast,
  getCanvasGraph,
  searchDataset,
  askRag,
  runIntake,
} from "../services/api";

// =========================================================
// Layout Constants
// =========================================================

const TEAM_WIDTH = 280;
const TEAM_HEIGHT = 230;
const SPRINT_WIDTH = 250;
const SPRINT_HEIGHT = 210;
const REMAINING_WIDTH = 190;
const H_GAP = 70;
const ROW_GAP = 90;

// Cap how many future sprints we draw per team so a long generated
// horizon (up to 12 synthetic sprints) doesn't stretch the canvas
// into an unreadable strip. We always stop at the team's projected
// completion sprint when one exists.
const MAX_SPRINTS_SHOWN = 6;

// =========================================================
// Helpers
// =========================================================

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function statusClass(status) {
  const s = String(status || "").toLowerCase();
  if (["done", "completed", "closed"].includes(s)) return "status-done";
  if (s === "blocked") return "status-blocked";
  if (["to do", "in progress", "open", "reopened"].includes(s)) return "status-active";
  return "status-other";
}

function relevantSprints(team) {
  const calendar = team.forecast_calendar || [];
  const completionId = team.forecast?.completion_sprint;

  if (completionId) {
    const idx = calendar.findIndex((s) => s.sprint_id === completionId);
    if (idx >= 0) {
      return calendar.slice(0, idx + 1);
    }
  }

  return calendar.slice(0, Math.min(calendar.length, MAX_SPRINTS_SHOWN));
}

function makeEdge(source, target, state) {
  const color =
    state === "warning" ? "#EA580C" : state === "active" ? "#334155" : "#94A3B8";

  return {
    id: `${source}->${target}`,
    source,
    target,
    type: "flow",
    data: { state },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color,
    },
  };
}


function buildObstacleAwareRoute(sourceId, targetId, sourceX, sourceY, targetX, targetY, flowNodes) {
  const MARGIN = 24;
  const sourceNode = flowNodes.find((n) => n.id === sourceId);
  const targetNode = flowNodes.find((n) => n.id === targetId);

  const rects = flowNodes
    .filter((n) => n.id !== sourceId && n.id !== targetId)
    .map((n) => {
      const w = Number(n.measured?.width || n.width || n.style?.width || 0);
      const h = Number(n.measured?.height || n.height || n.style?.height || 0);
      return {
        left: n.position.x - MARGIN,
        right: n.position.x + w + MARGIN,
        top: n.position.y - MARGIN,
        bottom: n.position.y + h + MARGIN,
      };
    })
    .filter((r) => r.right > r.left && r.bottom > r.top);

  if (!sourceNode || !targetNode || !rects.length) {
    return [[sourceX, sourceY], [targetX, targetY]];
  }

  const xs = new Set([sourceX, targetX]);
  const ys = new Set([sourceY, targetY]);
  rects.forEach((r) => {
    xs.add(r.left); xs.add(r.right);
    ys.add(r.top); ys.add(r.bottom);
  });

  const xList = [...xs].sort((a, b) => a - b);
  const yList = [...ys].sort((a, b) => a - b);
  const key = (x, y) => `${x}|${y}`;

  const blockedPoint = (x, y) => rects.some((r) => x > r.left && x < r.right && y > r.top && y < r.bottom);
  const blockedSegment = (x1, y1, x2, y2) => {
    if (x1 !== x2 && y1 !== y2) return true;
    return rects.some((r) => {
      if (y1 === y2) {
        const y = y1;
        return y > r.top && y < r.bottom && Math.max(Math.min(x1, x2), r.left) < Math.min(Math.max(x1, x2), r.right);
      }
      const x = x1;
      return x > r.left && x < r.right && Math.max(Math.min(y1, y2), r.top) < Math.min(Math.max(y1, y2), r.bottom);
    });
  };

  const start = [sourceX, sourceY];
  const goal = [targetX, targetY];
  const startKey = key(...start);
  const goalKey = key(...goal);
  const open = [{ x: sourceX, y: sourceY, dir: -1, g: 0, f: Math.abs(sourceX - targetX) + Math.abs(sourceY - targetY), path: [start] }];
  const best = new Map();

  while (open.length) {
    open.sort((a, b) => a.f - b.f);
    const current = open.shift();
    const stateKey = `${key(current.x, current.y)}|${current.dir}`;
    if (best.has(stateKey) && best.get(stateKey) <= current.g) continue;
    best.set(stateKey, current.g);

    if (key(current.x, current.y) === goalKey) {
      const raw = current.path;
      const simplified = [];
      raw.forEach((p) => {
        const prev = simplified[simplified.length - 1];
        const prev2 = simplified[simplified.length - 2];
        if (prev && prev2) {
          const collinear = (prev2[0] === prev[0] && prev[0] === p[0]) || (prev2[1] === prev[1] && prev[1] === p[1]);
          if (collinear) {
            simplified[simplified.length - 1] = p;
            return;
          }
        }
        simplified.push(p);
      });
      return simplified;
    }

    const xi = xList.indexOf(current.x);
    const yi = yList.indexOf(current.y);
    const neighbors = [
      xi > 0 ? [xList[xi - 1], current.y, 0] : null,
      xi < xList.length - 1 ? [xList[xi + 1], current.y, 1] : null,
      yi > 0 ? [current.x, yList[yi - 1], 2] : null,
      yi < yList.length - 1 ? [current.x, yList[yi + 1], 3] : null,
    ].filter(Boolean);

    for (const [nx, ny, dir] of neighbors) {
      if (blockedPoint(nx, ny) || blockedSegment(current.x, current.y, nx, ny)) continue;
      const bendPenalty = current.dir !== -1 && current.dir !== dir ? 90 : 0;
      const g = current.g + Math.abs(nx - current.x) + Math.abs(ny - current.y) + bendPenalty;
      const f = g + Math.abs(nx - targetX) + Math.abs(ny - targetY);
      open.push({ x: nx, y: ny, dir, g, f, path: [...current.path, [nx, ny]] });
    }
  }

  // Guaranteed fallback: route in a dedicated corridor outside the issue area.
  const corridorY = Math.min(...rects.map((r) => r.top)) - 70;
  return [[sourceX, sourceY], [sourceX, corridorY], [targetX, corridorY], [targetX, targetY]];
}

function buildDiagram(canvasGraph, handlers, expandedEpicIds = new Set()) {
  const nodes = [];
  const edges = [];
  const sadSections = canvasGraph?.sad_sections || [];
  const epics = canvasGraph?.epics || [];
  const issues = canvasGraph?.issues || [];
  const allItems = [...epics, ...issues];
  const itemById = new Map(allItems.map((item) => [String(item.id), item]));
  const sadById = new Map(sadSections.map((sad) => [String(sad.id), sad]));

  // Backend hierarchy remains authoritative. The visual layout below is a
  // compact tidy-tree: parents are centred over their children and only leaf
  // nodes consume vertical rows. This removes the large blank areas produced
  // by the old "one row per node" DFS layout on 100+ ticket datasets.
  const children = new Map();
  const link = (source, target) => {
    if (!source || !target) return;
    source = String(source);
    target = String(target);
    if (!children.has(source)) children.set(source, []);
    if (!children.get(source).includes(target)) children.get(source).push(target);
  };

  epics.forEach((epic) => link(epic.sad_section_id || epic.sadSectionId, epic.id));
  issues.forEach((issue) => {
    const parent = getIssueParentId(issue);
    if (parent && itemById.has(String(parent))) link(parent, issue.id);
    else link(issue.sad_section_id || issue.sadSectionId, issue.id);
  });

  // Compact dimensions are intentional: the full 171-ticket workbook should
  // have a useful overview, while clicking a node still opens the full editor.
  const DEPTH_GAP = 250;
  const CARD_WIDTH = 210;
  const CARD_HEIGHT = 78;
  const ARCH_WIDTH = 220;
  const ARCH_HEIGHT = 88;
  const LEAF_GAP = 18;
  const TREE_GAP = 52;
  const ROW_STEP = CARD_HEIGHT + LEAF_GAP;

  const positioned = new Set();
  const positionById = new Map();
  let nextLeafY = 0;

  const descendantCount = (id, seen = new Set()) => {
    id = String(id);
    if (seen.has(id)) return 0;
    const nextSeen = new Set(seen);
    nextSeen.add(id);
    return (children.get(id) || []).reduce(
      (total, child) => total + 1 + descendantCount(child, nextSeen),
      0,
    );
  };

  const pushNode = (id, depth, y) => {
    const x = Math.max(0, depth) * DEPTH_GAP;
    if (sadById.has(id)) {
      const sad = sadById.get(id);
      nodes.push({
        id,
        type: "sad",
        position: { x, y },
        data: { sad, onOpen: handlers.onOpenSad },
        draggable: true,
        style: { width: ARCH_WIDTH, height: ARCH_HEIGHT },
      });
      return;
    }

    const item = itemById.get(id);
    if (!item) return;
    const type = String(item.type || "").toLowerCase();
    if (type === "epic") {
      nodes.push({
        id,
        type: "canvasEpic",
        position: { x, y },
        data: { epic: item, issueCount: descendantCount(id), onOpen: handlers.onOpenEpic },
        draggable: true,
        style: { width: ARCH_WIDTH, height: ARCH_HEIGHT },
      });
    } else {
      nodes.push({
        id,
        type: "issue",
        position: { x, y },
        data: { issue: item, allIssues: issues, epics, onOpen: handlers.onOpenIssue },
        draggable: true,
        style: { width: CARD_WIDTH, height: CARD_HEIGHT },
      });
    }
  };

  const layoutSubtree = (id, depth, ancestry = new Set()) => {
    id = String(id);
    if (positionById.has(id)) return positionById.get(id).y;

    // Defensive cycle handling: malformed hierarchy data remains visible and
    // cannot trap the Canvas in recursive layout.
    if (ancestry.has(id)) {
      const y = nextLeafY;
      nextLeafY += ROW_STEP;
      return y;
    }

    const nextAncestry = new Set(ancestry);
    nextAncestry.add(id);
    const currentItem = itemById.get(id);
    const currentType = String(currentItem?.type || "").toLowerCase();
    // Dataset overview starts compact: S-AD + Epic only. Expanding an Epic
    // reveals its complete Feature -> Story/Task subtree in one click.
    const mayShowChildren = currentType !== "epic" || expandedEpicIds.has(id);
    const validChildren = mayShowChildren
      ? (children.get(id) || []).filter(
          (child) => (itemById.has(String(child)) || sadById.has(String(child))) && !nextAncestry.has(String(child)),
        )
      : [];

    let y;
    if (!validChildren.length) {
      y = nextLeafY;
      nextLeafY += ROW_STEP;
    } else {
      const childYs = validChildren.map((child) => layoutSubtree(child, depth + 1, nextAncestry));
      y = (Math.min(...childYs) + Math.max(...childYs)) / 2;
    }

    positionById.set(id, { x: depth * DEPTH_GAP, y });
    positioned.add(id);
    pushNode(id, depth, y);

    validChildren.forEach((child) => {
      if (positionById.has(String(child))) edges.push(makeHierarchyEdge(id, String(child)));
    });
    return y;
  };

  // Each S-AD is one compact tree. A small gap separates domains without
  // wasting an entire row for every intermediate Epic/Feature parent.
  sadSections.forEach((sad) => {
    const before = nextLeafY;
    layoutSubtree(String(sad.id), 0);
    if (nextLeafY === before) nextLeafY += ROW_STEP;
    nextLeafY += TREE_GAP;
  });

  // Keep malformed/orphaned records visible as a final compact forest.
  allItems.forEach((item) => {
    const id = String(item.id);
    if (positioned.has(id)) return;

    // Do not re-add a legitimate descendant that is intentionally hidden
    // behind a collapsed Epic. Only genuine roots/orphans belong here.
    const parentId = getIssueParentId(item);
    const hasKnownParent = parentId && itemById.has(String(parentId));
    const type = String(item.type || "").toLowerCase();
    const epicHasSadParent = type === "epic" && Boolean(item.sad_section_id || item.sadSectionId);
    if (hasKnownParent || epicHasSadParent) return;

    const depth = type === "epic" ? 1 : 2;
    layoutSubtree(id, depth);
    nextLeafY += LEAF_GAP;
  });

  const nodeIds = new Set(nodes.map((node) => node.id));
  (canvasGraph?.dependencies || []).forEach((dependency, index) => {
    if (!nodeIds.has(String(dependency.source)) || !nodeIds.has(String(dependency.target))) return;
    edges.push({
      id: dependency.id || `dependency-${dependency.source}-${dependency.target}-${index}`,
      source: String(dependency.source),
      target: String(dependency.target),
      type: "dependency",
      data: { dependency },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#94A3B8" },
      zIndex: 20,
    });
  });

  const maxDepth = Math.max(0, ...nodes.map((node) => Math.round((node.position?.x || 0) / DEPTH_GAP)));
  return {
    nodes,
    edges,
    width: maxDepth * DEPTH_GAP + ARCH_WIDTH,
    height: Math.max(nextLeafY, ARCH_HEIGHT),
  };
}
function makeHierarchyEdge(source, target) {
  return {
    id: `hierarchy-${source}-${target}`,
    source,
    target,
    type: "hierarchy",
    data: { state: "hierarchy" },
    markerEnd: { type: MarkerType.ArrowClosed, color: "#475569" },
    zIndex: 1,
  };
}

// =========================================================
// Custom Edge
// =========================================================

function FlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data = {},
}) {
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 12,
  });

  const state = data.state || "idle";
  const isActive = state === "active";
  const stroke = state === "warning" ? "#EA580C" : isActive ? "#334155" : "#94A3B8";

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={markerEnd}
      style={{
        stroke,
        strokeWidth: isActive ? 2.5 : 1.75,
        strokeDasharray: isActive ? "none" : "6,6",
      }}
      className={isActive ? "animated-edge-flow" : ""}
    />
  );
}

// =========================================================
// Team Node
// =========================================================

function TeamNode({ data }) {
  const { team, onOpen } = data;
  const v = team.velocity_forecast || {};
  const b = team.backlog || {};
  const risks = team.risks || [];

  return (
    <div className="epic-card" onDoubleClick={() => onOpen && onOpen(team)}>
      <Handle
        type="source"
        position={Position.Right}
        id="right"
        className="handle handle-right nodrag"
      />

      <div className="card-header">
        <span className="badge epic-badge">TEAM</span>
        <span className="edit-hint">Double-click for details</span>
      </div>

      <div className="team-card-body">
        <div className="card-title">{team.team_name}</div>
        <div className="team-card-sub">{team.product_service}</div>

        <div className="velocity-row">
          <span className="velocity-value">
            {v.forecast_velocity_points ?? "—"}
          </span>
          <span className="velocity-unit">pts / sprint</span>

          {v.trend && (
            <span className={`trend-pill ${v.trend}`}>
              {v.trend.replace(/_/g, " ")}
            </span>
          )}
        </div>

        <div className="confidence-track">
          <div
            className="confidence-fill"
            style={{ width: `${Math.round((v.confidence || 0) * 100)}%` }}
          />
        </div>

        {risks.length > 0 && (
          <div className="risk-badge-row">
            {risks.slice(0, 3).map((r, i) => (
              <span key={i} className={`risk-badge ${r.severity}`}>
                {r.type.replace(/_/g, " ")}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="card-footer">
        <span className="footer-meta">
          {b.open_tickets ?? 0} open · {b.open_points ?? 0} pts
        </span>
      </div>
    </div>
  );
}

// =========================================================
// Sprint Node
// =========================================================

function SprintNode({ data }) {
  const {
    sprintId,
    startDate,
    endDate,
    capacityPoints,
    plannedPoints,
    utilization,
    holidayFactor,
    holidayNames,
    generated,
    tickets,
    isCompletion,
    onOpen,
  } = data;

  const utilPct = Math.round((utilization || 0) * 100);
  const over = utilization > 1;

  return (
    <div
      className={`story-card ${isCompletion ? "editing" : ""}`}
      onDoubleClick={() => onOpen && onOpen(data)}
    >
      <Handle
        type="target"
        position={Position.Left}
        id="left"
        className="handle handle-left nodrag"
      />

      <Handle
        type="source"
        position={Position.Right}
        id="right"
        className="handle handle-right nodrag"
      />

      <div className="card-header">
        <span className="badge story-badge">
          {generated ? "PROJECTED" : "SPRINT"}
        </span>

        <span className="sp-pill">
          {plannedPoints}/{capacityPoints ?? "—"} pts
        </span>
      </div>

      <div className="card-title">{sprintId}</div>
      <div className="sprint-card-dates">
        {formatDate(startDate)} – {formatDate(endDate)}
      </div>

      <div className="sprint-meta-row">
        <span>Utilization</span>
        <span>{utilPct}%</span>
      </div>

      <div className="utilization-track">
        <div
          className={`utilization-fill ${over ? "over" : ""}`}
          style={{ width: `${Math.min(100, utilPct)}%` }}
        />
      </div>

      {holidayFactor < 1 && (
        <span className="holiday-note">
          ⛱ {holidayNames.length > 0 ? holidayNames.join(", ") : "Holiday-adjusted capacity"}
        </span>
      )}

      {tickets.length > 0 ? (
        <div className="ticket-chip-list">
          {tickets.slice(0, 4).map((t) => (
            <div key={t.ticket_id} className="ticket-chip">
              <span className="ticket-chip-id">{t.ticket_id}</span>
              <span className="ticket-chip-title">{t.title}</span>
            </div>
          ))}

          {tickets.length > 4 && (
            <div className="empty-sprint-note">
              +{tickets.length - 4} more — double-click to view all
            </div>
          )}
        </div>
      ) : (
        <div className="empty-sprint-note">No tickets scheduled this sprint</div>
      )}
    </div>
  );
}

// =========================================================
// Remaining / Unscheduled Node
// =========================================================

function RemainingNode({ data }) {
  const { remainingPoints, remainingTickets, onOpen } = data;

  return (
    <div className="remaining-card" onDoubleClick={() => onOpen && onOpen(data)}>
      <Handle
        type="target"
        position={Position.Left}
        id="left"
        className="handle handle-left nodrag"
      />

      <span className="remaining-card-icon">⚠️</span>
      <span className="remaining-card-title">Unscheduled backlog</span>
      <span className="remaining-card-sub">
        {remainingPoints} pts · {remainingTickets} tickets
      </span>
    </div>
  );
}


// =========================================================
// Architecture Canvas Nodes
// =========================================================

function SadNode({ data }) {
  const { sad, onOpen } = data;
  return (
    <div className="canvas-architecture-card sad-canvas-card" onDoubleClick={() => onOpen?.(sad)}>
      <Handle type="source" position={Position.Right} className="handle handle-right nodrag" />
      <div className="canvas-card-header">
        <span className="badge sad-badge">S-AD</span>
        <span className="canvas-card-id">{sad.id}</span>
      </div>
      <div className="canvas-card-title">{sad.section_title || sad.title}</div>
      <div className="canvas-card-meta">Section {sad.section_number || "—"} · {sad.architecture_layer || "Architecture"}</div>
      <div className="canvas-card-summary">{sad.summary || "No summary available."}</div>
    </div>
  );
}

function CanvasEpicNode({ data }) {
  const { epic, issueCount, onOpen } = data;
  return (
    <div className="canvas-architecture-card epic-canvas-card" onDoubleClick={() => onOpen?.(epic)}>
      <Handle type="target" position={Position.Left} className="handle handle-left nodrag" />
      <Handle type="source" position={Position.Right} className="handle handle-right nodrag" />
      <div className="canvas-card-header">
        <span className="badge epic-badge">EPIC</span>
        <span className="canvas-card-id">{epic.id}</span>
      </div>
      <div className="canvas-card-title">{epic.title}</div>
      <div className="canvas-card-meta">{epic.status || "—"} · {issueCount} issues</div>
      <div className="canvas-card-meta">Priority: {epic.priority || "—"}</div>
    </div>
  );
}

// ---------------------------------------------------------
// Backlog quality / readiness flags
// ---------------------------------------------------------
// Only backlog work items (Feature / Story / Task) get these flags.
// The flags are derived from the canvas payload so the UI remains useful
// even when the backend does not send a pre-computed readiness object.
function isBacklogWorkItem(issue) {
  return ["feature", "story", "task", "sub-task"].includes(
    String(issue?.type || issue?.issue_type || "").toLowerCase(),
  );
}

function hasStoryPoints(issue) {
  const value = issue?.story_points ?? issue?.storyPoints;
  if (value === null || value === undefined || value === "") return false;
  return Number(value) > 0;
}

function hasAcceptanceCriteria(issue) {
  if (issue?.hasAcceptanceCriteria === true) return true;
  if (String(issue?.hasAcceptanceCriteria || "").toUpperCase() === "Y") return true;
  const criteria = issue?.acceptance_criteria ?? issue?.acceptanceCriteria;
  return Array.isArray(criteria) && criteria.some((item) => String(item || "").trim());
}

function hasDefinitionOfDone(issue) {
  if (issue?.hasDoD === true) return true;
  if (String(issue?.hasDoD || "").toUpperCase() === "Y") return true;
  return Boolean(String(issue?.dod || issue?.definition_of_done || issue?.definitionOfDone || "").trim());
}

function getIssueQualityFlags(issue, allIssues = [], epics = []) {
  if (!isBacklogWorkItem(issue)) return [];

  const flags = [];
  const issueMap = new Map();
  [...allIssues, ...epics].forEach((item) => {
    const id = item?.id ?? item?.nodeId;
    if (id) issueMap.set(String(id), item);
  });

  const epicIds = new Set(
    epics
      .map((epic) => epic?.id ?? epic?.nodeId)
      .filter(Boolean)
      .map(String),
  );

  // Resolve the complete ancestry. A Task may point to a Story, so checking
  // only issue.parent_id would incorrectly flag a valid Task as missing Epic.
  let parentId = issue?.parent_id ?? issue?.parentId ?? issue?.originalParentId ?? "";
  const visited = new Set();
  let hasEpic = false;

  while (parentId && !visited.has(String(parentId))) {
    const key = String(parentId);
    visited.add(key);
    if (epicIds.has(key)) {
      hasEpic = true;
      break;
    }
    const parent = issueMap.get(key);
    if (!parent) break;
    parentId = parent?.parent_id ?? parent?.parentId ?? parent?.originalParentId ?? "";
  }

  // Some payloads expose the Epic directly. Respect it when available.
  const directEpic = issue?.epic_id ?? issue?.epicId ?? issue?.epic;
  if (directEpic) hasEpic = true;

  if (!hasEpic) {
    flags.push({ key: "epic", label: "Epic", short: "EPIC", title: "Missing Epic mapping" });
  }
  if (!hasStoryPoints(issue)) {
    flags.push({ key: "story-points", label: "Story points", short: "SP", title: "Missing story points" });
  }
  if (!hasAcceptanceCriteria(issue)) {
    flags.push({ key: "acceptance-criteria", label: "Acceptance criteria", short: "AC", title: "Missing acceptance criteria" });
  }
  if (!hasDefinitionOfDone(issue)) {
    flags.push({ key: "dod", label: "Definition of Done", short: "DoD", title: "Missing Definition of Done" });
  }
  if (!(issue?.sad_section_id ?? issue?.sadSectionId ?? "").toString().trim()) {
    flags.push({ key: "sad", label: "S-AD", short: "S-AD", title: "Missing S-AD mapping" });
  }

  return flags;
}

function IssueNode({ data }) {
  const { issue, onOpen, allIssues = [], epics = [] } = data;
  const type = (issue.type || issue.issue_type || "Issue").toUpperCase();
  const qualityFlags = getIssueQualityFlags(issue, allIssues, epics);

  return (
    <div
      className={`canvas-issue-card issue-${String(issue.type || issue.issue_type || "issue").toLowerCase()} ${qualityFlags.length ? "has-quality-flags" : ""}`}
      onDoubleClick={() => onOpen?.(issue)}
      title={qualityFlags.length ? qualityFlags.map((flag) => flag.title).join(" · ") : undefined}
    >
      <Handle type="target" position={Position.Left} className="handle handle-left nodrag" />
      <Handle type="source" position={Position.Right} className="handle handle-right nodrag" />

      <div className="canvas-card-header">
        <span className="badge issue-badge">{type}</span>
        <span className="canvas-card-id">{issue.id}</span>
        {issue.story_points != null && <span className="sp-pill">{issue.story_points} pts</span>}
      </div>

      {qualityFlags.length > 0 && (
        <div className="issue-quality-flags" aria-label={`${qualityFlags.length} missing backlog fields`}>
          <span className="issue-quality-label">Needs refinement</span>
          <div className="issue-quality-flag-list">
            {qualityFlags.map((flag) => (
              <span
                key={flag.key}
                className={`issue-quality-flag issue-quality-flag-${flag.key}`}
                title={flag.title}
              >
                <span className="issue-quality-flag-icon">⚑</span>
                <span>{flag.short}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="canvas-issue-title">{issue.title}</div>
      <div className="canvas-card-meta">{issue.status || "—"} · {issue.priority || "—"}</div>
    </div>
  );
}

function DependencyEdge({
  id, source, target, sourceX, sourceY, targetX, targetY, markerEnd, data = {},
}) {
  const { getNodes } = useReactFlow();
  const flowNodes = getNodes();
  const route = buildObstacleAwareRoute(source, target, sourceX, sourceY, targetX, targetY, flowNodes);
  const edgePath = route.map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x},${y}`).join(" ");
  const dependency = data.dependency || {};

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: "#94A3B8",
          strokeWidth: 1.7,
          strokeDasharray: "7 6",
        }}
        className="dependency-edge-path"
      />
      <title>{dependency.type || dependency.relationship || "Dependency"}</title>
    </>
  );
}

function HierarchyEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
}) {
  // Route hierarchy edges around every visible node instead of letting the
  // default smooth-step path run through cards in the middle column.
  const { getNodes } = useReactFlow();
  const flowNodes = getNodes();
  const route = buildObstacleAwareRoute(
    source,
    target,
    sourceX,
    sourceY,
    targetX,
    targetY,
    flowNodes,
  );
  const edgePath = route
    .map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x},${y}`)
    .join(" ");

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={markerEnd}
      style={{
        stroke: "#475569",
        strokeWidth: 2.1,
        strokeDasharray: "none",
      }}
    />
  );
}

const nodeTypes = {
  sad: SadNode,
  canvasEpic: CanvasEpicNode,
  issue: IssueNode,
  team: TeamNode,
  sprint: SprintNode,
  remaining: RemainingNode,
};

const edgeTypes = {
  flow: FlowEdge,
  hierarchy: HierarchyEdge,
  dependency: DependencyEdge,
};

// =========================================================
// Editable backlog properties
// =========================================================

function normalizeLines(value) {
  if (Array.isArray(value)) return value.map((v) => String(v || "").trim()).filter(Boolean);
  return String(value || "")
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function getItemId(item) {
  return String(item?.id ?? item?.nodeId ?? item?.jiraKey ?? "").trim();
}

function getItemTitle(item) {
  return item?.title ?? item?.summary ?? item?.section_title ?? item?.name ?? getItemId(item);
}

function getIssueParentId(issue) {
  return String(issue?.parent_id ?? issue?.parentId ?? issue?.originalParentId ?? "").trim();
}

function getIssueEpicId(issue, allIssues = [], epics = []) {
  const direct = issue?.epic_id ?? issue?.epicId;
  if (direct) return String(direct);

  const epicIds = new Set(epics.map(getItemId).filter(Boolean));
  const byId = new Map([...allIssues, ...epics].map((item) => [getItemId(item), item]));
  let parent = getIssueParentId(issue);
  const seen = new Set();

  while (parent && !seen.has(parent)) {
    if (epicIds.has(parent)) return parent;
    seen.add(parent);
    parent = getIssueParentId(byId.get(parent));
  }
  return "";
}

function getIssueSprintId(issue) {
  return String(issue?.sprint_id ?? issue?.sprintId ?? issue?.sprint ?? "").trim();
}


function applyCanvasOverrides(graph, datasetId) {
  if (!graph || !datasetId) return graph;
  try {
    const overrides = JSON.parse(localStorage.getItem(`foremanCanvasOverrides:${datasetId}`) || "{}");
    if (!overrides || typeof overrides !== "object") return graph;
    return {
      ...graph,
      issues: (graph.issues || []).map((item) => overrides[item.id] ? { ...item, ...overrides[item.id] } : item),
      epics: (graph.epics || []).map((item) => overrides[item.id] ? { ...item, ...overrides[item.id] } : item),
      sad_sections: (graph.sad_sections || []).map((item) => overrides[item.id] ? { ...item, ...overrides[item.id] } : item),
    };
  } catch {
    return graph;
  }
}

function collectSprintOptions(forecast, currentSprint = "", canvasGraph = null) {
  const result = [];
  const seen = new Set();

  (canvasGraph?.sprints || []).forEach((sprint) => {
    const id = String(sprint?.SprintID ?? sprint?.sprint_id ?? sprint?.sprintId ?? sprint?.id ?? "").trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    result.push({ id, label: sprint?.SprintName || sprint?.name || id });
  });

  (forecast?.teams || []).forEach((team) => {
    (team?.forecast_calendar || []).forEach((sprint) => {
      const id = String(sprint?.sprint_id ?? sprint?.sprintId ?? sprint?.id ?? "").trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      result.push({ id, label: sprint?.name || id });
    });
  });
  if (currentSprint && !seen.has(String(currentSprint))) {
    result.unshift({ id: String(currentSprint), label: String(currentSprint) });
  }
  return result;
}

function getAvailableParentOptions(issue, allIssues = [], epics = []) {
  const type = String(issue?.type || issue?.issue_type || "").toLowerCase();
  const issueItems = allIssues.filter((item) => item !== issue);

  if (type === "feature") {
    return epics.map((epic) => ({ id: getItemId(epic), label: `${getItemTitle(epic)} (${getItemId(epic)})` })).filter((x) => x.id);
  }
  if (type === "story") {
    return issueItems.filter((item) => String(item?.type || item?.issue_type || "").toLowerCase() === "feature")
      .map((item) => ({ id:getItemId(item), label:`${getItemTitle(item)} (${getItemId(item)})` })).filter((x) => x.id);
  }
  if (["task", "sub-task", "subtask"].includes(type)) {
    return issueItems.filter((item) => ["feature", "story"].includes(String(item?.type || item?.issue_type || "").toLowerCase()))
      .map((item) => ({ id:getItemId(item), label:`${getItemTitle(item)} (${getItemId(item)})` })).filter((x) => x.id);
  }
  return [];
}

function applyIssueEdits(issue, values) {
  const acceptanceCriteria = normalizeLines(values.acceptanceCriteria);
  const storyPoints = values.storyPoints === "" ? null : Number(values.storyPoints);

  const issueType = String(issue?.type || issue?.issue_type || "").toLowerCase();
  const normalizedParentId = issueType === "feature"
    ? (values.epicId || values.parentId || "")
    : (values.parentId || "");

  return {
    ...issue,
    title: values.title.trim(),
    summary: values.title.trim(),
    sad_section_id: values.sadSectionId || "",
    sadSectionId: values.sadSectionId || "",
    epic_id: values.epicId || "",
    epicId: values.epicId || "",
    parent_id: normalizedParentId,
    parentId: normalizedParentId,
    story_points: Number.isFinite(storyPoints) ? storyPoints : null,
    storyPoints: Number.isFinite(storyPoints) ? storyPoints : null,
    sprint_id: values.sprintId || "",
    sprintId: values.sprintId || "",
    sprint: values.sprintId || "",
    acceptance_criteria: acceptanceCriteria,
    acceptanceCriteria,
    hasAcceptanceCriteria: acceptanceCriteria.length > 0,
    dod: values.dod.trim(),
    definition_of_done: values.dod.trim(),
    definitionOfDone: values.dod.trim(),
    hasDoD: Boolean(values.dod.trim()),
  };
}

function EditableIssueBody({ panel, onSave }) {
  const issue = panel.issue;
  const allIssues = panel.allIssues || [];
  const epics = panel.epics || [];
  const sadSections = panel.sadSections || [];
  const sprintOptions = panel.sprintOptions || [];
  const [values, setValues] = useState(() => ({
    title: getItemTitle(issue),
    sadSectionId: String(issue?.sad_section_id ?? issue?.sadSectionId ?? ""),
    epicId: getIssueEpicId(issue, allIssues, epics),
    parentId: getIssueParentId(issue),
    storyPoints: issue?.story_points ?? issue?.storyPoints ?? "",
    sprintId: getIssueSprintId(issue),
    acceptanceCriteria: Array.isArray(issue?.acceptance_criteria ?? issue?.acceptanceCriteria)
      ? (issue.acceptance_criteria ?? issue.acceptanceCriteria).join("\n")
      : String(issue?.acceptance_criteria ?? issue?.acceptanceCriteria ?? ""),
    dod: String(issue?.dod ?? issue?.definition_of_done ?? issue?.definitionOfDone ?? ""),
  }));

  useEffect(() => {
    setValues({
      title: getItemTitle(issue),
      sadSectionId: String(issue?.sad_section_id ?? issue?.sadSectionId ?? ""),
      epicId: getIssueEpicId(issue, allIssues, epics),
      parentId: getIssueParentId(issue),
      storyPoints: issue?.story_points ?? issue?.storyPoints ?? "",
      sprintId: getIssueSprintId(issue),
      acceptanceCriteria: Array.isArray(issue?.acceptance_criteria ?? issue?.acceptanceCriteria)
        ? (issue.acceptance_criteria ?? issue.acceptanceCriteria).join("\n")
        : String(issue?.acceptance_criteria ?? issue?.acceptanceCriteria ?? ""),
      dod: String(issue?.dod ?? issue?.definition_of_done ?? issue?.definitionOfDone ?? ""),
    });
  }, [issue, allIssues, epics]);

  const parentOptions = getAvailableParentOptions(issue, allIssues, epics);
  const type = String(issue?.type || issue?.issue_type || "").toLowerCase();
  const isBacklog = isBacklogWorkItem(issue);

  if (!isBacklog) {
    return <div className="smart-empty">This node does not expose editable backlog properties.</div>;
  }

  const update = (key, value) => setValues((current) => ({ ...current, [key]: value }));

  return (
    <>
      <div className="smart-edit-banner">
        <strong>Edit backlog properties</strong>
        <span>Only values available in this dataset are offered in dropdowns.</span>
      </div>

      <div className="smart-field">
        <label>Title</label>
        <input value={values.title} onChange={(e) => update("title", e.target.value)} />
      </div>

      <div className="smart-field">
        <label>S-AD Section</label>
        <select value={values.sadSectionId} onChange={(e) => update("sadSectionId", e.target.value)}>
          <option value="">— Not assigned —</option>
          {sadSections.map((sad) => {
            const id = getItemId(sad);
            return <option key={id} value={id}>{getItemTitle(sad)} ({id})</option>;
          })}
        </select>
      </div>

      <div className="smart-field">
        <label>Epic</label>
        <select value={values.epicId} onChange={(e) => update("epicId", e.target.value)}>
          <option value="">— Not assigned —</option>
          {epics.map((epic) => {
            const id = getItemId(epic);
            return <option key={id} value={id}>{getItemTitle(epic)} ({id})</option>;
          })}
        </select>
      </div>

      {parentOptions.length > 0 && (
        <div className="smart-field">
          <label>{type === "story" ? "Parent Feature" : ["task", "sub-task", "subtask"].includes(type) ? "Parent Feature / Story" : "Parent Epic"}</label>
          <select value={values.parentId} onChange={(e) => update("parentId", e.target.value)}>
            <option value="">— Not assigned —</option>
            {parentOptions.map((parent) => <option key={parent.id} value={parent.id}>{parent.label}</option>)}
          </select>
        </div>
      )}

      <div className="smart-field">
        <label>Story Points</label>
        <div className="smart-points">
          {[1, 2, 3, 5, 8, 13, 21].map((points) => (
            <button
              type="button"
              key={points}
              className={Number(values.storyPoints) === points ? "selected" : ""}
              onClick={() => update("storyPoints", points)}
            >{points}</button>
          ))}
          <button type="button" className={values.storyPoints === "" || values.storyPoints == null ? "selected" : ""} onClick={() => update("storyPoints", "")}>None</button>
        </div>
        <div className="smart-helper-row"><span>Use a custom value</span></div>
        <input
          type="number"
          min="0"
          step="1"
          value={values.storyPoints}
          onChange={(e) => update("storyPoints", e.target.value)}
          placeholder="Story points"
        />
      </div>

      <div className="smart-field">
        <label>Sprint</label>
        <select value={values.sprintId} onChange={(e) => update("sprintId", e.target.value)}>
          <option value="">— Not assigned —</option>
          {sprintOptions.map((sprint) => <option key={sprint.id} value={sprint.id}>{sprint.label}</option>)}
        </select>
      </div>

      <div className="smart-field">
        <label>Acceptance Criteria</label>
        <textarea
          value={values.acceptanceCriteria}
          onChange={(e) => update("acceptanceCriteria", e.target.value)}
          placeholder="Enter one acceptance criterion per line"
        />
        <div className="smart-helper-row"><span>Each non-empty line becomes a criterion.</span></div>
      </div>

      <div className="smart-field">
        <label>Definition of Done</label>
        <textarea
          value={values.dod}
          onChange={(e) => update("dod", e.target.value)}
          placeholder="Enter the Definition of Done"
        />
      </div>

      <div className="smart-panel-footer">
        <span className="smart-change-state">Changes apply to this canvas</span>
        <div className="smart-footer-actions">
          <button type="button" className="smart-save" onClick={() => onSave(applyIssueEdits(issue, values))}>Save changes</button>
        </div>
      </div>
    </>
  );
}

function EditableSadBody({ panel, onSave }) {
  const sad = panel.sad;
  const [values, setValues] = useState(() => ({
    title: String(sad?.section_title ?? sad?.title ?? ""),
    architectureLayer: String(sad?.architecture_layer ?? ""),
    summary: String(sad?.summary ?? ""),
  }));

  useEffect(() => {
    setValues({
      title: String(sad?.section_title ?? sad?.title ?? ""),
      architectureLayer: String(sad?.architecture_layer ?? ""),
      summary: String(sad?.summary ?? ""),
    });
  }, [sad]);

  return (
    <>
      <div className="smart-edit-banner">
        <strong>Edit S-AD properties</strong>
        <span>These changes are stored locally for this dataset.</span>
      </div>
      <div className="smart-field">
        <label>S-AD Name</label>
        <input value={values.title} onChange={(e) => setValues((v) => ({ ...v, title: e.target.value }))} />
      </div>
      <div className="smart-field">
        <label>Architecture Layer</label>
        <input value={values.architectureLayer} onChange={(e) => setValues((v) => ({ ...v, architectureLayer: e.target.value }))} />
      </div>
      <div className="smart-field">
        <label>Summary</label>
        <textarea value={values.summary} onChange={(e) => setValues((v) => ({ ...v, summary: e.target.value }))} />
      </div>
      <div className="smart-panel-footer">
        <span className="smart-change-state">Changes apply to this canvas</span>
        <div className="smart-footer-actions">
          <button type="button" className="smart-save" onClick={() => onSave({ ...sad, section_title: values.title.trim(), title: values.title.trim(), architecture_layer: values.architectureLayer.trim(), summary: values.summary.trim() })}>Save changes</button>
        </div>
      </div>
    </>
  );
}

function EditableEpicBody({ panel, onSave }) {
  const epic = panel.epic;
  const sadSections = panel.sadSections || [];
  const [values, setValues] = useState(() => ({
    title: String(epic?.title ?? epic?.summary ?? ""),
    sadSectionId: String(epic?.sad_section_id ?? epic?.sadSectionId ?? ""),
    status: String(epic?.status ?? ""),
    priority: String(epic?.priority ?? ""),
  }));

  useEffect(() => {
    setValues({
      title: String(epic?.title ?? epic?.summary ?? ""),
      sadSectionId: String(epic?.sad_section_id ?? epic?.sadSectionId ?? ""),
      status: String(epic?.status ?? ""),
      priority: String(epic?.priority ?? ""),
    });
  }, [epic]);

  return (
    <>
      <div className="smart-edit-banner">
        <strong>Edit Epic properties</strong>
        <span>S-AD is selected only from sections present in the dataset.</span>
      </div>
      <div className="smart-field">
        <label>Epic Name</label>
        <input value={values.title} onChange={(e) => setValues((v) => ({ ...v, title: e.target.value }))} />
      </div>
      <div className="smart-field">
        <label>S-AD Section</label>
        <select value={values.sadSectionId} onChange={(e) => setValues((v) => ({ ...v, sadSectionId: e.target.value }))}>
          <option value="">— Not assigned —</option>
          {sadSections.map((sad) => {
            const id = getItemId(sad);
            return <option key={id} value={id}>{getItemTitle(sad)} ({id})</option>;
          })}
        </select>
      </div>
      <div className="smart-field">
        <label>Status</label>
        <input value={values.status} onChange={(e) => setValues((v) => ({ ...v, status: e.target.value }))} />
      </div>
      <div className="smart-field">
        <label>Priority</label>
        <input value={values.priority} onChange={(e) => setValues((v) => ({ ...v, priority: e.target.value }))} />
      </div>
      <div className="smart-panel-footer">
        <span className="smart-change-state">Changes apply to this canvas</span>
        <div className="smart-footer-actions">
          <button type="button" className="smart-save" onClick={() => onSave({ ...epic, title: values.title.trim(), summary: values.title.trim(), sad_section_id: values.sadSectionId || "", sadSectionId: values.sadSectionId || "", status: values.status.trim(), priority: values.priority.trim() })}>Save changes</button>
        </div>
      </div>
    </>
  );
}

// =========================================================
// Detail Panel (Team / Sprint / Remaining)
// =========================================================

function DetailPanel({ panel, onClose, onUpdateNode, onOpenInPlayground }) {
  if (!panel) return null;

  let iconClass = "epic";
  let typeLabel = "";
  let title = "";
  let body = null;

  if (panel.type === "team") {
    const team = panel.team;
    const v = team.velocity_forecast || {};
    const b = team.backlog || {};

    iconClass = "epic";
    typeLabel = "TEAM";
    title = team.team_name;

    body = (
      <>
        <div className="smart-panel-summary-card">
          <strong>Product / Service</strong>
          <span>{team.product_service || "—"}</span>
        </div>

        <div className="smart-field">
          <label>Velocity Forecast</label>
          <div className="panel-stat-grid">
            <div className="panel-stat-box">
              <div className="panel-stat-box-value">{v.forecast_velocity_points ?? "—"}</div>
              <div className="panel-stat-box-label">Forecast pts/sprint</div>
            </div>
            <div className="panel-stat-box">
              <div className="panel-stat-box-value">{v.recent_average_points ?? "—"}</div>
              <div className="panel-stat-box-label">Recent Avg</div>
            </div>
            <div className="panel-stat-box">
              <div className="panel-stat-box-value">
                {Math.round((v.confidence || 0) * 100)}%
              </div>
              <div className="panel-stat-box-label">Confidence</div>
            </div>
            <div className="panel-stat-box">
              <div className="panel-stat-box-value" style={{ textTransform: "capitalize" }}>
                {(v.trend || "—").replace(/_/g, " ")}
              </div>
              <div className="panel-stat-box-label">Trend</div>
            </div>
          </div>
        </div>

        <div className="smart-field">
          <label>Backlog</label>
          <div className="panel-stat-grid">
            <div className="panel-stat-box">
              <div className="panel-stat-box-value">{b.open_tickets ?? 0}</div>
              <div className="panel-stat-box-label">Open Tickets</div>
            </div>
            <div className="panel-stat-box">
              <div className="panel-stat-box-value">{b.open_points ?? 0}</div>
              <div className="panel-stat-box-label">Open Points</div>
            </div>
            <div className="panel-stat-box">
              <div className="panel-stat-box-value">{b.scheduled_points ?? 0}</div>
              <div className="panel-stat-box-label">Scheduled</div>
            </div>
            <div className="panel-stat-box">
              <div className="panel-stat-box-value">{b.remaining_points ?? 0}</div>
              <div className="panel-stat-box-label">Remaining</div>
            </div>
          </div>
        </div>

        {team.forecast?.completion_date && (
          <div className="smart-field">
            <label>Projected Completion</label>
            <span style={{ fontSize: 12, color: "#334155" }}>
              {formatDate(team.forecast.completion_date)} ({team.forecast.completion_sprint})
            </span>
          </div>
        )}

        <div className="smart-field">
          <label>Risks ({(team.risks || []).length})</label>

          {team.risks && team.risks.length > 0 ? (
            <div className="smart-list">
              {team.risks.map((r, i) => (
                <div key={i} className="smart-list-item">
                  <span className={`risk-badge on-light ${r.severity}`}>{r.severity}</span>
                  <span className="smart-list-text">{r.message}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="smart-empty">No risks flagged</div>
          )}
        </div>
      </>
    );
  } else if (panel.type === "sprint") {
    const s = panel.sprint;

    iconClass = "story";
    typeLabel = "SPRINT";
    title = s.sprintId;

    body = (
      <>
        <div className="smart-panel-summary-card">
          <strong>{s.teamName}</strong>
          <span>
            {formatDate(s.startDate)} – {formatDate(s.endDate)}
          </span>
        </div>

        <div className="smart-field">
          <label>Capacity</label>
          <div className="panel-stat-grid">
            <div className="panel-stat-box">
              <div className="panel-stat-box-value">{s.capacityPoints ?? "—"}</div>
              <div className="panel-stat-box-label">Capacity pts</div>
            </div>
            <div className="panel-stat-box">
              <div className="panel-stat-box-value">{s.plannedPoints ?? 0}</div>
              <div className="panel-stat-box-label">Planned pts</div>
            </div>
          </div>
        </div>

        {s.holidayNames?.length > 0 && (
          <div className="smart-field">
            <label>Holidays</label>
            <span style={{ fontSize: 12, color: "#334155" }}>
              {s.holidayNames.join(", ")} (capacity ×{s.holidayFactor})
            </span>
          </div>
        )}

        <div className="smart-field">
          <label>Tickets ({s.tickets.length})</label>

          {s.tickets.length > 0 ? (
            <div className="smart-list">
              {s.tickets.map((t) => (
                <div key={t.ticket_id} className="smart-list-item">
                  <span className="smart-task-key">{t.ticket_id}</span>
                  <span className="smart-list-text">
                    {t.title} — {t.story_points} pts
                  </span>
                  <span className={`priority-pill ${t.priority}`}>{t.priority}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="smart-empty">No tickets scheduled</div>
          )}
        </div>
      </>
    );
  } else if (panel.type === "sad") {
    const sad = panel.sad;
    iconClass = "epic";
    typeLabel = "S-AD";
    title = sad.section_title || sad.title;
    body = <EditableSadBody panel={panel} onSave={(updated) => onUpdateNode?.("sad", updated)} />;
  } else if (panel.type === "canvasEpic") {
    const epic = panel.epic;
    iconClass = "epic";
    typeLabel = "EPIC";
    title = epic.title;
    body = <EditableEpicBody panel={panel} onSave={(updated) => onUpdateNode?.("canvasEpic", updated)} />;
  } else if (panel.type === "issue") {
    const issue = panel.issue;
    iconClass = "story";
    typeLabel = issue.type || issue.issue_type || "ISSUE";
    title = issue.title || issue.summary || issue.id;
    body = (
      <EditableIssueBody
        panel={panel}
        onSave={(updatedIssue) => onUpdateNode?.("issue", updatedIssue)}
      />
    );
  } else if (panel.type === "remaining") {
    iconClass = "warning";
    typeLabel = "UNSCHEDULED";
    title = panel.teamName;

    body = (
      <div className="smart-field">
        <label>Remaining backlog</label>
        <span style={{ fontSize: 12, color: "#334155", lineHeight: 1.6 }}>
          {panel.remainingPoints} points across {panel.remainingTickets} tickets
          could not be scheduled within the forecast horizon or dependency
          constraints. Re-run the forecast after extending team capacity or
          resolving blocking dependencies.
        </span>
      </div>
    );
  }

  return (
    <aside className="smart-node-panel" onDoubleClick={(e) => e.stopPropagation()}>
      <div className="smart-panel-header">
        <div className="smart-panel-title-area">
          <div className={`smart-panel-icon ${iconClass}`}>
            {iconClass === "epic" ? "T" : iconClass === "story" ? "S" : "!"}
          </div>

          <div style={{ minWidth: 0 }}>
            <div className="smart-panel-meta">
              <span className={`smart-panel-type ${iconClass}`}>{typeLabel}</span>
            </div>

            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#0F172A" }}>
              {title}
            </h2>
          </div>
        </div>

        <button className="smart-panel-close" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="smart-panel-content">{body}</div>
      {["canvasEpic", "issue"].includes(panel.type) && (
        <div className="smart-panel-footer">
          <span className="smart-change-state">Use this existing work as grounded planning context</span>
          <button type="button" className="smart-save" onClick={() => onOpenInPlayground?.(panel)}>
            Open in Playground
          </button>
        </div>
      )}
    </aside>
  );
}

// =========================================================
// Ask Foreman — Hybrid RAG Chat
// =========================================================

function AskPanel({ datasetId, onClose }) {
  const [messages, setMessages] = useState([]);
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    const q = question.trim();
    if (!q || sending) return;

    setSending(true);
    setQuestion("");
    setMessages((current) => [...current, { question: q, answer: "", loading: true }]);

    try {
      const result = await askRag(datasetId, q);
      setMessages((current) =>
        current.map((m, i) =>
          i === current.length - 1
            ? { ...m, answer: result.answer, loading: false }
            : m,
        ),
      );
    } catch (err) {
      setMessages((current) =>
        current.map((m, i) =>
          i === current.length - 1
            ? {
                ...m,
                answer: err.message || "Something went wrong.",
                loading: false,
                isError: true,
              }
            : m,
        ),
      );
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <aside className="smart-node-panel">
      <div className="smart-panel-header">
        <div className="smart-panel-title-area">
          <div className="smart-panel-icon story">💬</div>

          <div>
            <div className="smart-panel-meta">
              <span className="smart-panel-type story">ASK FOREMAN</span>
            </div>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#0F172A" }}>
              Hybrid RAG Q&amp;A
            </h2>
          </div>
        </div>

        <button className="smart-panel-close" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="smart-panel-content">
        {messages.length === 0 ? (
          <div className="chat-empty">
            Ask about blockers, dependencies, cycles, or any ticket in this
            dataset — e.g. "What is blocking the authentication work?" or
            "Are there any dependency cycles?"
          </div>
        ) : (
          <div className="chat-thread">
            {messages.map((m, i) => (
              <div key={i} className="chat-turn">
                <div className="chat-bubble question">{m.question}</div>
                <div className={`chat-bubble answer ${m.loading ? "loading" : ""}`}>
                  {m.loading ? "Thinking..." : m.answer}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <div className="smart-panel-footer">
        <div className="chat-composer" style={{ width: "100%" }}>
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question about this dataset..."
          />
          <button onClick={handleSend} disabled={sending || !question.trim()}>
            ➤
          </button>
        </div>
      </div>
    </aside>
  );
}

// =========================================================
// Semantic Search Panel
// =========================================================

function SearchPanel({ datasetId, onClose }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSearch = async (e) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;

    setLoading(true);
    setError("");

    try {
      const data = await searchDataset(datasetId, q, 6);
      setResults(data.results || []);
    } catch (err) {
      setError(err.message || "Search failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <aside className="smart-node-panel">
      <div className="smart-panel-header">
        <div className="smart-panel-title-area">
          <div className="smart-panel-icon story">🔍</div>

          <div>
            <div className="smart-panel-meta">
              <span className="smart-panel-type story">SEARCH</span>
            </div>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#0F172A" }}>
              Semantic Search
            </h2>
          </div>
        </div>

        <button className="smart-panel-close" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="smart-panel-content">
        <form className="search-form" onSubmit={handleSearch}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. booking availability"
            autoFocus
          />
          <button type="submit" disabled={loading || !query.trim()}>
            {loading ? "…" : "Go"}
          </button>
        </form>

        {error && (
          <div className="auth-message" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}

        {results && (
          <div className="search-result-list">
            {results.length === 0 && (
              <div className="smart-empty">No matches found.</div>
            )}

            {results.map((r) => (
              <div key={r.id} className="search-result-card">
                <div className="search-result-head">
                  <span className="search-result-id">{r.id}</span>
                  <span className="search-result-distance">
                    dist {typeof r.distance === "number" ? r.distance.toFixed(3) : "—"}
                  </span>
                </div>

                <div className="search-result-text">{r.text}</div>

                {r.metadata && (
                  <div className="search-result-meta">
                    {Object.entries(r.metadata)
                      .filter(([, v]) => v !== "" && v != null)
                      .slice(0, 6)
                      .map(([k, v]) => (
                        <span key={k} className="meta-chip">
                          {k}: {String(v)}
                        </span>
                      ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

// =========================================================
// Intake Triage Panel
// =========================================================

function IntakePanel({ datasetId, onClose }) {
  const [text, setText] = useState("");
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;

    setLoading(true);
    setError("");
    setReport(null);

    try {
      const data = await runIntake(datasetId, trimmed);
      setReport(data);
    } catch (err) {
      setError(err.message || "Intake processing failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <aside className="smart-node-panel">
      <div className="smart-panel-header">
        <div className="smart-panel-title-area">
          <div className="smart-panel-icon story">📥</div>

          <div>
            <div className="smart-panel-meta">
              <span className="smart-panel-type story">INTAKE</span>
            </div>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#0F172A" }}>
              Triage New Work
            </h2>
          </div>
        </div>

        <button className="smart-panel-close" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="smart-panel-content">
        <form className="intake-form" onSubmit={handleSubmit}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder='e.g. "Make it possible for a customer to book a service in under two minutes."'
          />
          <button type="submit" disabled={loading || !text.trim()}>
            {loading ? "Analyzing…" : "Analyze Intake"}
          </button>
        </form>

        {error && (
          <div className="auth-message" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}

        {report && (
          <>
            <div className="intake-report-section">
              <div className="intake-report-heading">Architecture Areas</div>

              {report.architecture_areas?.length > 0 ? (
                <div className="intake-chip-row">
                  {report.architecture_areas.map((a) => (
                    <span key={a.sad_section_id} className="intake-chip">
                      {a.sad_section_id} — {a.title || a.section_title || a.sad_title}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="smart-empty">No architecture matches.</div>
              )}
            </div>

            <div className="intake-report-section">
              <div className="intake-report-heading">Related Tickets</div>

              {report.related_tickets?.length > 0 ? (
                report.related_tickets.map((t) => (
                  <div key={t.ticket_id} className="intake-row">
                    <span>
                      <strong>{t.ticket_id}</strong> — {t.title}
                    </span>
                    <span className={`status-pill ${statusClass(t.status)}`}>
                      {t.status || "—"}
                    </span>
                  </div>
                ))
              ) : (
                <div className="smart-empty">No related tickets found.</div>
              )}
            </div>

            <div className="intake-report-section">
              <div className="intake-report-heading">Dependency Impacts</div>

              {report.dependency_impacts?.length > 0 ? (
                report.dependency_impacts.map((d, i) => (
                  <div key={i} className="intake-row">
                    <span>
                      <strong>{d.ticket_id}</strong> depends on{" "}
                      <strong>{d.depends_on}</strong> ({d.dependency_type})
                    </span>
                    <span className={`status-pill ${statusClass(d.target_status)}`}>
                      {d.target_status || "—"}
                    </span>
                  </div>
                ))
              ) : (
                <div className="smart-empty">No dependency impacts.</div>
              )}
            </div>

            {report.dependency_cycles?.length > 0 && (
              <div className="intake-report-section">
                <div className="intake-report-heading">Dependency Cycles</div>

                {report.dependency_cycles.map((cycle, i) => (
                  <div key={i} className="intake-cycle-warning">
                    {cycle.join(" → ")} → {cycle[0]}
                  </div>
                ))}
              </div>
            )}

            <div className="intake-report-section">
              <div className="intake-report-heading">LLM Assessment</div>

              {report.llm_assessment ? (
                <div className="intake-assessment-card">
                  <span className="intake-assessment-label">
                    {report.llm_assessment.classification || report.llm_provider}
                  </span>
                  <pre
                    style={{
                      whiteSpace: "pre-wrap",
                      fontSize: 11,
                      margin: 0,
                      color: "#334155",
                    }}
                  >
                    {JSON.stringify(report.llm_assessment, null, 2)}
                  </pre>
                </div>
              ) : (
                <div className="smart-empty">
                  LLM assessment disabled — set LLM_PROVIDER on the backend
                  to enable interpretation.
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

// =========================================================
// Flow Canvas (main)
// =========================================================

function FlowCanvas() {
  const navigate = useNavigate();
  const location = useLocation();
  const { fitView } = useReactFlow();

  const [datasetId] = useState(
    () => location.state?.datasetId || localStorage.getItem("foremanDatasetId") || "",
  );

  const [datasetMeta, setDatasetMeta] = useState(null);
  const [forecast, setForecast] = useState(null);
  const [canvasGraph, setCanvasGraph] = useState(null);

  const [loading, setLoading] = useState(true);
  const [loadingLabel, setLoadingLabel] = useState("Loading dataset...");
  const [error, setError] = useState("");

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  // Start with an executive overview: only S-AD sections and Epics.
  // Clicking an Epic toggles its complete descendant subtree.
  const [expandedEpicIds, setExpandedEpicIds] = useState(() => new Set());
  // Keep the default overview hierarchy-first. Dependency lines are valuable,
  // but showing all of them over 171 tickets makes the tree harder to scan.
  const [showDependencies, setShowDependencies] = useState(false);
  const visibleEdges = useMemo(
    () => showDependencies ? edges : edges.filter((edge) => edge.type !== "dependency"),
    [edges, showDependencies],
  );

  const [activePanel, setActivePanel] = useState(null);
  const [jsonOutput, setJsonOutput] = useState(null);
  const [copied, setCopied] = useState(false);

  const openDetail = useCallback((type, payload) => {
    setActivePanel({ type, ...payload });
  }, []);

  const nodeHandlers = useMemo(
    () => ({
      onOpenTeam: (team) => openDetail("team", { team }),
      onOpenSprint: (sprint) => openDetail("sprint", { sprint }),
      onOpenRemaining: (payload) => openDetail("remaining", payload),
      onOpenSad: (sad) => openDetail("sad", { sad, sadSections: canvasGraph?.sad_sections || [] }),
      onOpenEpic: (epic) => openDetail("canvasEpic", { epic, sadSections: canvasGraph?.sad_sections || [] }),
      onOpenIssue: (issue) => openDetail("issue", {
        issue,
        allIssues: canvasGraph?.issues || [],
        epics: canvasGraph?.epics || [],
        sadSections: canvasGraph?.sad_sections || [],
        sprintOptions: collectSprintOptions(forecast, getIssueSprintId(issue), canvasGraph),
      }),
    }),
    [openDetail, canvasGraph, forecast],
  );

  const handleUpdateNode = useCallback((type, updatedNode) => {
    if (!updatedNode?.id || !canvasGraph) return;

    const nextGraph = {
      ...canvasGraph,
      issues: (canvasGraph.issues || []).map((item) => item.id === updatedNode.id ? updatedNode : item),
      epics: (canvasGraph.epics || []).map((item) => item.id === updatedNode.id ? updatedNode : item),
      sad_sections: (canvasGraph.sad_sections || []).map((item) => item.id === updatedNode.id ? updatedNode : item),
    };

    const overrides = JSON.parse(localStorage.getItem(`foremanCanvasOverrides:${datasetId}`) || "{}");
    overrides[updatedNode.id] = updatedNode;
    localStorage.setItem(`foremanCanvasOverrides:${datasetId}`, JSON.stringify(overrides));

    setCanvasGraph(nextGraph);
    const diagram = buildDiagram(nextGraph, nodeHandlers, expandedEpicIds);
    setNodes(diagram.nodes);
    setEdges(diagram.edges);

    if (type === "issue") {
      setActivePanel({
        type,
        issue: updatedNode,
        allIssues: nextGraph.issues || [],
        epics: nextGraph.epics || [],
        sadSections: nextGraph.sad_sections || [],
        sprintOptions: collectSprintOptions(forecast, getIssueSprintId(updatedNode), nextGraph),
      });
    } else if (type === "canvasEpic") {
      setActivePanel({ type, epic: updatedNode, sadSections: nextGraph.sad_sections || [] });
    } else if (type === "sad") {
      setActivePanel({ type, sad: updatedNode, sadSections: nextGraph.sad_sections || [] });
    }
  }, [datasetId, canvasGraph, nodeHandlers, forecast]);

  const loadEverything = useCallback(async () => {
    if (!datasetId) return;

    setLoading(true);
    setError("");
    setLoadingLabel("Checking dataset status...");

    try {
      let metadata = await getDatasetStatus(datasetId);
      setDatasetMeta(metadata);

      if (metadata.status !== "ready") {
        setLoadingLabel(`Dataset is ${metadata.status} — waiting for ingestion...`);

        metadata = await waitForDatasetReady(datasetId, {
          onTick: (m) => {
            setDatasetMeta(m);
            setLoadingLabel(`Dataset is ${m.status}...`);
          },
        });
      }

      setDatasetMeta(metadata);
      localStorage.setItem("foremanDatasetId", datasetId);
      if (metadata.filename) {
        localStorage.setItem("foremanDatasetName", metadata.filename);
      }

      setLoadingLabel("Building S-AD → Epic → Issue dependency canvas...");

      const [forecastResult, canvasResult] = await Promise.all([
        generateForecast(datasetId),
        getCanvasGraph(datasetId),
      ]);
      setForecast(forecastResult);
      const mergedCanvasResult = applyCanvasOverrides(canvasResult, datasetId);
      setCanvasGraph(mergedCanvasResult);

      const diagram = buildDiagram(mergedCanvasResult, nodeHandlers, expandedEpicIds);
      setNodes(diagram.nodes);
      setEdges(diagram.edges);

      setTimeout(() => {
        fitView({ padding: 0.035, minZoom: 0.03, maxZoom: 0.7, duration: 450 });
      }, 80);
    } catch (err) {
      setError(err.message || "Failed to load the canvas.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId]);

  useEffect(() => {
    if (!datasetId) {
      setError("No dataset selected. Choose or upload a dataset to open the canvas.");
      setLoading(false);
      return;
    }

    loadEverything();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId]);

  const handleRerunForecast = async () => {
    setLoading(true);
    setLoadingLabel("Refreshing forecast and dependency canvas...");
    setError("");

    try {
      const [forecastResult, canvasResult] = await Promise.all([
        generateForecast(datasetId),
        getCanvasGraph(datasetId),
      ]);
      setForecast(forecastResult);
      const mergedCanvasResult = applyCanvasOverrides(canvasResult, datasetId);
      setCanvasGraph(mergedCanvasResult);

      const diagram = buildDiagram(mergedCanvasResult, nodeHandlers, expandedEpicIds);
      setNodes(diagram.nodes);
      setEdges(diagram.edges);

      setTimeout(() => {
        fitView({ padding: 0.035, minZoom: 0.03, maxZoom: 0.7, duration: 450 });
      }, 80);
    } catch (err) {
      setError(err.message || "Forecast failed.");
    } finally {
      setLoading(false);
    }
  };

  const handleReingest = async () => {
    try {
      await reingestDataset(datasetId);
      loadEverything();
    } catch (err) {
      setError(err.message || "Re-ingest failed.");
    }
  };

  const handleCopyJson = async () => {
    if (!jsonOutput) return;
    try {
      await navigator.clipboard.writeText(jsonOutput);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable — silently ignore.
    }
  };

  const togglePanel = (type) => {
    setActivePanel((current) => (current?.type === type ? null : { type }));
  };

  // =======================================================
  // Error screen
  // =======================================================

  if (error && !loading) {
    return (
      <div
        style={{
          width: "100vw",
          height: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#F8FAFC",
        }}
      >
        <div
          style={{
            maxWidth: 480,
            textAlign: "center",
            background: "#FFFFFF",
            border: "1px solid #FECACA",
            borderRadius: 12,
            padding: "40px 32px",
            boxShadow: "0 10px 15px -3px rgba(15,23,42,0.08)",
          }}
        >
          <div style={{ fontSize: 34, marginBottom: 12 }}>⚠️</div>

          <h2 style={{ margin: "0 0 10px", color: "#991B1B" }}>
            Unable to load the canvas
          </h2>

          <p style={{ color: "#64748B", lineHeight: 1.6, marginBottom: 24 }}>
            {error}
          </p>

          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <button
              onClick={() => navigate("/start")}
              style={{
                border: "1px solid #CBD5E1",
                borderRadius: 8,
                background: "#FFFFFF",
                color: "#0F172A",
                padding: "10px 18px",
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              Back to Start
            </button>

            {datasetId && (
              <button
                onClick={loadEverything}
                style={{
                  border: "none",
                  borderRadius: 8,
                  background: "#2563EB",
                  color: "#FFFFFF",
                  padding: "10px 18px",
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                Try Again
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // =======================================================
  // Render
  // =======================================================

  const handleCanvasNodeClick = useCallback((_event, node) => {
    if (node?.type !== "canvasEpic") return;

    setExpandedEpicIds((current) => {
      const next = new Set(current);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);

      if (canvasGraph) {
        const diagram = buildDiagram(canvasGraph, nodeHandlers, next);
        setNodes(diagram.nodes);
        setEdges(diagram.edges);
        window.requestAnimationFrame(() => {
          fitView({ padding: 0.06, minZoom: 0.03, maxZoom: 0.9, duration: 350 });
        });
      }
      return next;
    });
  }, [canvasGraph, nodeHandlers, setNodes, setEdges, fitView]);

  return (
    <div className="dataset-canvas-shell">
      <div className="dataset-canvas-topbar">
        <div className="dataset-canvas-brand">Foreman</div>
        <div className="dataset-canvas-title">
          <strong>Dataset Smart Canvas</strong>
          <span>S-AD + Epic overview · Click an Epic to expand/collapse its full child tree.</span>
        </div>
        <div className="dataset-canvas-status">
          <span className="dataset-canvas-status-dot" />
          <span>{datasetMeta?.filename || datasetId || "Dataset"}</span>
        </div>
      </div>
      <div className="dataset-canvas-stage">
      <ReactFlow
        nodes={nodes}
        edges={visibleEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleCanvasNodeClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionMode={ConnectionMode.Loose}
        nodesConnectable={false}
        minZoom={0.03}
        maxZoom={2}
        fitView
        fitViewOptions={{ padding: 0.035, minZoom: 0.03, maxZoom: 0.7 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Lines} color="#E2E8F0" gap={28} size={1} />

        <Controls />
        <MiniMap
          pannable
          zoomable
          nodeStrokeWidth={2}
          nodeColor={(node) => {
            if (node.type === "sad") return "#CBD5E1";
            if (node.type === "canvasEpic") return "#DDD6FE";
            const issueType = String(node.data?.issue?.type || "").toLowerCase();
            if (issueType === "feature") return "#D1FAE5";
            if (issueType === "task") return "#FEF3C7";
            return "#DBEAFE";
          }}
        />

        <Panel position="bottom-left">
          <div className="canvas-legend">
            <span className="canvas-legend-item"><span className="canvas-legend-line" /> Hierarchy</span>
            <span className="canvas-legend-item"><span className="canvas-legend-line dependency" /> Dependency / blocks</span>
          </div>
        </Panel>

        <Panel position="top-left">
          {forecast && !loading && (
            <div
              className="summary-strip"
              onClick={() => setJsonOutput(JSON.stringify(forecast, null, 2))}
              title="Click to view the raw forecast JSON"
            >
              <div className="summary-stat">
                <div className="summary-stat-value">{forecast.summary.teams}</div>
                <div className="summary-stat-label">Teams</div>
              </div>

              <div className="summary-stat">
                <div className="summary-stat-value">{forecast.summary.open_tickets}</div>
                <div className="summary-stat-label">Open Tickets</div>
              </div>

              <div className="summary-stat">
                <div className="summary-stat-value">
                  {forecast.summary.scheduled_points_percent}%
                </div>
                <div className="summary-stat-label">Scheduled</div>
              </div>

              <div className="summary-stat">
                <div className="summary-stat-value">
                  {(forecast.summary.dependency_cycles || []).length}
                </div>
                <div className="summary-stat-label">Cycles</div>
              </div>
            </div>
          )}
        </Panel>

        <Panel position="top-right" className="panel-actions">
          {datasetMeta && (
            <div className="dataset-chip">
              <span className="dot" />
              <strong>{datasetMeta.filename || datasetId}</strong>
            </div>
          )}

          {loading && (
            <div
              style={{
                background: "#FFFFFF",
                border: "1px solid #E2E8F0",
                borderRadius: "8px",
                padding: "8px 12px",
                fontSize: "12px",
                color: "#475569",
                display: "flex",
                alignItems: "center",
                gap: "8px",
                boxShadow: "0 2px 8px rgba(15, 23, 42, 0.06)",
              }}
            >
              <span
                style={{
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  background: "#2563EB",
                  animation: "pulse 1.2s infinite",
                }}
              />
              {loadingLabel}
            </div>
          )}

          {!loading && (
            <>
              <button
                className="btn-outline-action canvas-overview-action"
                onClick={() => fitView({ padding: 0.035, minZoom: 0.03, maxZoom: 0.7, duration: 450 })}
                title="Fit the complete hierarchy into the current screen"
              >
                ⛶ Fit all
              </button>

              <button
                className={`btn-outline-action canvas-overview-action ${showDependencies ? "active" : ""}`}
                onClick={() => setShowDependencies((value) => !value)}
                title="Toggle dependency/blocking relationships without changing the hierarchy"
              >
                {showDependencies ? "⇢ Dependencies on" : "⇢ Dependencies"}
              </button>

              <button className="btn-outline-action" onClick={handleReingest}>
                ↻ Re-ingest
              </button>

              <button className="btn-outline-action" onClick={handleRerunForecast}>
                📊 Re-run Forecast
              </button>

              <button
                className="btn-outline-action"
                onClick={() =>
                  navigate("/report", { state: { datasetId, report: forecast } })
                }
                disabled={!forecast}
              >
                📄 Forecast Report
              </button>

              <button
                className={`btn-primary-action ${activePanel?.type === "ask" ? "active" : ""}`}
                onClick={() => togglePanel("ask")}
              >
                💬 Ask
              </button>

              <button
                className={`btn-outline-action ${activePanel?.type === "search" ? "active" : ""}`}
                onClick={() => togglePanel("search")}
              >
                🔍 Search
              </button>

              <button
                className={`btn-outline-action ${activePanel?.type === "intake" ? "active" : ""}`}
                onClick={() => togglePanel("intake")}
              >
                📥 Intake
              </button>

              <button className="btn-outline-action" onClick={() => navigate("/playground", { state: { datasetId } })}>
                ✦ Planning Playground
              </button>

              <button className="btn-outline-action" onClick={() => navigate("/start")}>
                Change Dataset
              </button>
            </>
          )}
        </Panel>
      </ReactFlow>
      </div>

      {["sad", "canvasEpic", "issue", "team", "sprint", "remaining"].includes(activePanel?.type) && (
        <DetailPanel panel={activePanel} onClose={() => setActivePanel(null)} onUpdateNode={handleUpdateNode}
          onOpenInPlayground={(panel) => navigate("/playground", { state: { datasetId, contextItem: panel.issue || panel.epic } })} />
      )}

      {activePanel?.type === "ask" && (
        <AskPanel datasetId={datasetId} onClose={() => setActivePanel(null)} />
      )}

      {activePanel?.type === "search" && (
        <SearchPanel datasetId={datasetId} onClose={() => setActivePanel(null)} />
      )}

      {activePanel?.type === "intake" && (
        <IntakePanel datasetId={datasetId} onClose={() => setActivePanel(null)} />
      )}

      {jsonOutput && (
        <div className="json-modal-backdrop" onClick={() => setJsonOutput(null)}>
          <div className="json-modal" onClick={(e) => e.stopPropagation()}>
            <div className="json-modal-header">
              <div>
                <h3>Raw Forecast JSON</h3>
                <p>Exact payload returned by POST /datasets/{"{id}"}/forecast.</p>
              </div>

              <div className="json-modal-actions">
                <button className="btn-copy" onClick={handleCopyJson}>
                  {copied ? "✓ Copied!" : "Copy Payload"}
                </button>

                <button className="btn-close" onClick={() => setJsonOutput(null)}>
                  ×
                </button>
              </div>
            </div>

            <div className="json-modal-body">
              <pre>
                <code>{jsonOutput}</code>
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// =========================================================
// Page
// =========================================================

export default function Canvas() {
  return (
    <div className="flow-container">
      <ReactFlowProvider>
        <FlowCanvas />
      </ReactFlowProvider>
    </div>
  );
}
