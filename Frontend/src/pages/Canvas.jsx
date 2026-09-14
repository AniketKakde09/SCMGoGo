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
  addEdge,
  MarkerType,
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  useReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";

import "@xyflow/react/dist/style.css";
import "../App.css";
import {
  analyzeForemanDataset,
  buildCanvasIssues,
  getBundledForemanDataset,
  getDatasetSummary,
  parseForemanWorkbook,
} from "../utils/foremanDataset";


// =========================================================
// Backend Configuration
// =========================================================

const API_BASE_URL = "http://localhost:8000";

// =========================================================
// Base Component Dimensions
// =========================================================

const EPIC_WIDTH = 290;
const EPIC_HEIGHT = 210;

const FEATURE_WIDTH = 300;
const FEATURE_HEIGHT = 150;

const STORY_WIDTH = 320;
const STORY_BASE_HEIGHT = 170;
const STORY_TASK_HEIGHT = 28;
const STORY_WARNING_HEIGHT = 22;

// Extra space is needed whenever the readiness-warning banner
// (e.g. "Missing DoD") renders, otherwise its line pushes the
// task list past the card's fixed height and visually overflows.
function calculateStoryHeight(taskCount, hasWarning) {
  return (
    STORY_BASE_HEIGHT +
    taskCount * STORY_TASK_HEIGHT +
    (hasWarning ? STORY_WARNING_HEIGHT : 0)
  );
}

function createStableId(prefix) {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// =========================================================
// Dynamic Spacing
// =========================================================

function calculateDynamicSpacing(
  viewportWidth,
  viewportHeight,
  maxStoriesInLane,
) {
  const availableWidth = Math.max(viewportWidth - 120, 1200);

  const reservedNodesWidth = EPIC_WIDTH + maxStoriesInLane * STORY_WIDTH;

  const remainingWidth = Math.max(availableWidth - reservedNodesWidth, 180);

  const epicToStoryGap = Math.min(Math.max(remainingWidth * 0.3, 80), 160);

  const storyGap =
    maxStoriesInLane > 1
      ? Math.min(
          Math.max((remainingWidth * 0.7) / (maxStoriesInLane - 1), 60),
          120,
        )
      : 80;

  const laneGap = Math.min(Math.max(viewportHeight * 0.05, 40), 80);

  const lanePaddingY = Math.min(Math.max(viewportHeight * 0.03, 24), 48);

  return {
    epicToStoryGap,
    storyGap,
    laneGap,
    lanePaddingY,
    lanePaddingX: 36,
  };
}

// =========================================================
// Canvas relationship / hierarchy helpers
// =========================================================

const HIERARCHY_RULES = {
  // Preferred hierarchy is Epic -> Feature -> Story.
  // Story -> Epic remains valid for existing backlogs that do not yet have Feature nodes.
  epic: ["feature", "story"],
  feature: ["story"],
  story: [],
};

function canCreateHierarchy(sourceNode, targetNode) {
  if (!sourceNode || !targetNode || sourceNode.id === targetNode.id) {
    return false;
  }

  return (HIERARCHY_RULES[sourceNode.type] || []).includes(targetNode.type);
}

function getAbsoluteNodeRect(node, allNodes) {
  let x = Number(node?.position?.x) || 0;
  let y = Number(node?.position?.y) || 0;
  let parentId = node?.parentId;
  const seen = new Set();

  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = allNodes.find((item) => item.id === parentId);
    if (!parent) break;
    x += Number(parent.position?.x) || 0;
    y += Number(parent.position?.y) || 0;
    parentId = parent.parentId;
  }

  const width =
    Number(node?.measured?.width) ||
    Number(node?.width) ||
    Number(node?.style?.width) ||
    (node?.type === "epic"
      ? EPIC_WIDTH
      : node?.type === "feature"
        ? FEATURE_WIDTH
        : STORY_WIDTH);
  const height =
    Number(node?.measured?.height) ||
    Number(node?.height) ||
    Number(node?.style?.height) ||
    (node?.type === "epic"
      ? EPIC_HEIGHT
      : node?.type === "feature"
        ? FEATURE_HEIGHT
        : STORY_BASE_HEIGHT);

  return { x, y, width, height, cx: x + width / 2, cy: y + height / 2 };
}

function pointInsideRect(point, rect, padding = 18) {
  return (
    point.x >= rect.x - padding &&
    point.x <= rect.x + rect.width + padding &&
    point.y >= rect.y - padding &&
    point.y <= rect.y + rect.height + padding
  );
}

// =========================================================
// Custom Edge
// =========================================================

function CustomEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  data = {},
  selected,
}) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 12,
  });

  const isHierarchy = data.relationship === "hierarchy";
  const isDependency = data.relationship === "dependency";
  const isPrimary = isHierarchy || data.edgeType !== "secondary";
  const isAnimated = data.animated ?? false;
  const edgeStroke = isHierarchy ? "#475569" : "#64748B";
  const edgeWidth = isHierarchy ? 2.4 : 1.8;
  const strokeDasharray = isHierarchy ? "none" : "7,6";
  const dependencyLabel = isDependency
    ? String(data.dependencyType || "depends on").replaceAll("_", " ")
    : "";

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: selected ? "#2563EB" : edgeStroke,
          strokeWidth: selected ? 3 : edgeWidth,
          strokeDasharray: isAnimated ? "8,8" : strokeDasharray,
        }}
        className={isAnimated ? "animated-edge-flow" : ""}
      />

      {isDependency && !selected && (
        <EdgeLabelRenderer>
          <div
            className="dependency-edge-label nodrag nopan"
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: "none",
            }}
          >
            {dependencyLabel}
          </div>
        </EdgeLabelRenderer>
      )}

      {selected && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: "all",
            }}
            className="edge-popover nodrag nopan"
          >
            <span className="edge-relationship-chip">
              {isHierarchy ? "Hierarchy" : dependencyLabel || "Dependency"}
            </span>

            {!isHierarchy && (
              <button
                className={`popover-btn ${isAnimated ? "active-pulse" : ""}`}
                onClick={() => data.onAnimToggle && data.onAnimToggle(id)}
              >
                {isAnimated ? "⚡ Flow" : "⏸ Flow"}
              </button>
            )}

            <button
              className="popover-btn delete-btn"
              onClick={() => data.onDelete && data.onDelete(id)}
            >
              ×
            </button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

// =========================================================
// Epic Node
// =========================================================

function EpicNode({ id, data }) {
  const [isEditing, setIsEditing] = useState(false);

  const [summary, setSummary] = useState(data.summary);

  const [description, setDescription] = useState(data.description || "");

  useEffect(() => {
    setSummary(data.summary || "");
    setDescription(data.description || "");
  }, [data.summary, data.description]);

  const handleSave = (e) => {
    e.stopPropagation();

    setIsEditing(false);

    if (data.onUpdate) {
      data.onUpdate(id, {
        summary,
        description,
      });
    }
  };

  return (
    <div className={`epic-card ${isEditing ? "editing" : ""} state-${data.changeState || (data.jiraKey ? "existing" : "new")} ${(data.readinessIssues || []).length ? "has-warning" : ""}`}>
      <div className="card-header">
        <span className="badge epic-badge">EPIC</span>

        {data.syncStatus === "syncing" && (
          <span className="jira-status syncing" title="Creating Jira issue...">
            ⟳
          </span>
        )}

        {data.syncStatus === "created" && (
          <span
            className="jira-status created"
            title={
              data.jiraKey
                ? `Created in Jira: ${data.jiraKey}`
                : "Created in Jira"
            }
          >
            ✓
          </span>
        )}

        {data.syncStatus === "failed" && (
          <span
            className="jira-status failed"
            title={data.jiraError || "Jira creation failed"}
          >
            !
          </span>
        )}

        {data.jiraKey && <span className="jira-key">{data.jiraKey}</span>}

        {!data.jiraKey && (
          <span className={`work-state ${data.changeState || "new"}`}>
            {(data.changeState || "new") === "modified" ? "MODIFIED" : "NEW"}
          </span>
        )}

        {isEditing ? (
          <button className="btn-save" onClick={handleSave}>
            Save 🔒
          </button>
        ) : (
          <span className="edit-hint">Double-click to edit</span>
        )}
      </div>

      {isEditing ? (
        <div className="edit-form" onClick={(e) => e.stopPropagation()}>
          <input
            type="text"
            className="input-field"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="Epic title..."
            autoFocus
          />

          <textarea
            className="input-field textarea-field"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Epic description..."
          />
        </div>
      ) : (
        <div className="card-body">
          <div className="card-title">{data.summary}</div>

          <div className="card-description">{data.description}</div>

          {data.sadSectionId ? (
            <div className="sad-trace">S-AD: {data.sadSectionId}</div>
          ) : (
            <div className="readiness-warning">⚠ Missing S-AD</div>
          )}
        </div>
      )}

      <div className="card-footer">
        <span className="footer-meta">
          {data.storyCount} {data.storyCount === 1 ? "Story" : "Stories"}
        </span>
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        id="bottom"
        className="handle handle-bottom nodrag"
      />
    </div>
  );
}

// =========================================================
// Feature Node
// =========================================================

function FeatureNode({ id, data }) {
  const readinessIssues = Array.isArray(data.readinessIssues)
    ? data.readinessIssues
    : [];
  const changeState =
    data.changeState || (data.jiraKey ? "existing" : "new");

  return (
    <div
      className={`feature-card state-${changeState} ${
        readinessIssues.length ? "has-warning" : ""
      }`}
    >
      <Handle
        type="target"
        position={Position.Top}
        id="top"
        className="handle handle-top nodrag"
      />

      <Handle
        type="source"
        position={Position.Bottom}
        id="bottom"
        className="handle handle-bottom nodrag"
      />

      <div className="card-header">
        <span className="badge feature-badge">FEATURE</span>
        <div className="header-actions">
          {data.jiraKey ? (
            <span className="jira-key">{data.jiraKey}</span>
          ) : (
            <span className={`work-state ${changeState}`}>
              {changeState === "modified" ? "MODIFIED" : "NEW"}
            </span>
          )}
        </div>
      </div>

      <div className="card-body">
        <div className="card-title feature-title">{data.summary}</div>

        {data.description && (
          <div className="card-description feature-description">
            {data.description}
          </div>
        )}

        <div className="work-meta-row">
          {data.priority && <span>{data.priority}</span>}
          {data.sprint && <span>{data.sprint}</span>}
          {data.sadSectionId && <span>S-AD {data.sadSectionId}</span>}
        </div>

        {readinessIssues.length > 0 && (
          <div className="readiness-warning">
            ⚠ {readinessIssues.slice(0, 2).join(" · ")}
          </div>
        )}
      </div>

      <div className="card-footer">
        <span className="footer-meta">
          {data.childCount || 0} {(data.childCount || 0) === 1 ? "Item" : "Items"}
        </span>
      </div>
    </div>
  );
}

// =========================================================
// Story Node
// =========================================================

function StoryNode({ id, data }) {
  const [isEditing, setIsEditing] = useState(false);

  const [summary, setSummary] = useState(data.summary);

  const [description, setDescription] = useState(data.description || "");

  const [storyPoints, setStoryPoints] = useState(data.storyPoints ?? "");

  const [tasks, setTasks] = useState(data.tasks ? [...data.tasks] : []);

  useEffect(() => {
    setSummary(data.summary || "");
    setDescription(data.description || "");
    setStoryPoints(data.storyPoints ?? "");
    setTasks(data.tasks ? data.tasks.map((task) => ({ ...task })) : []);
  }, [data.summary, data.description, data.storyPoints, data.tasks]);

  const handleSave = (e) => {
    e.stopPropagation();

    setIsEditing(false);

    if (data.onUpdate) {
      data.onUpdate(id, {
        summary,
        description,
        storyPoints: storyPoints !== "" ? Number(storyPoints) : null,
        tasks,
      });
    }
  };

  const handleTaskChange = (index, value) => {
    const updated = [...tasks];

    updated[index] = {
      ...updated[index],
      summary: value,
    };

    setTasks(updated);
  };

  const handleAddTask = () => {
    setTasks([
      ...tasks,
      {
        issue_type: "Task",
        summary: "New Task",
        description: "",
        parent: data.summary,
      },
    ]);
  };

  const handleRemoveTask = (index) => {
    setTasks(tasks.filter((_, i) => i !== index));
  };

  return (
    <div className={`story-card ${isEditing ? "editing" : ""} state-${data.changeState || (data.jiraKey ? "existing" : "new")} ${(data.readinessIssues || []).length ? "has-warning" : ""}`}>
      <Handle
        type="target"
        position={Position.Top}
        id="top"
        className="handle handle-top nodrag"
      />

      <Handle
        type="source"
        position={Position.Bottom}
        id="bottom"
        className="handle handle-bottom nodrag"
      />

      <div className="card-header">
        <span className="badge story-badge">{String(data.issue_type || "Story").toUpperCase()}</span>

        {data.syncStatus === "syncing" && (
          <span className="jira-status syncing" title="Creating Jira issue...">
            ⟳
          </span>
        )}

        {data.syncStatus === "created" && (
          <span
            className="jira-status created"
            title={
              data.jiraKey
                ? `Created in Jira: ${data.jiraKey}`
                : "Created in Jira"
            }
          >
            ✓
          </span>
        )}

        {data.syncStatus === "failed" && (
          <span
            className="jira-status failed"
            title={data.jiraError || "Jira creation failed"}
          >
            !
          </span>
        )}

        {data.jiraKey && <span className="jira-key">{data.jiraKey}</span>}

        {!data.jiraKey && (
          <span className={`work-state ${data.changeState || "new"}`}>
            {(data.changeState || "new") === "modified" ? "MODIFIED" : "NEW"}
          </span>
        )}

        <div className="header-actions">
          {!isEditing && data.storyPoints != null && (
            <span className="sp-pill">{data.storyPoints} SP</span>
          )}

          {isEditing && (
            <button className="btn-save" onClick={handleSave}>
              Save 🔒
            </button>
          )}
        </div>
      </div>

      {isEditing ? (
        <div className="edit-form" onClick={(e) => e.stopPropagation()}>
          <div className="sp-input-row">
            <label>Points:</label>

            <input
              type="number"
              className="input-field sp-field"
              value={storyPoints}
              onChange={(e) => setStoryPoints(e.target.value)}
            />
          </div>

          <input
            type="text"
            className="input-field"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="Story title..."
            autoFocus
          />

          <textarea
            className="input-field textarea-field"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Story description..."
          />

          <div className="tasks-editor">
            <div className="tasks-editor-header">
              <span>Tasks ({tasks.length})</span>

              <button
                type="button"
                className="btn-add-task"
                onClick={handleAddTask}
              >
                + Add
              </button>
            </div>

            {tasks.map((task, idx) => (
              <div key={idx} className="task-input-row">
                <input
                  type="text"
                  className="input-field"
                  value={task.summary}
                  onChange={(e) => handleTaskChange(idx, e.target.value)}
                />

                <button
                  type="button"
                  className="btn-remove-task"
                  onClick={() => handleRemoveTask(idx)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="card-body">
          <div className="card-title">{data.summary}</div>

          {data.description && (
            <div className="card-description">{data.description}</div>
          )}

          <div className="work-meta-row">
            {data.priority && <span>{data.priority}</span>}
            {data.sprint && <span>{data.sprint}</span>}
            {data.sadSectionId && <span>S-AD {data.sadSectionId}</span>}
          </div>

          {(data.readinessIssues || []).length > 0 && (
            <div className="readiness-warning">
              ⚠ {(data.readinessIssues || []).slice(0, 2).join(" · ")}
            </div>
          )}

          <div className="tasks-container">
            <div className="tasks-header">
              <span>Subtasks</span>

              <span>{tasks.length}</span>
            </div>

            {tasks.length > 0 ? (
              <div className="task-list">
                {tasks.map((task, idx) => (
                  <div key={idx} className="task-item">
                    <span className="task-icon">✓</span>

                    <span className="task-text">{task.summary}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="no-tasks">No subtasks</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// =========================================================
// Smart Right-Side Node Editor
// =========================================================

function NodeEditPanel({ node, onClose, onSave }) {
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [storyPoints, setStoryPoints] = useState("");
  const [tasks, setTasks] = useState([]);
  const [acceptanceCriteria, setAcceptanceCriteria] = useState([]);
  const [newTask, setNewTask] = useState("");
  const [newCriteria, setNewCriteria] = useState("");
  const [priority, setPriority] = useState("Medium");
  const [statusValue, setStatusValue] = useState("To Do");
  const [sprint, setSprint] = useState("");
  const [assignee, setAssignee] = useState("");
  const [sadSectionId, setSadSectionId] = useState("");
  const [hasDoD, setHasDoD] = useState(false);

  useEffect(() => {
    if (!node) {
      return;
    }

    setSummary(node.data.summary || "");
    setDescription(node.data.description || "");
    setStoryPoints(node.data.storyPoints ?? "");
    setTasks(
      Array.isArray(node.data.tasks)
        ? node.data.tasks.map((task) => ({ ...task }))
        : [],
    );
    setAcceptanceCriteria(
      Array.isArray(node.data.acceptanceCriteria)
        ? [...node.data.acceptanceCriteria]
        : [],
    );
    setNewTask("");
    setNewCriteria("");
    setPriority(node.data.priority || "Medium");
    setStatusValue(node.data.status || "To Do");
    setSprint(node.data.sprint || "");
    setAssignee(node.data.assignee || "");
    setSadSectionId(node.data.sadSectionId || "");
    setHasDoD(Boolean(node.data.hasDoD));
  }, [node]);

  if (!node) {
    return null;
  }

  const isEpic = node.type === "epic";
  const isFeature = node.type === "feature";
  const isStory = node.type === "story";

  const originalSummary = node.data.summary || "";
  const originalDescription = node.data.description || "";
  const originalStoryPoints = node.data.storyPoints ?? "";
  const originalTasks = Array.isArray(node.data.tasks) ? node.data.tasks : [];
  const originalCriteria = Array.isArray(node.data.acceptanceCriteria)
    ? node.data.acceptanceCriteria
    : [];

  const hasChanges =
    summary !== originalSummary ||
    description !== originalDescription ||
    String(storyPoints) !== String(originalStoryPoints) ||
    JSON.stringify(tasks) !== JSON.stringify(originalTasks) ||
    JSON.stringify(acceptanceCriteria) !== JSON.stringify(originalCriteria) ||
    priority !== (node.data.priority || "Medium") ||
    statusValue !== (node.data.status || "To Do") ||
    sprint !== (node.data.sprint || "") ||
    assignee !== (node.data.assignee || "") ||
    sadSectionId !== (node.data.sadSectionId || "") ||
    hasDoD !== Boolean(node.data.hasDoD);

  const handleTaskChange = (index, value) => {
    setTasks((current) =>
      current.map((task, taskIndex) =>
        taskIndex === index
          ? {
              ...task,
              summary: value,
            }
          : task,
      ),
    );
  };

  const handleAddTask = () => {
    const value = newTask.trim();

    if (!value) {
      return;
    }

    setTasks((current) => [
      ...current,
      {
        issue_type: "Sub-task",
        summary: value,
        description: "",
        parent: summary.trim() || node.data.summary || "",
        nodeId: createStableId(`${node.id}-task`),
        jiraKey: null,
      },
    ]);

    setNewTask("");
  };

  const handleRemoveTask = (index) => {
    setTasks((current) => current.filter((_, taskIndex) => taskIndex !== index));
  };

  const handleAddCriteria = () => {
    const value = newCriteria.trim();

    if (!value) {
      return;
    }

    setAcceptanceCriteria((current) => [...current, value]);
    setNewCriteria("");
  };

  const handleRemoveCriteria = (index) => {
    setAcceptanceCriteria((current) =>
      current.filter((_, criteriaIndex) => criteriaIndex !== index),
    );
  };

  const handleSave = () => {
    if (!summary.trim()) {
      return;
    }

    const cleanSummary = summary.trim();

    const updatedFields = {
      summary: cleanSummary,
      description: description.trim(),
      priority,
      status: statusValue,
      sprint: sprint.trim(),
      assignee: assignee.trim(),
      sadSectionId: sadSectionId.trim(),
      hasDoD,
      changeState:
        node.data.jiraKey || node.data.changeState === "existing"
          ? "modified"
          : node.data.changeState || "new",
    };

    if (isStory) {
      updatedFields.storyPoints =
        storyPoints !== "" && storyPoints != null ? Number(storyPoints) : null;

      updatedFields.tasks = tasks.map((task) => ({
        ...task,
        issue_type: task.issue_type || "Sub-task",
        parent: cleanSummary,
      }));

      updatedFields.acceptanceCriteria = acceptanceCriteria;
    }

    onSave(node.id, updatedFields);
    onClose();
  };

  const issueLabel = isEpic ? "EPIC" : isFeature ? "FEATURE" : "STORY";
  const issueTone = isEpic ? "epic" : isFeature ? "feature" : "story";
  const status = node.data.syncStatus || "idle";

  return (
    <>

      <aside className="smart-node-panel" onDoubleClick={(e) => e.stopPropagation()}>
        <div className="smart-panel-header">
          <div className="smart-panel-title-area">
            <div className={`smart-panel-icon ${issueTone}`}>
              {isEpic ? "E" : isFeature ? "F" : "S"}
            </div>

            <div style={{ minWidth: 0 }}>
              <div className="smart-panel-meta">
                <span className={`smart-panel-type ${issueTone}`}>
                  {issueLabel}
                </span>

                {node.data.jiraKey && (
                  <span className="smart-panel-key">{node.data.jiraKey}</span>
                )}

                <span className={`smart-status ${status}`}>
                  {status === "created"
                    ? "Created"
                    : status === "syncing"
                      ? "Syncing"
                      : status === "failed"
                        ? "Failed"
                        : "Draft"}
                </span>
              </div>

              <h2>{isEpic ? "Edit Epic" : isFeature ? "Edit Feature" : "Edit Story"}</h2>
            </div>
          </div>

          <button
            type="button"
            className="smart-panel-close"
            onClick={onClose}
            title="Close editor"
          >
            ×
          </button>
        </div>

        <div className="smart-panel-content">
          <div className="smart-panel-summary-card">
            <strong>Work item editor</strong>
            <span>
              Update the selected {isEpic ? "epic" : isFeature ? "feature" : "story"}. Changes stay in Foreman until you explicitly publish them to Jira.
            </span>
          </div>

          <div className="smart-field">
            <label>Summary *</label>
            <input
              className="smart-summary-input"
              type="text"
              value={summary}
              maxLength={120}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Enter a clear work item title..."
              autoFocus
            />

            <div className="smart-helper-row">
              <span>Keep the title clear and action-oriented</span>
              <span>{summary.length}/120</span>
            </div>
          </div>

          <div className="smart-field">
            <label>Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the requirement, context and expected outcome..."
            />
          </div>

          <div className="smart-field">
            <div className="smart-section-heading">
              <label>Planning</label>
              <span className="smart-section-count">Workspace</span>
            </div>

            <div className="smart-grid-two">
              <div>
                <label>Priority</label>
                <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                  <option>Highest</option>
                  <option>High</option>
                  <option>Medium</option>
                  <option>Low</option>
                </select>
              </div>

              <div>
                <label>Status</label>
                <select value={statusValue} onChange={(e) => setStatusValue(e.target.value)}>
                  <option>To Do</option>
                  <option>In Progress</option>
                  <option>Blocked</option>
                  <option>Done</option>
                </select>
              </div>

              <div>
                <label>Sprint</label>
                <input value={sprint} onChange={(e) => setSprint(e.target.value)} placeholder="Sprint 4" />
              </div>

              <div>
                <label>Assignee</label>
                <input value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="Unassigned" />
              </div>
            </div>
          </div>

          <div className="smart-field">
            <div className="smart-section-heading">
              <label>Traceability & Readiness</label>
              <span className="smart-section-count">Foreman</span>
            </div>

            <div className="smart-grid-two">
              <div>
                <label>S-AD Section</label>
                <input value={sadSectionId} onChange={(e) => setSadSectionId(e.target.value)} placeholder="SAD-04" />
              </div>

              <label className="smart-check-toggle">
                <input type="checkbox" checked={hasDoD} onChange={(e) => setHasDoD(e.target.checked)} />
                <span>Definition of Done available</span>
              </label>
            </div>

            {Array.isArray(node.data.definitionOfDone) && node.data.definitionOfDone.length > 0 && (
              <div className="smart-list" style={{ marginTop: "12px" }}>
                {node.data.definitionOfDone.map((criterion, index) => (
                  <div className="smart-list-item" key={`${criterion}-${index}`}>
                    <span className="smart-check">✓</span>
                    <span className="smart-list-text">{criterion}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {isStory && (
            <>
              <div className="smart-field">
                <div className="smart-section-heading">
                  <label>Story Points</label>
                  <span className="smart-section-count">Effort</span>
                </div>

                <div className="smart-points">
                  {[1, 2, 3, 5, 8, 13].map((point) => (
                    <button
                      key={point}
                      type="button"
                      className={Number(storyPoints) === point ? "selected" : ""}
                      onClick={() => setStoryPoints(point)}
                    >
                      {point}
                    </button>
                  ))}
                </div>
              </div>

              <div className="smart-field">
                <div className="smart-section-heading">
                  <label>Acceptance Criteria</label>
                  <span className="smart-section-count">{acceptanceCriteria.length}</span>
                </div>

                <div className="smart-list">
                  {acceptanceCriteria.length > 0 ? (
                    acceptanceCriteria.map((criteria, index) => (
                      <div className="smart-list-item" key={`${criteria}-${index}`}>
                        <span className="smart-check">✓</span>
                        <span className="smart-list-text">{criteria}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveCriteria(index)}
                          title="Remove acceptance criterion"
                        >
                          ×
                        </button>
                      </div>
                    ))
                  ) : (
                    <div className="smart-empty">No acceptance criteria yet.</div>
                  )}
                </div>

                <div className="smart-add-row">
                  <input
                    type="text"
                    value={newCriteria}
                    onChange={(e) => setNewCriteria(e.target.value)}
                    placeholder="Add acceptance criteria..."
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddCriteria();
                      }
                    }}
                  />

                  <button type="button" onClick={handleAddCriteria} title="Add criterion">
                    +
                  </button>
                </div>
              </div>

              <div className="smart-field">
                <div className="smart-section-heading">
                  <label>Subtasks</label>
                  <span className="smart-section-count">{tasks.length}</span>
                </div>

                <div className="smart-list">
                  {tasks.length > 0 ? (
                    tasks.map((task, index) => (
                      <div className="smart-task-item" key={task.nodeId || index}>
                        <span className="smart-drag">⋮⋮</span>
                        <input
                          type="text"
                          value={task.summary || ""}
                          onChange={(e) => handleTaskChange(index, e.target.value)}
                        />

                        {task.jiraKey && (
                          <span className="smart-task-key">{task.jiraKey}</span>
                        )}

                        <button
                          type="button"
                          onClick={() => handleRemoveTask(index)}
                          title="Remove subtask"
                        >
                          ×
                        </button>
                      </div>
                    ))
                  ) : (
                    <div className="smart-empty">No subtasks yet.</div>
                  )}
                </div>

                <div className="smart-add-row">
                  <input
                    type="text"
                    value={newTask}
                    onChange={(e) => setNewTask(e.target.value)}
                    placeholder="Add a new subtask..."
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddTask();
                      }
                    }}
                  />

                  <button type="button" onClick={handleAddTask} title="Add subtask">
                    +
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="smart-panel-footer">
          <div className={`smart-change-state ${hasChanges ? "changed" : "clean"}`}>
            {hasChanges ? "Unsaved changes" : "No changes"}
          </div>

          <div className="smart-footer-actions">
            <button type="button" className="smart-cancel" onClick={onClose}>
              Cancel
            </button>

            <button
              type="button"
              className="smart-save"
              onClick={handleSave}
              disabled={!summary.trim() || !hasChanges}
            >
              Save Changes
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}


// =========================================================
// Smart Create Work Item Inspector
// =========================================================

function CreateWorkItemPanel({
  type,
  epicOptions,
  featureOptions,
  storyOptions,
  defaultParentId,
  onClose,
  onCreate,
}) {
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [storyPoints, setStoryPoints] = useState("");
  const [parentId, setParentId] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState([]);
  const [newCriteria, setNewCriteria] = useState("");
  const [validationError, setValidationError] = useState("");

  const isEpic = type === "epic";
  const isFeature = type === "feature";
  const isStory = type === "story";
  const isSubtask = type === "subtask";

  useEffect(() => {
    setSummary("");
    setDescription("");
    setStoryPoints("");
    setAcceptanceCriteria([]);
    setNewCriteria("");
    setValidationError("");

    if (defaultParentId) {
      setParentId(defaultParentId);
      return;
    }

    if (type === "feature") {
      setParentId(epicOptions[0]?.id || "");
    } else if (type === "story") {
      setParentId(featureOptions[0]?.id || epicOptions[0]?.id || "");
    } else if (type === "subtask") {
      setParentId(storyOptions[0]?.id || "");
    } else {
      setParentId("");
    }
  }, [type, defaultParentId, epicOptions, featureOptions, storyOptions]);

  const addCriteria = () => {
    const value = newCriteria.trim();
    if (!value) return;
    setAcceptanceCriteria((current) => [...current, value]);
    setNewCriteria("");
  };

  const removeCriteria = (index) => {
    setAcceptanceCriteria((current) =>
      current.filter((_, criteriaIndex) => criteriaIndex !== index),
    );
  };

  const parentOptions = isFeature
    ? epicOptions
    : isStory
      ? featureOptions.length > 0
        ? featureOptions
        : epicOptions
      : isSubtask
        ? storyOptions
        : [];
  const selectedParent = parentOptions.find((option) => option.id === parentId);
  const canCreate =
    summary.trim().length > 0 &&
    (isEpic || Boolean(parentId));

  const handleCreate = () => {
    if (!summary.trim()) {
      setValidationError("Summary is required.");
      return;
    }

    if (!isEpic && !parentId) {
      setValidationError(
        isFeature
          ? "Select a parent Epic before creating the Feature."
          : isStory
            ? "Select a parent Feature before creating the Story."
            : "Select a parent Story before creating the Sub-task.",
      );
      return;
    }

    onCreate({
      type,
      parentId,
      summary: summary.trim(),
      description: description.trim(),
      storyPoints:
        isStory && storyPoints !== "" && storyPoints != null
          ? Number(storyPoints)
          : null,
      acceptanceCriteria: isStory ? acceptanceCriteria : [],
    });
  };

  const label = isEpic
    ? "EPIC"
    : isFeature
      ? "FEATURE"
      : isStory
        ? "STORY"
        : "SUB-TASK";
  const title = isEpic
    ? "Create Epic"
    : isFeature
      ? "Create Feature"
      : isStory
        ? "Create Story"
        : "Create Sub-task";
  const icon = isEpic ? "E" : isFeature ? "F" : isStory ? "S" : "✓";
  const tone = isEpic ? "epic" : isFeature ? "feature" : isStory ? "story" : "subtask";

  return (
    <aside className="smart-node-panel" onDoubleClick={(event) => event.stopPropagation()}>
      <div className="smart-panel-header">
        <div className="smart-panel-title-area">
          <div className={`smart-panel-icon ${tone}`}>{icon}</div>

          <div style={{ minWidth: 0 }}>
            <div className="smart-panel-meta">
              <span className={`smart-panel-type ${tone}`}>NEW {label}</span>
              <span className="smart-status idle">Draft</span>
            </div>
            <h2>{title}</h2>
          </div>
        </div>

        <button
          type="button"
          className="smart-panel-close"
          onClick={onClose}
          title="Close creator"
        >
          ×
        </button>
      </div>

      <div className="smart-panel-content">
        <div className="smart-create-banner">
          <strong>Review before Jira creation</strong>
          <span>
            This item is added only to the workflow canvas. It will use your existing
            Save Changes and Create JIRA Tickets flow.
          </span>
        </div>

        {!isEpic && (
          <div className="smart-field">
            <label>
              Parent {isFeature ? "Epic" : isStory ? "Feature" : "Story"}
              <span className="smart-required">*</span>
            </label>

            <select
              value={parentId}
              onChange={(event) => {
                setParentId(event.target.value);
                setValidationError("");
              }}
            >
              <option value="">
                Select {isFeature ? "an Epic" : isStory ? "a Feature" : "a Story"}...
              </option>
              {parentOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.summary}
                </option>
              ))}
            </select>

            {selectedParent && (
              <div className="smart-parent-preview">
                Parent:
                <strong>{selectedParent.summary}</strong>
              </div>
            )}

            {parentOptions.length === 0 && (
              <div className="smart-validation">
                {isFeature
                  ? "Create an Epic first. A Feature must belong to an Epic."
                  : isStory
                    ? "Create a Feature first. A Story should belong to a Feature."
                    : "Create a Story first. A Sub-task must belong to a Story."}
              </div>
            )}
          </div>
        )}

        <div className="smart-field">
          <label>
            Summary<span className="smart-required">*</span>
          </label>
          <input
            className="smart-summary-input"
            value={summary}
            onChange={(event) => {
              setSummary(event.target.value);
              setValidationError("");
            }}
            placeholder={
              isEpic
                ? "e.g. Customer onboarding modernization"
                : isFeature
                  ? "e.g. Identity and access enablement"
                  : isStory
                    ? "e.g. Implement secure login flow"
                    : "e.g. Add API validation"
            }
            maxLength={120}
            autoFocus
          />
          <div className="smart-helper-row">
            <span>Keep it concise and action-oriented.</span>
            <span>{summary.length}/120</span>
          </div>
        </div>

        <div className="smart-field">
          <label>Description</label>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Describe the expected outcome, context, and important implementation details..."
          />
        </div>

        {isStory && (
          <>
            <div className="smart-field">
              <label>Story Points</label>
              <div className="smart-points">
                {[1, 2, 3, 5, 8, 13].map((point) => (
                  <button
                    type="button"
                    key={point}
                    className={Number(storyPoints) === point ? "selected" : ""}
                    onClick={() => setStoryPoints(point)}
                  >
                    {point}
                  </button>
                ))}
              </div>
            </div>

            <div className="smart-field">
              <div className="smart-section-heading">
                <label>Acceptance Criteria</label>
                <span className="smart-section-count">{acceptanceCriteria.length}</span>
              </div>

              {acceptanceCriteria.length > 0 ? (
                <div className="smart-list">
                  {acceptanceCriteria.map((criteria, index) => (
                    <div className="smart-list-item" key={`${criteria}-${index}`}>
                      <span className="smart-check">✓</span>
                      <span className="smart-list-text">{criteria}</span>
                      <button type="button" onClick={() => removeCriteria(index)}>
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="smart-empty">No acceptance criteria added yet.</div>
              )}

              <div className="smart-add-row">
                <input
                  value={newCriteria}
                  onChange={(event) => setNewCriteria(event.target.value)}
                  placeholder="Add acceptance criterion..."
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addCriteria();
                    }
                  }}
                />
                <button type="button" onClick={addCriteria} title="Add criterion">
                  +
                </button>
              </div>
            </div>
          </>
        )}

        {validationError && <div className="smart-validation">{validationError}</div>}
      </div>

      <div className="smart-panel-footer">
        <div className="smart-change-state create">New workflow item</div>
        <div className="smart-footer-actions">
          <button type="button" className="smart-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="smart-save smart-create-save"
            onClick={handleCreate}
            disabled={!canCreate}
          >
            Add {isEpic ? "Epic" : isFeature ? "Feature" : isStory ? "Story" : "Sub-task"}
          </button>
        </div>
      </div>
    </aside>
  );
}

// =========================================================
// Relationship Selector
// =========================================================

function RelationshipSelector({ sourceNode, targetNode, onChoose, onCancel }) {
  const hierarchyAllowed = canCreateHierarchy(sourceNode, targetNode);

  return (
    <div className="relationship-backdrop" onClick={onCancel}>
      <div className="relationship-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="relationship-dialog-header">
          <div>
            <span className="relationship-eyebrow">Create relationship</span>
            <h3>{sourceNode?.data?.summary || "Work item"} → {targetNode?.data?.summary || "Work item"}</h3>
          </div>
          <button type="button" className="relationship-close" onClick={onCancel}>×</button>
        </div>

        <div className="relationship-options">
          {hierarchyAllowed && (
            <button type="button" onClick={() => onChoose("hierarchy", "parent_child")}>
              <strong>Parent / child</strong>
              <span>Move the target under the source in the backlog hierarchy.</span>
            </button>
          )}

          <button type="button" onClick={() => onChoose("dependency", "depends_on")}>
            <strong>Depends on</strong>
            <span>The source needs the target to be completed first.</span>
          </button>

          <button type="button" onClick={() => onChoose("dependency", "blocks")}>
            <strong>Blocks</strong>
            <span>The source prevents the target from progressing.</span>
          </button>

          <button type="button" onClick={() => onChoose("dependency", "relates_to")}>
            <strong>Relates to</strong>
            <span>Keep a non-blocking planning relationship between the items.</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// =========================================================
// React Flow Node / Edge Types
// =========================================================

const nodeTypes = {
  epic: EpicNode,
  feature: FeatureNode,
  story: StoryNode,
};

const edgeTypes = {
  customEdge: CustomEdge,
};

// =========================================================
// Create Skeleton Diagram
// =========================================================

function createSkeletonDiagram() {
  const nodes = [];
  const edges = [];

  const laneId = "skeleton-lane";
  const epicId = "skeleton-epic";

  const storyCount = 3;

  const storyGap = 40;

  const totalStoriesWidth =
    storyCount * STORY_WIDTH + (storyCount - 1) * storyGap;

  const lanePaddingX = 40;
  const lanePaddingY = 40;

  const epicToStoryGap = 80;

  const laneWidth = lanePaddingX * 2 + Math.max(EPIC_WIDTH, totalStoriesWidth);

  const laneHeight =
    lanePaddingY * 2 + EPIC_HEIGHT + epicToStoryGap + STORY_BASE_HEIGHT;

  // -------------------------------------------------------
  // Skeleton lane
  // -------------------------------------------------------

  nodes.push({
    id: laneId,
    type: "group",
    position: {
      x: 40,
      y: 40,
    },
    data: {
      label: "",
    },
    style: {
      width: laneWidth,
      height: laneHeight,
      background: "rgba(248, 250, 252, 0.8)",
      border: "1px solid #E2E8F0",
      borderRadius: 18,
    },
    draggable: false,
    selectable: false,
  });

  // -------------------------------------------------------
  // Skeleton Epic
  // -------------------------------------------------------

  nodes.push({
    id: epicId,
    type: "epic",
    parentId: laneId,
    extent: "parent",
    position: {
      x: (laneWidth - EPIC_WIDTH) / 2,
      y: lanePaddingY,
    },
    style: {
      width: EPIC_WIDTH,
      height: EPIC_HEIGHT,
      opacity: 0.55,
      filter: "grayscale(1)",
    },
    data: {
      issue_type: "Epic",
      summary: "Analyzing workflow...",
      description: "Generating your workflow structure",
      storyCount: storyCount,
    },
  });

  // -------------------------------------------------------
  // Skeleton Stories
  // -------------------------------------------------------

  const storiesRowY = lanePaddingY + EPIC_HEIGHT + epicToStoryGap;

  let startX = (laneWidth - totalStoriesWidth) / 2;

  for (let i = 0; i < storyCount; i++) {
    const storyId = `${epicId}-story-${i}`;

    nodes.push({
      id: storyId,
      type: "story",
      parentId: laneId,
      position: {
        x: startX,
        y: storiesRowY,
      },
      style: {
        width: STORY_WIDTH,
        height: STORY_BASE_HEIGHT,
        opacity: 0.5,
        filter: "grayscale(1)",
      },
      data: {
        issue_type: "Story",
        summary: "Building story...",
        description: "Processing requirements...",
        storyPoints: null,
        tasks: [
          {
            issue_type: "Task",
            summary: "Generating task...",
            description: "",
            parent: "Building story...",
          },
          {
            issue_type: "Task",
            summary: "Analyzing acceptance criteria...",
            description: "",
            parent: "Building story...",
          },
        ],
      },
    });

    edges.push({
      id: `${epicId}-${storyId}`,
      source: epicId,
      sourceHandle: "bottom",
      target: storyId,
      targetHandle: "top",
      type: "customEdge",
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: "#94A3B8",
      },
      data: {
        edgeType: "secondary",
        animated: true,
      },
    });

    startX += STORY_WIDTH + storyGap;
  }

  return {
    nodes,
    edges,
  };
}

// =========================================================
// Smart Responsive Workflow Layout
// =========================================================

const LAYOUT_MARGIN_X = 36;
const LAYOUT_MARGIN_Y = 36;
const LANE_GAP_X = 28;
const LANE_GAP_Y = 28;
const LANE_PADDING_X = 32;
const LANE_PADDING_Y = 30;
const EPIC_TO_FEATURE_GAP = 48;
const FEATURE_TO_STORY_GAP = 42;
const FEATURE_GAP_X = 24;
const STORY_GAP_X = 24;
const STORY_GAP_Y = 24;
const MAX_STORIES_PER_ROW = 3;

function layoutWorkflowNodes(inputNodes, dimensions) {
  if (!Array.isArray(inputNodes) || inputNodes.length === 0) {
    return inputNodes;
  }

  const viewportWidth = Math.max(Number(dimensions?.width) || 1440, 900);
  const availableCanvasWidth = Math.max(viewportWidth - LAYOUT_MARGIN_X * 2, 760);

  const nodes = inputNodes.map((node) => ({
    ...node,
    position: node.position ? { ...node.position } : { x: 0, y: 0 },
    style: node.style ? { ...node.style } : {},
    data: node.data ? { ...node.data } : {},
  }));

  const groups = nodes.filter((node) => node.type === "group");
  const groupOrder = new Map(groups.map((group, index) => [group.id, index]));

  const laneLayouts = groups
    .map((group) => {
      const epic = nodes.find(
        (node) => node.type === "epic" && node.parentId === group.id,
      );

      if (!epic) {
        return null;
      }

      const features = nodes.filter(
        (node) => node.type === "feature" && node.parentId === group.id,
      );

      const stories = nodes.filter(
        (node) => node.type === "story" && node.parentId === group.id,
      );

      const storyColumns = Math.max(
        1,
        Math.min(
          MAX_STORIES_PER_ROW,
          Math.floor(
            (availableCanvasWidth - LANE_PADDING_X * 2 + STORY_GAP_X) /
              (STORY_WIDTH + STORY_GAP_X),
          ),
        ),
      );

      const featureColumns = Math.max(1, Math.min(3, features.length || 1));
      const visibleStoryColumns = Math.max(1, Math.min(stories.length || 1, storyColumns));
      const visibleFeatureColumns = Math.max(1, Math.min(features.length || 1, featureColumns));

      const storyGridWidth =
        visibleStoryColumns * STORY_WIDTH +
        Math.max(0, visibleStoryColumns - 1) * STORY_GAP_X;
      const featureGridWidth =
        visibleFeatureColumns * FEATURE_WIDTH +
        Math.max(0, visibleFeatureColumns - 1) * FEATURE_GAP_X;

      const laneWidth = Math.min(
        availableCanvasWidth,
        Math.max(
          EPIC_WIDTH + LANE_PADDING_X * 2,
          storyGridWidth + LANE_PADDING_X * 2,
          featureGridWidth + LANE_PADDING_X * 2,
        ),
      );

      epic.position = {
        x: (laneWidth - EPIC_WIDTH) / 2,
        y: LANE_PADDING_Y,
      };
      epic.style = { ...epic.style, width: EPIC_WIDTH, height: EPIC_HEIGHT };

      let currentY = LANE_PADDING_Y + EPIC_HEIGHT;

      if (features.length > 0) {
        currentY += EPIC_TO_FEATURE_GAP;
        const featureRows = Math.ceil(features.length / featureColumns);

        features.forEach((feature, index) => {
          const row = Math.floor(index / featureColumns);
          const column = index % featureColumns;
          const itemsInRow = Math.min(
            featureColumns,
            features.length - row * featureColumns,
          );
          const rowWidth =
            itemsInRow * FEATURE_WIDTH +
            Math.max(0, itemsInRow - 1) * FEATURE_GAP_X;
          const rowStartX = (laneWidth - rowWidth) / 2;

          feature.position = {
            x: rowStartX + column * (FEATURE_WIDTH + FEATURE_GAP_X),
            y: currentY + row * (FEATURE_HEIGHT + STORY_GAP_Y),
          };
          feature.style = {
            ...feature.style,
            width: FEATURE_WIDTH,
            height: FEATURE_HEIGHT,
          };
        });

        currentY +=
          featureRows * FEATURE_HEIGHT +
          Math.max(0, featureRows - 1) * STORY_GAP_Y +
          FEATURE_TO_STORY_GAP;
      } else {
        currentY += EPIC_TO_FEATURE_GAP;
      }

      const rowHeights = [];
      stories.forEach((story, index) => {
        const row = Math.floor(index / storyColumns);
        const storyHeight = Math.max(
          Number(story.style?.height) || STORY_BASE_HEIGHT,
          STORY_BASE_HEIGHT,
        );
        rowHeights[row] = Math.max(rowHeights[row] || 0, storyHeight);
      });

      const rowOffsets = [];
      let storyRowsHeight = 0;
      rowHeights.forEach((height, row) => {
        rowOffsets[row] = storyRowsHeight;
        storyRowsHeight += height;
        if (row < rowHeights.length - 1) {
          storyRowsHeight += STORY_GAP_Y;
        }
      });

      stories.forEach((story, index) => {
        const row = Math.floor(index / storyColumns);
        const column = index % storyColumns;
        const itemsInRow = Math.min(
          storyColumns,
          stories.length - row * storyColumns,
        );
        const rowWidth =
          itemsInRow * STORY_WIDTH +
          Math.max(0, itemsInRow - 1) * STORY_GAP_X;
        const rowStartX = (laneWidth - rowWidth) / 2;

        story.position = {
          x: rowStartX + column * (STORY_WIDTH + STORY_GAP_X),
          y: currentY + (rowOffsets[row] || 0),
        };
        story.style = {
          ...story.style,
          width: STORY_WIDTH,
          height: Math.max(
            Number(story.style?.height) || STORY_BASE_HEIGHT,
            STORY_BASE_HEIGHT,
          ),
        };
      });

      const laneHeight =
        stories.length > 0
          ? currentY + storyRowsHeight + LANE_PADDING_Y
          : currentY + LANE_PADDING_Y;

      group.style = {
        ...group.style,
        width: laneWidth,
        height: Math.max(laneHeight, LANE_PADDING_Y * 2 + EPIC_HEIGHT),
      };
      group.data = {
        ...group.data,
        label: epic.data?.summary || group.data?.label || "",
      };

      return {
        group,
        width: laneWidth,
        height: group.style.height,
        order: groupOrder.get(group.id) ?? 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.order - b.order);

  let cursorX = LAYOUT_MARGIN_X;
  let cursorY = LAYOUT_MARGIN_Y;
  let currentRowHeight = 0;

  laneLayouts.forEach((lane) => {
    const wouldOverflow =
      cursorX > LAYOUT_MARGIN_X &&
      cursorX + lane.width > viewportWidth - LAYOUT_MARGIN_X;

    if (wouldOverflow) {
      cursorX = LAYOUT_MARGIN_X;
      cursorY += currentRowHeight + LANE_GAP_Y;
      currentRowHeight = 0;
    }

    lane.group.position = { x: cursorX, y: cursorY };
    cursorX += lane.width + LANE_GAP_X;
    currentRowHeight = Math.max(currentRowHeight, lane.height);
  });

  return nodes;
}

// Reflow only the lanes whose hierarchy changed. This keeps the overall
// canvas stable while snapping children back into a clean grid inside their
// Epic lane. Lane positions and existing lane widths are preserved so a
// re-parent does not make the whole board jump or visually drift.
function relayoutAffectedLanes(inputNodes, groupIds, dimensions) {
  if (!Array.isArray(inputNodes) || inputNodes.length === 0) {
    return inputNodes;
  }

  const targetIds = [...new Set((groupIds || []).filter(Boolean))];
  if (targetIds.length === 0) return inputNodes;

  let result = inputNodes.map((node) => ({
    ...node,
    position: node.position ? { ...node.position } : { x: 0, y: 0 },
    style: node.style ? { ...node.style } : {},
    data: node.data ? { ...node.data } : {},
  }));

  targetIds.forEach((groupId) => {
    const originalGroup = result.find(
      (node) => node.id === groupId && node.type === "group",
    );
    if (!originalGroup) return;

    const laneNodes = result.filter(
      (node) => node.id === groupId || node.parentId === groupId,
    );
    if (laneNodes.length <= 1) return;

    const laidOutLane = layoutWorkflowNodes(laneNodes, dimensions);
    const laidOutGroup = laidOutLane.find((node) => node.id === groupId);
    if (!laidOutGroup) return;

    const laidOutById = new Map(laidOutLane.map((node) => [node.id, node]));
    const oldWidth = Number(originalGroup.style?.width) || 0;
    const newWidth = Number(laidOutGroup.style?.width) || oldWidth;
    const stableWidth = Math.max(oldWidth, newWidth);
    const xOffset = Math.max(0, (stableWidth - newWidth) / 2);

    result = result.map((node) => {
      const laidOutNode = laidOutById.get(node.id);
      if (!laidOutNode) return node;

      if (node.id === groupId) {
        return {
          ...node,
          // Never move the Epic lane itself during a child re-parent.
          position: { ...originalGroup.position },
          style: {
            ...node.style,
            ...laidOutGroup.style,
            width: stableWidth,
          },
          data: { ...node.data, ...laidOutGroup.data },
        };
      }

      return {
        ...node,
        position: {
          ...laidOutNode.position,
          x: (Number(laidOutNode.position?.x) || 0) + xOffset,
        },
        style: { ...node.style, ...laidOutNode.style },
      };
    });
  });

  return result;
}

// =========================================================
// Create Real Diagram
// =========================================================

function getReadinessIssues(issue, type) {
  const issues = [];
  const points = issue.story_points ?? issue.storyPoints;
  const ac = issue.acceptance_criteria ?? issue.acceptanceCriteria ?? [];
  const hasAc = Array.isArray(ac) ? ac.length > 0 : Boolean(ac);
  const hasDoD = issue.hasDoD ?? issue.has_dod ?? issue.HasDoD;

  if (["Story", "Task"].includes(type) && (points == null || Number(points) <= 0)) {
    issues.push("Missing estimate");
  }
  if (["Story", "Task"].includes(type) && !hasAc) {
    issues.push("Missing AC");
  }
  if (["Story", "Task"].includes(type) && !hasDoD) {
    issues.push("Missing DoD");
  }
  if (type === "Epic" && !(issue.sad_section_id || issue.sadSectionId || issue.SADSectionID)) {
    issues.push("Missing S-AD");
  }

  const importedWarnings = Array.isArray(issue.healthWarnings) ? issue.healthWarnings : [];
  importedWarnings.forEach((warning) => {
    if (warning && !issues.includes(warning)) issues.push(warning);
  });

  return issues;
}

function createDiagram(issuesData, onUpdateNodeData, edgeHandlers, dimensions) {
  const epics = issuesData.filter((issue) => issue.issue_type === "Epic");
  const nodes = [];
  const edges = [];

  epics.forEach((epic, epicIndex) => {
    const laneId = epic.laneId || `lane-${epicIndex}`;
    const epicId = epic.nodeId || `epic-${epicIndex}`;
    const features = issuesData.filter(
      (issue) => issue.issue_type === "Feature" && issue.parent === epic.summary,
    );
    const featureTitles = new Set(features.map((feature) => feature.summary));
    const directStories = issuesData.filter(
      (issue) =>
        ["Story", "Task"].includes(issue.issue_type) &&
        issue.parent === epic.summary,
    );
    const featureStories = issuesData.filter(
      (issue) =>
        ["Story", "Task"].includes(issue.issue_type) &&
        featureTitles.has(issue.parent),
    );
    const laneStories = [...directStories, ...featureStories];

    nodes.push({
      id: laneId,
      type: "group",
      position: { x: 0, y: 0 },
      data: { label: epic.summary },
      style: { width: 900, height: 600 },
      draggable: false,
      selectable: false,
    });

    nodes.push({
      id: epicId,
      type: "epic",
      parentId: laneId,
      position: { x: LANE_PADDING_X, y: LANE_PADDING_Y },
      style: { width: EPIC_WIDTH, height: EPIC_HEIGHT },
      data: {
        issue_type: "Epic",
        summary: epic.summary,
        description: epic.description,
        storyCount: laneStories.length,
        originalIssue: epic,
        onUpdate: onUpdateNodeData,
        jiraKey: epic.jiraKey || epic.jira_key || null,
        syncStatus: epic.jiraKey || epic.jira_key ? "created" : "idle",
        jiraError: null,
        changeState:
          epic.changeState || (epic.jiraKey || epic.jira_key ? "existing" : "new"),
        sadSectionId:
          epic.sad_section_id || epic.sadSectionId || epic.SADSectionID || "",
        priority: epic.priority || "Medium",
        status: epic.status || "To Do",
        sprint: epic.sprint || epic.sprintId || "",
        assignee: epic.assignee || "",
        hasDoD: Boolean(epic.hasDoD ?? epic.has_dod),
        readinessIssues: getReadinessIssues(epic, "Epic"),
        sourceOrigin: epic.sourceOrigin || "ai",
        sadSectionTitle: epic.sadSectionTitle || "",
        layer: epic.layer || "",
      },
    });

    const featureNodeBySummary = new Map();

    features.forEach((feature, featureIndex) => {
      const featureId = feature.nodeId || `${epicId}-feature-${featureIndex}`;
      const children = issuesData.filter(
        (issue) =>
          ["Story", "Task"].includes(issue.issue_type) &&
          issue.parent === feature.summary,
      );

      featureNodeBySummary.set(feature.summary, featureId);

      nodes.push({
        id: featureId,
        type: "feature",
        parentId: laneId,
          position: { x: LANE_PADDING_X, y: 0 },
        style: { width: FEATURE_WIDTH, height: FEATURE_HEIGHT },
        data: {
          issue_type: "Feature",
          summary: feature.summary,
          description: feature.description || "",
          childCount: children.length,
          originalIssue: feature,
          onUpdate: onUpdateNodeData,
          jiraKey: feature.jiraKey || feature.jira_key || null,
          syncStatus: feature.jiraKey || feature.jira_key ? "created" : "idle",
          jiraError: null,
          changeState:
            feature.changeState ||
            (feature.jiraKey || feature.jira_key ? "existing" : "new"),
          parentNodeId: epicId,
          sadSectionId:
            feature.sad_section_id ||
            feature.sadSectionId ||
            epic.sad_section_id ||
            epic.sadSectionId ||
            "",
          priority: feature.priority || "Medium",
          status: feature.status || "To Do",
          sprint: feature.sprint || feature.sprintId || "",
          assignee: feature.assignee || "",
          hasDoD: Boolean(feature.hasDoD ?? feature.has_dod),
          readinessIssues: getReadinessIssues(feature, "Feature"),
          sourceOrigin: feature.sourceOrigin || "ai",
          sadSectionTitle: feature.sadSectionTitle || "",
          layer: feature.layer || "",
        },
      });

      edges.push({
        id: `${epicId}-${featureId}`,
        source: epicId,
        sourceHandle: "bottom",
        target: featureId,
        targetHandle: "top",
        type: "customEdge",
        markerEnd: { type: MarkerType.ArrowClosed, color: "#334155" },
        data: {
          edgeType: "primary",
          animated: true,
          relationship: "hierarchy",
          ...edgeHandlers,
        },
      });
    });

    laneStories.forEach((story, storyIndex) => {
      const tasks = issuesData.filter(
        (issue) =>
          ["Sub-task", "Subtask", "Task"].includes(issue.issue_type) &&
          issue.parent === story.summary,
      );
      const storyId = story.nodeId || `${epicId}-story-${storyIndex}`;
      const storyReadinessIssues = getReadinessIssues(
        story,
        story.issue_type || "Story",
      );
      const storyHeight = calculateStoryHeight(
        tasks.length,
        storyReadinessIssues.length > 0,
      );
      const parentFeatureId = featureNodeBySummary.get(story.parent);
      const parentNodeId = parentFeatureId || epicId;

      nodes.push({
        id: storyId,
        type: "story",
        parentId: laneId,
          position: { x: LANE_PADDING_X, y: 0 },
        style: { width: STORY_WIDTH, height: storyHeight },
        data: {
          issue_type: story.issue_type || "Story",
          summary: story.summary,
          description: story.description || "",
          storyPoints: story.story_points ?? story.storyPoints,
          tasks,
          dependencies: story.dependencies || [],
          acceptanceCriteria:
            story.acceptance_criteria || story.acceptanceCriteria || [],
          definitionOfDone:
            story.definition_of_done || story.definitionOfDone || [],
          originalIssue: story,
          onUpdate: onUpdateNodeData,
          jiraKey: story.jiraKey || story.jira_key || null,
          syncStatus: story.jiraKey || story.jira_key ? "created" : "idle",
          jiraError: null,
          changeState:
            story.changeState ||
            (story.jiraKey || story.jira_key ? "existing" : "new"),
          parentNodeId,
          parentSummary: story.parent,
          sadSectionId:
            story.sad_section_id ||
            story.sadSectionId ||
            epic.sad_section_id ||
            epic.sadSectionId ||
            "",
          priority: story.priority || "Medium",
          status: story.status || "To Do",
          sprint: story.sprint || story.sprintId || "",
          assignee: story.assignee || "",
          hasDoD: Boolean(story.hasDoD ?? story.has_dod),
          readinessIssues: storyReadinessIssues,
          sourceOrigin: story.sourceOrigin || "ai",
          sadSectionTitle: story.sadSectionTitle || "",
          layer: story.layer || "",
          originalParentId: story.originalParentId || null,
        },
      });

      edges.push({
        id: `${parentNodeId}-${storyId}`,
        source: parentNodeId,
        sourceHandle: "bottom",
        target: storyId,
        targetHandle: "top",
        type: "customEdge",
        markerEnd: { type: MarkerType.ArrowClosed, color: "#334155" },
        data: {
          edgeType: "primary",
          animated: true,
          relationship: "hierarchy",
          ...edgeHandlers,
        },
      });
    });
  });

  return {
    nodes: layoutWorkflowNodes(nodes, dimensions),
    edges,
  };
}

// =========================================================
// Convert React Flow State -> issues.json
// =========================================================

function convertFlowToIssues(nodes, originalIssues) {
  const result = [];
  const epicNodes = nodes.filter((node) => node.type === "epic");
  const featureNodes = nodes.filter((node) => node.type === "feature");
  const storyNodes = nodes.filter((node) => node.type === "story");
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const commonFields = (node, original) => ({
    ...original,
    issue_type: node.data.issue_type || original.issue_type || "Story",
    summary: node.data.summary,
    description: node.data.description || "",
    nodeId: node.id,
    jiraKey:
      node.data.jiraKey || original.jiraKey || original.jira_key || null,
    changeState:
      node.data.changeState ||
      (node.data.jiraKey || original.jiraKey || original.jira_key
        ? "existing"
        : "new"),
    priority: node.data.priority || original.priority || "Medium",
    status: node.data.status || original.status || "To Do",
    sprint: node.data.sprint || original.sprint || original.sprintId || "",
    assignee: node.data.assignee || original.assignee || "",
    sad_section_id:
      node.data.sadSectionId ||
      original.sad_section_id ||
      original.sadSectionId ||
      "",
    hasDoD: Boolean(node.data.hasDoD),
  });

  epicNodes.forEach((node) => {
    result.push(commonFields(node, node.data.originalIssue || {}));
  });

  featureNodes.forEach((node) => {
    const original = node.data.originalIssue || {};
    const parentNode = nodeById.get(node.data.parentNodeId);
    const sameLaneEpic = epicNodes.find((epic) => epic.parentId === node.parentId);
    const parent =
      parentNode?.data?.summary || original.parent || sameLaneEpic?.data.summary || "";

    result.push({
      ...commonFields(node, original),
      issue_type: "Feature",
      parent,
    });
  });

  storyNodes.forEach((node) => {
    const original = node.data.originalIssue || {};
    const parentNode = nodeById.get(node.data.parentNodeId);
    const sameLaneEpic = epicNodes.find((epic) => epic.parentId === node.parentId);
    const parent =
      parentNode?.data?.summary || original.parent || sameLaneEpic?.data.summary || "";

    const storyIssue = {
      ...commonFields(node, original),
      issue_type: node.data.issue_type || "Story",
      story_points:
        node.data.storyPoints !== "" && node.data.storyPoints != null
          ? Number(node.data.storyPoints)
          : null,
      parent,
      dependencies: Array.isArray(node.data.dependencies)
        ? [...node.data.dependencies]
        : [],
      acceptance_criteria: Array.isArray(node.data.acceptanceCriteria)
        ? [...node.data.acceptanceCriteria]
        : [],
    };

    result.push(storyIssue);

    const tasks = Array.isArray(node.data.tasks) ? node.data.tasks : [];
    tasks.forEach((task) => {
      result.push({
        ...task,
        issue_type: task.issue_type || "Sub-task",
        parent: node.data.summary,
      });
    });
  });

  return result;
}


function BoardWorkspacePanel({
  summary,
  sourceName,
  search,
  onSearch,
  typeFilter,
  onTypeFilter,
  stateFilter,
  onStateFilter,
  showDependencies,
  onToggleDependencies,
  onLoadDemo,
  onImport,
  importBusy,
  importMessage,
  onOpenHealth,
  onOpenSprints,
  onOpenSad,
  onOpenChanges,
  changeRequestCount,
  onFit,
  fileInputRef,
}) {
  return (
    <div className="foreman-board-panel nodrag nopan">
      <div className="foreman-board-panel__header">
        <div>
          <div className="foreman-board-eyebrow">EXISTING BOARD</div>
          <strong>{sourceName || "Canvas workspace"}</strong>
        </div>
        {summary && <span className="foreman-board-count">{summary.total} tickets</span>}
      </div>

      <div className="foreman-board-actions">
        <button type="button" onClick={onLoadDemo}>Load Excel demo</button>
        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={importBusy}>
          {importBusy ? "Importing…" : "Import Excel"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls"
          hidden
          onChange={onImport}
        />
      </div>

      {importMessage && <div className="foreman-import-message">{importMessage}</div>}

      {summary && (
        <div className="foreman-summary-grid">
          <div><strong>{summary.epics}</strong><span>Epics</span></div>
          <div><strong>{summary.features}</strong><span>Features</span></div>
          <div><strong>{summary.stories}</strong><span>Stories</span></div>
          <div><strong>{summary.tasks}</strong><span>Tasks</span></div>
        </div>
      )}

      <label className="foreman-search-wrap">
        <span>⌕</span>
        <input value={search} onChange={(e) => onSearch(e.target.value)} placeholder="Search ticket, title, S-AD…" />
      </label>

      <div className="foreman-filter-row">
        <select value={typeFilter} onChange={(e) => onTypeFilter(e.target.value)}>
          <option value="all">All types</option>
          <option value="epic">Epic</option>
          <option value="feature">Feature</option>
          <option value="story">Story / Task</option>
        </select>
        <select value={stateFilter} onChange={(e) => onStateFilter(e.target.value)}>
          <option value="all">All states</option>
          <option value="existing">Existing</option>
          <option value="modified">Modified</option>
          <option value="new">New</option>
          <option value="warning">Warnings</option>
        </select>
      </div>

      <div className="foreman-board-secondary-actions">
        <button type="button" className={showDependencies ? "active" : ""} onClick={onToggleDependencies}>
          Dependencies {showDependencies ? "on" : "off"}
        </button>
        <button type="button" onClick={onFit}>Fit board</button>
      </div>

      {summary && (
        <div className="foreman-board-links">
          <button type="button" onClick={onOpenHealth}>
            Health <span className={summary.errors ? "health-badge error" : "health-badge"}>{summary.findings}</span>
          </button>
          <button type="button" onClick={onOpenSprints}>Sprint capacity</button>
          <button type="button" onClick={onOpenSad}>S-AD map</button>
          <button type="button" onClick={onOpenChanges}>Changes <span className="health-badge">{changeRequestCount || 0}</span></button>
        </div>
      )}
    </div>
  );
}

function HealthDrawer({ analysis, onClose, onSelectTicket }) {
  const [category, setCategory] = useState("all");
  const findings = analysis?.findings || [];
  const filtered = category === "all" ? findings : findings.filter((item) => item.category === category);
  const categories = ["all", "readiness", "hierarchy", "traceability", "dependency", "capacity"];

  return (
    <div className="foreman-drawer-backdrop" onClick={onClose}>
      <aside className="foreman-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="foreman-drawer-header">
          <div>
            <div className="foreman-board-eyebrow">FOREMAN HEALTH</div>
            <h3>{findings.length} findings</h3>
          </div>
          <button type="button" className="foreman-drawer-close" onClick={onClose}>×</button>
        </div>
        <div className="foreman-health-filters">
          {categories.map((item) => (
            <button key={item} className={category === item ? "active" : ""} onClick={() => setCategory(item)}>
              {item === "all" ? "All" : item}
            </button>
          ))}
        </div>
        <div className="foreman-health-list">
          {filtered.map((finding, index) => (
            <button
              key={`${finding.code}-${finding.ticketId || finding.sprintId || index}`}
              type="button"
              className={`foreman-health-card severity-${finding.severity || "warning"}`}
              onClick={() => finding.ticketId && onSelectTicket(finding.ticketId)}
            >
              <div className="foreman-health-card-title">
                <span>{finding.severity === "error" ? "!" : "⚠"}</span>
                <strong>{finding.title}</strong>
              </div>
              <p>{finding.detail}</p>
              {(finding.ticketId || finding.sprintId) && (
                <small>{finding.ticketId || finding.sprintId}{finding.ticketId ? " · Click to locate" : ""}</small>
              )}
            </button>
          ))}
          {!filtered.length && <div className="foreman-empty-state">No findings in this category.</div>}
        </div>
      </aside>
    </div>
  );
}

function SprintCapacityDrawer({ dataset, onClose }) {
  const sprints = dataset?.sprints || [];
  return (
    <div className="foreman-drawer-backdrop" onClick={onClose}>
      <aside className="foreman-drawer foreman-sprint-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="foreman-drawer-header">
          <div>
            <div className="foreman-board-eyebrow">CAPACITY VIEW</div>
            <h3>Sprint load</h3>
          </div>
          <button type="button" className="foreman-drawer-close" onClick={onClose}>×</button>
        </div>
        <div className="foreman-sprint-list">
          {sprints.map((sprint) => {
            const capacity = Number(sprint.PlannedCapacityPts || 0);
            const committed = Number(sprint.CommittedPts || 0);
            const pct = capacity > 0 ? Math.round((committed / capacity) * 100) : 0;
            return (
              <div className={`foreman-sprint-card ${pct > 100 ? "over" : ""}`} key={sprint.SprintID}>
                <div className="foreman-sprint-card-head">
                  <div><strong>{sprint.SprintName}</strong><small>{sprint.Status}</small></div>
                  <span>{committed}/{capacity} pts</span>
                </div>
                <div className="foreman-capacity-track"><div style={{ width: `${Math.min(pct, 100)}%` }} /></div>
                <div className="foreman-sprint-meta"><span>{sprint.StartDate}</span><span>{pct}% loaded</span></div>
              </div>
            );
          })}
        </div>
      </aside>
    </div>
  );
}


function SadTraceabilityDrawer({ dataset, onClose, onSelectTicket }) {
  const backlog = dataset?.backlog || [];
  const sections = dataset?.sadSections || [];
  return (
    <div className="foreman-drawer-backdrop" onClick={onClose}>
      <aside className="foreman-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="foreman-drawer-header">
          <div><div className="foreman-board-eyebrow">TRACEABILITY</div><h3>S-AD coverage</h3></div>
          <button type="button" className="foreman-drawer-close" onClick={onClose}>×</button>
        </div>
        <div className="foreman-sad-list">
          {sections.map((section) => {
            const linked = backlog.filter((item) => item.SADSectionID === section.SectionID);
            const firstEpic = linked.find((item) => item.Type === "Epic");
            return (
              <button key={section.SectionID} type="button" className="foreman-sad-card" onClick={() => firstEpic && onSelectTicket(firstEpic.TicketID)}>
                <div><strong>{section.SectionID}</strong><span>{section.ArchitectureLayer}</span></div>
                <h4>{section.SectionNumber} · {section.SectionTitle}</h4>
                <p>{section.Summary}</p>
                <small>{linked.length} linked backlog items{firstEpic ? " · Open Epic" : ""}</small>
              </button>
            );
          })}
        </div>
      </aside>
    </div>
  );
}

function ChangeRequestDrawer({ dataset, onClose }) {
  const changes = dataset?.changeRequests || [];
  return (
    <div className="foreman-drawer-backdrop" onClick={onClose}>
      <aside className="foreman-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="foreman-drawer-header">
          <div><div className="foreman-board-eyebrow">MID-SPRINT INTAKE</div><h3>{changes.length} change requests</h3></div>
          <button type="button" className="foreman-drawer-close" onClick={onClose}>×</button>
        </div>
        <div className="foreman-change-list">
          {changes.map((change) => (
            <div className="foreman-change-card" key={change.CRID}>
              <div className="foreman-change-card-head"><strong>{change.CRID}</strong><span>{change.Status}</span></div>
              <p>{change.RawText}</p>
              <div className="foreman-change-meta"><span>{change.Source}</span><span>{change.SuggestedType}</span><span>{change.TargetSprintID || "Unplanned"}</span></div>
              {change.PotentialDuplicateOf && <div className="foreman-duplicate-hint">Dataset reference: potential overlap requires semantic review.</div>}
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

function FlowCanvas() {
  const navigate = useNavigate();
  const location = useLocation();

  const [nodes, setNodes, onNodesChange] = useNodesState([]);

  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  const [issuesData, setIssuesData] = useState([]);

  const [jsonOutput, setJsonOutput] = useState(null);

  const [copied, setCopied] = useState(false);

  const [loading, setLoading] = useState(true);

  // An opted-in clarification round is evaluated before the canvas mounts, so
  // users answer questions before seeing the canvas loading animation.
  const [checkingClarifications, setCheckingClarifications] = useState(
    () => location.state?.clarificationsEnabled === true,
  );

  const [saving, setSaving] = useState(false);

  const [saveMessage, setSaveMessage] = useState("");

  const [syncing, setSyncing] = useState(false);

  const [syncMessage, setSyncMessage] = useState('');

  const [error, setError] = useState("");

  const [userInput, setUserInput] = useState("");

  const [selectedNodeId, setSelectedNodeId] = useState(null);

  const [showAddMenu, setShowAddMenu] = useState(false);

  const [createType, setCreateType] = useState(null);

  const [createDefaultParentId, setCreateDefaultParentId] = useState("");

  const [pendingConnection, setPendingConnection] = useState(null);

  const [undoSnapshot, setUndoSnapshot] = useState(null);

  const [canvasNotice, setCanvasNotice] = useState("");

  const [boardDataset, setBoardDataset] = useState(null);
  const [boardAnalysis, setBoardAnalysis] = useState(null);
  const [boardSummary, setBoardSummary] = useState(null);
  const [boardSourceName, setBoardSourceName] = useState("");
  const [boardSearch, setBoardSearch] = useState("");
  const [boardTypeFilter, setBoardTypeFilter] = useState("all");
  const [boardStateFilter, setBoardStateFilter] = useState("all");
  const [showDependencies, setShowDependencies] = useState(true);
  const [showHealthDrawer, setShowHealthDrawer] = useState(false);
  const [showSprintDrawer, setShowSprintDrawer] = useState(false);
  const [showSadDrawer, setShowSadDrawer] = useState(false);
  const [showChangeDrawer, setShowChangeDrawer] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const boardFileInputRef = useRef(null);

  // Clarification round-trip: when the backend needs more detail
  // before it can build a dependable plan.
  const [clarification, setClarification] = useState(null);

  const [clarificationAnswers, setClarificationAnswers] = useState([]);

  const [submittingClarification, setSubmittingClarification] = useState(false);

  const [sessionId, setSessionId] = useState(
    () => localStorage.getItem("scrumSessionId") || null,
  );

  const [dimensions, setDimensions] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });

  const { fitView, screenToFlowPosition } = useReactFlow();

  const rememberForUndo = useCallback(
    (label) => {
      setUndoSnapshot({
        label,
        nodes: nodes.map((node) => ({
          ...node,
          position: { ...node.position },
          style: { ...(node.style || {}) },
          data: { ...(node.data || {}) },
        })),
        edges: edges.map((edge) => ({
          ...edge,
          data: { ...(edge.data || {}) },
        })),
      });
    },
    [nodes, edges],
  );

  const handleUndo = useCallback(() => {
    if (!undoSnapshot) return;
    setNodes(undoSnapshot.nodes);
    setEdges(undoSnapshot.edges);
    setCanvasNotice(`Undid: ${undoSnapshot.label}`);
    setUndoSnapshot(null);
  }, [undoSnapshot, setNodes, setEdges]);

  // =======================================================
  // Resize
  // =======================================================

  useEffect(() => {
    const handleResize = () => {
      setDimensions({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };

    window.addEventListener("resize", handleResize);

    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // =======================================================
  // Edge Handlers
  // =======================================================

  const handleEdgeTypeToggle = useCallback(
    (edgeId, newType) => {
      setEdges((eds) =>
        eds.map((edge) => {
          if (edge.id !== edgeId) {
            return edge;
          }

          const isPrimary = newType === "primary";

          return {
            ...edge,

            markerEnd: {
              type: MarkerType.ArrowClosed,
              color: isPrimary ? "#334155" : "#94A3B8",
            },

            data: {
              ...edge.data,
              edgeType: newType,
            },
          };
        }),
      );
    },
    [setEdges],
  );

  const handleEdgeAnimToggle = useCallback(
    (edgeId) => {
      setEdges((eds) =>
        eds.map((edge) => {
          if (edge.id !== edgeId) {
            return edge;
          }

          return {
            ...edge,

            data: {
              ...edge.data,

              animated: !edge.data.animated,
            },
          };
        }),
      );
    },
    [setEdges],
  );

  const handleEdgeDelete = useCallback(
    (edgeId) => {
      setEdges((eds) => eds.filter((edge) => edge.id !== edgeId));
    },
    [setEdges],
  );

  const edgeHandlers = useMemo(
    () => ({
      onTypeToggle: handleEdgeTypeToggle,

      onAnimToggle: handleEdgeAnimToggle,

      onDelete: handleEdgeDelete,
    }),
    [handleEdgeTypeToggle, handleEdgeAnimToggle, handleEdgeDelete],
  );

  // =======================================================
  // Update Node Data
  // =======================================================

  const handleUpdateNodeData = useCallback(
    (nodeId, updatedFields) => {
      setNodes((currentNodes) => {
        const updatedNodes = currentNodes.map((node) => {
          if (node.id !== nodeId) {
            return node;
          }

          const updatedTasks = updatedFields.tasks ?? node.data.tasks ?? [];

          const updatedReadinessIssues = getReadinessIssues(
            {
              ...node.data.originalIssue,
              ...node.data,
              ...updatedFields,
              story_points:
                updatedFields.storyPoints ?? node.data.storyPoints,
              acceptance_criteria:
                updatedFields.acceptanceCriteria ?? node.data.acceptanceCriteria,
              hasDoD: updatedFields.hasDoD ?? node.data.hasDoD,
              sad_section_id:
                updatedFields.sadSectionId ?? node.data.sadSectionId,
            },
            node.data.issue_type ||
              (node.type === "epic"
                ? "Epic"
                : node.type === "feature"
                  ? "Feature"
                  : "Story"),
          );

          const newStoryHeight = calculateStoryHeight(
            updatedTasks.length,
            updatedReadinessIssues.length > 0,
          );

          return {
            ...node,

            style:
              node.type === "story"
                ? {
                    ...node.style,
                    height: newStoryHeight,
                  }
                : node.style,

            data: {
              ...node.data,
              ...updatedFields,
              changeState:
                node.data.jiraKey || node.data.changeState === "existing"
                  ? "modified"
                  : updatedFields.changeState || node.data.changeState || "new",
              readinessIssues: updatedReadinessIssues,
            },
          };
        });

        return layoutWorkflowNodes(updatedNodes, dimensions);
      });
    },
    [setNodes, dimensions],
  );

  const loadBoardDataset = useCallback(
    (dataset) => {
      const analysis = analyzeForemanDataset(dataset);
      const summary = getDatasetSummary(dataset, analysis);
      const importedIssues = buildCanvasIssues(dataset, analysis);
      const diagram = createDiagram(
        importedIssues,
        handleUpdateNodeData,
        edgeHandlers,
        dimensions,
      );

      const dependencyEdges = analysis.validDependencies
        .filter((dep) => diagram.nodes.some((node) => node.id === dep.from) && diagram.nodes.some((node) => node.id === dep.to))
        .map((dep) => ({
          id: `dataset-${dep.DependencyID}`,
          source: dep.from,
          sourceHandle: "bottom",
          target: dep.to,
          targetHandle: "top",
          type: "customEdge",
          markerEnd: { type: MarkerType.ArrowClosed, color: "#64748B" },
          data: {
            edgeType: "secondary",
            animated: false,
            relationship: "dependency",
            dependencyType: String(dep.DependencyType || "requires").toLowerCase(),
            note: dep.Notes || "",
            ...edgeHandlers,
          },
        }));

      setBoardDataset(dataset);
      setBoardAnalysis(analysis);
      setBoardSummary(summary);
      setBoardSourceName(dataset.source || "Imported Excel board");
      setIssuesData(importedIssues);
      setNodes(diagram.nodes);
      setEdges([...diagram.edges, ...dependencyEdges]);
      setSelectedNodeId(null);
      setClarification(null);
      setError("");
      setLoading(false);
      setImportMessage(`Loaded ${summary.total} tickets · ${summary.findings} health findings`);

      setTimeout(() => {
        fitView({ padding: 0.04, duration: 500 });
      }, 100);
    },
    [dimensions, edgeHandlers, fitView, handleUpdateNodeData, setEdges, setNodes],
  );

  const handleLoadBundledDataset = useCallback(() => {
    try {
      const dataset = getBundledForemanDataset();
      loadBoardDataset(dataset);
      setCanvasNotice("Existing Excel backlog loaded into Canvas.");
    } catch (err) {
      setImportMessage(err.message || "Could not load bundled dataset.");
    }
  }, [loadBoardDataset]);

  const handleExcelImport = useCallback(async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setImportBusy(true);
    setImportMessage(`Reading ${file.name}…`);
    try {
      const dataset = await parseForemanWorkbook(file);
      loadBoardDataset(dataset);
      setCanvasNotice(`${file.name} loaded into Foreman.`);
    } catch (err) {
      console.error("Excel import failed", err);
      setImportMessage(`Import failed: ${err.message || "Invalid workbook"}`);
    } finally {
      setImportBusy(false);
      event.target.value = "";
    }
  }, [loadBoardDataset]);

  const focusBoardTicket = useCallback((ticketId) => {
    const target = nodes.find((node) => node.id === ticketId);
    if (!target) {
      setCanvasNotice(`Ticket ${ticketId} is not currently visible.`);
      return;
    }
    setSelectedNodeId(ticketId);
    setShowHealthDrawer(false);
    requestAnimationFrame(() => fitView({ nodes: [target], padding: 0.5, duration: 450 }));
  }, [nodes, fitView]);

  const displayedNodes = useMemo(() => {
    const query = boardSearch.trim().toLowerCase();
    return nodes.map((node) => {
      if (node.type === "group") return node;
      const matchesType = boardTypeFilter === "all" || node.type === boardTypeFilter;
      const state = node.data?.changeState || (node.data?.jiraKey ? "existing" : "new");
      const hasWarning = (node.data?.readinessIssues || []).length > 0;
      const matchesState =
        boardStateFilter === "all" ||
        (boardStateFilter === "warning" ? hasWarning : state === boardStateFilter);
      const haystack = [
        node.id,
        node.data?.jiraKey,
        node.data?.summary,
        node.data?.sadSectionId,
        node.data?.assignee,
        node.data?.sprint,
      ].filter(Boolean).join(" ").toLowerCase();
      const matchesSearch = !query || haystack.includes(query);
      const match = matchesType && matchesState && matchesSearch;
      return {
        ...node,
        style: {
          ...(node.style || {}),
          opacity: match ? 1 : 0.16,
          transition: "opacity 160ms ease",
        },
      };
    });
  }, [nodes, boardSearch, boardTypeFilter, boardStateFilter]);

  const displayedEdges = useMemo(
    () => showDependencies ? edges : edges.filter((edge) => edge.data?.relationship !== "dependency"),
    [edges, showDependencies],
  );

  // Keep the workflow packed when the browser is resized.
  useEffect(() => {
    setNodes((currentNodes) =>
      layoutWorkflowNodes(currentNodes, dimensions),
    );
  }, [dimensions.width, dimensions.height, setNodes]);

  // =======================================================
  // Hierarchy re-parenting
  // =======================================================

  const reparentWorkItem = useCallback(
    (childId, newParentId, reason = "Move work item") => {
      const child = nodes.find((node) => node.id === childId);
      const newParent = nodes.find((node) => node.id === newParentId);
      if (!child || !newParent || !canCreateHierarchy(newParent, child)) {
        setCanvasNotice("That hierarchy relationship is not valid.");
        return false;
      }

      const destinationEpic =
        newParent.type === "epic"
          ? newParent
          : nodes.find(
              (node) =>
                node.type === "epic" && node.parentId === newParent.parentId,
            );
      if (!destinationEpic) {
        setCanvasNotice("Could not determine the destination Epic.");
        return false;
      }

      const sourceGroupId = child.parentId;
      const destinationGroupId = destinationEpic.parentId;

      rememberForUndo(reason);

      setNodes((currentNodes) => {
        const next = currentNodes.map((node) => {
          if (node.id !== childId) return node;

          const inheritedSad =
            newParent.data?.sadSectionId || destinationEpic.data?.sadSectionId || "";
          const originalIssue = {
            ...(node.data?.originalIssue || {}),
            parent: newParent.data?.summary || "",
          };

          return {
            ...node,
            parentId: destinationEpic.parentId,
            extent: undefined,
            data: {
              ...node.data,
              parentNodeId: newParent.id,
              sadSectionId: inheritedSad,
              originalIssue,
              changeState:
                node.data?.jiraKey || node.data?.changeState === "existing"
                  ? "modified"
                  : node.data?.changeState || "new",
            },
          };
        });

        return relayoutAffectedLanes(
          next,
          [sourceGroupId, destinationGroupId],
          dimensions,
        );
      });

      setEdges((currentEdges) => {
        const withoutOldHierarchy = currentEdges.filter(
          (edge) =>
            !(edge.target === childId && edge.data?.relationship === "hierarchy"),
        );

        return [
          ...withoutOldHierarchy,
          {
            id: `hierarchy-${newParent.id}-${childId}-${Date.now()}`,
            source: newParent.id,
            sourceHandle: "bottom",
            target: childId,
            targetHandle: "top",
            type: "customEdge",
            markerEnd: { type: MarkerType.ArrowClosed, color: "#475569" },
            data: {
              edgeType: "primary",
              animated: true,
              relationship: "hierarchy",
              ...edgeHandlers,
            },
          },
        ];
      });

      setCanvasNotice(
        `${child.data?.summary || "Work item"} moved under ${newParent.data?.summary || "new parent"}.`,
      );
      return true;
    },
    [nodes, setNodes, setEdges, dimensions, edgeHandlers, rememberForUndo],
  );

  const handleNodeDragStop = useCallback(
    (event, draggedNode) => {
      if (!draggedNode) return;

      // Always preserve a normal free-drag position. Empty-space drops are
      // repositioning only unless that empty space belongs to another Epic lane.
      setNodes((currentNodes) =>
        currentNodes.map((node) =>
          node.id === draggedNode.id
            ? { ...node, position: { ...draggedNode.position } }
            : node,
        ),
      );

      if (!["feature", "story"].includes(draggedNode.type)) {
        return;
      }

      const currentNode =
        nodes.find((node) => node.id === draggedNode.id) || draggedNode;

      const nodesWithDraggedPosition = nodes.map((node) =>
        node.id === draggedNode.id
          ? { ...node, position: { ...draggedNode.position } }
          : node,
      );

      const dragRect = getAbsoluteNodeRect(
        { ...currentNode, position: draggedNode.position },
        nodesWithDraggedPosition,
      );

      // Use the actual mouse/pointer position, converted into React Flow
      // coordinates. This works correctly with zoom and pan and is much more
      // reliable than checking the centre of a large Story card.
      const dropPoint =
        Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)
          ? screenToFlowPosition({ x: event.clientX, y: event.clientY })
          : { x: dragRect.cx, y: dragRect.cy };

      const validParentTypes =
        draggedNode.type === "feature" ? ["epic"] : ["feature", "epic"];

      // 1) Direct card drop: Feature/Epic card under the pointer.
      const cardCandidates = nodesWithDraggedPosition
        .filter(
          (node) =>
            node.id !== draggedNode.id && validParentTypes.includes(node.type),
        )
        .map((node) => ({
          node,
          rect: getAbsoluteNodeRect(node, nodesWithDraggedPosition),
        }))
        .filter(({ rect }) => pointInsideRect(dropPoint, rect, 12))
        .sort((a, b) => {
          // If a Feature and its Epic overlap visually, a Story dropped on the
          // Feature should belong to the Feature.
          if (draggedNode.type === "story" && a.node.type !== b.node.type) {
            return a.node.type === "feature" ? -1 : 1;
          }
          const da = Math.hypot(
            dropPoint.x - a.rect.cx,
            dropPoint.y - a.rect.cy,
          );
          const db = Math.hypot(
            dropPoint.x - b.rect.cx,
            dropPoint.y - b.rect.cy,
          );
          return da - db;
        });

      let target = cardCandidates[0]?.node || null;

      // 2) Lane drop: dropping into the large empty area belonging to another
      // Epic should also map the item to that Epic. This is important because
      // the UI visually presents each rounded group/lane as the Epic workspace.
      if (!target) {
        const laneCandidates = nodesWithDraggedPosition
          .filter((node) => node.type === "group")
          .map((group) => ({
            group,
            rect: getAbsoluteNodeRect(group, nodesWithDraggedPosition),
          }))
          .filter(({ rect }) => pointInsideRect(dropPoint, rect, 0))
          .sort((a, b) => {
            const da = Math.hypot(
              dropPoint.x - a.rect.cx,
              dropPoint.y - a.rect.cy,
            );
            const db = Math.hypot(
              dropPoint.x - b.rect.cx,
              dropPoint.y - b.rect.cy,
            );
            return da - db;
          });

        for (const { group } of laneCandidates) {
          // Dropping inside the Story's current Epic lane is a layout action,
          // not a hierarchy change. Snap the lane back to its clean grid.
          if (group.id === currentNode.parentId) {
            setNodes((currentNodes) =>
              relayoutAffectedLanes(currentNodes, [group.id], dimensions),
            );
            setCanvasNotice("Work item aligned inside its Epic lane.");
            return;
          }

          const laneEpic = nodesWithDraggedPosition.find(
            (node) => node.type === "epic" && node.parentId === group.id,
          );
          if (laneEpic) {
            target = laneEpic;
            break;
          }
        }
      }

      // 3) Forgiving overlap fallback for cases where the pointer ends just
      // outside the card/lane boundary but the dragged card clearly overlaps it.
      if (!target) {
        const overlapArea = (a, b) => {
          const left = Math.max(a.x, b.x);
          const top = Math.max(a.y, b.y);
          const right = Math.min(a.x + a.width, b.x + b.width);
          const bottom = Math.min(a.y + a.height, b.y + b.height);
          return Math.max(0, right - left) * Math.max(0, bottom - top);
        };

        const overlaps = nodesWithDraggedPosition
          .filter(
            (node) =>
              node.id !== draggedNode.id && validParentTypes.includes(node.type),
          )
          .map((node) => {
            const rect = getAbsoluteNodeRect(node, nodesWithDraggedPosition);
            const area = overlapArea(dragRect, rect);
            return {
              node,
              ratio: area / Math.max(1, rect.width * rect.height),
            };
          })
          .filter(({ ratio }) => ratio >= 0.12)
          .sort((a, b) => {
            if (draggedNode.type === "story" && a.node.type !== b.node.type) {
              return a.node.type === "feature" ? -1 : 1;
            }
            return b.ratio - a.ratio;
          });

        target = overlaps[0]?.node || null;
      }

      // No destination = ordinary free positioning. If the user drops on the
      // current parent, keep the hierarchy and simply snap the lane back into
      // a clean, deterministic layout.
      if (!target) {
        return;
      }

      if (target.id === currentNode.data?.parentNodeId) {
        const groupId = currentNode.parentId || target.parentId;
        setNodes((currentNodes) =>
          relayoutAffectedLanes(currentNodes, [groupId], dimensions),
        );
        setCanvasNotice("Work item aligned inside its current parent.");
        return;
      }

      reparentWorkItem(
        draggedNode.id,
        target.id,
        `Move ${draggedNode.type} to ${target.data?.summary || target.type}`,
      );
    },
    [nodes, reparentWorkItem, screenToFlowPosition, setNodes, dimensions],
  );

  // =======================================================
  // Smart Add Work Item
  // =======================================================

  const epicOptions = useMemo(
    () =>
      nodes
        .filter((node) => node.type === "epic")
        .map((node) => ({
          id: node.id,
          summary: node.data.summary || "Untitled Epic",
        })),
    [nodes],
  );

  const featureOptions = useMemo(
    () =>
      nodes
        .filter((node) => node.type === "feature")
        .map((node) => ({
          id: node.id,
          summary: node.data.summary || "Untitled Feature",
        })),
    [nodes],
  );

  const storyOptions = useMemo(
    () =>
      nodes
        .filter((node) => node.type === "story")
        .map((node) => ({
          id: node.id,
          summary: node.data.summary || "Untitled Story",
        })),
    [nodes],
  );

  const openCreatePanel = useCallback(
    (type) => {
      let defaultParentId = "";
      const selectedNode = nodes.find((node) => node.id === selectedNodeId);

      if (type === "feature") {
        defaultParentId =
          selectedNode?.type === "epic"
            ? selectedNode.id
            : epicOptions[0]?.id || "";
      }

      if (type === "story") {
        defaultParentId =
          selectedNode?.type === "feature"
            ? selectedNode.id
            : featureOptions[0]?.id || epicOptions[0]?.id || "";
      }

      if (type === "subtask") {
        defaultParentId =
          selectedNode?.type === "story"
            ? selectedNode.id
            : storyOptions[0]?.id || "";
      }

      setCreateDefaultParentId(defaultParentId);
      setSelectedNodeId(null);
      setShowAddMenu(false);
      setCreateType(type);
    },
    [
      nodes,
      selectedNodeId,
      epicOptions,
      featureOptions,
      storyOptions,
    ],
  );

  const handleCreateWorkItem = useCallback(
    ({
      type,
      parentId,
      summary,
      description,
      storyPoints,
      acceptanceCriteria,
    }) => {
      if (type === "epic") {
        const laneId = createStableId("lane");
        const epicId = createStableId("epic");
        const newLane = {
          id: laneId,
          type: "group",
          position: { x: 40, y: 40 },
          data: { label: summary },
          style: { width: 760, height: 430 },
          draggable: false,
          selectable: false,
        };
        const newEpic = {
          id: epicId,
          type: "epic",
          parentId: laneId,
          position: { x: 40, y: 40 },
          style: { width: EPIC_WIDTH, height: EPIC_HEIGHT },
          data: {
            issue_type: "Epic",
            summary,
            description,
            storyCount: 0,
            originalIssue: { issue_type: "Epic", summary, description },
            onUpdate: handleUpdateNodeData,
            jiraKey: null,
            syncStatus: "idle",
            jiraError: null,
            changeState: "new",
            sadSectionId: "",
            priority: "Medium",
            status: "To Do",
            sprint: "",
            assignee: "",
            hasDoD: false,
            readinessIssues: ["Missing S-AD"],
          },
        };

        setNodes((current) =>
          layoutWorkflowNodes([...current, newLane, newEpic], dimensions),
        );
        setCreateType(null);
        setCreateDefaultParentId("");
        setTimeout(() => fitView({ padding: 0.08, duration: 400 }), 50);
        return;
      }

      if (type === "feature") {
        const epicNode = nodes.find(
          (node) => node.id === parentId && node.type === "epic",
        );
        if (!epicNode) return;

        const featureId = createStableId(`${epicNode.id}-feature`);
        const newFeature = {
          id: featureId,
          type: "feature",
          parentId: epicNode.parentId,
          position: { x: 40, y: 280 },
          style: { width: FEATURE_WIDTH, height: FEATURE_HEIGHT },
          data: {
            issue_type: "Feature",
            summary,
            description,
            childCount: 0,
            parentNodeId: epicNode.id,
            originalIssue: {
              issue_type: "Feature",
              summary,
              description,
              parent: epicNode.data.summary,
            },
            onUpdate: handleUpdateNodeData,
            jiraKey: null,
            syncStatus: "idle",
            jiraError: null,
            changeState: "new",
            sadSectionId: epicNode.data.sadSectionId || "",
            priority: "Medium",
            status: "To Do",
            sprint: "",
            assignee: "",
            hasDoD: false,
            readinessIssues: [],
          },
        };

        const newEdge = {
          id: `${epicNode.id}-${featureId}`,
          source: epicNode.id,
          sourceHandle: "bottom",
          target: featureId,
          targetHandle: "top",
          type: "customEdge",
          markerEnd: { type: MarkerType.ArrowClosed, color: "#334155" },
          data: {
            edgeType: "primary",
            animated: true,
            relationship: "hierarchy",
            ...edgeHandlers,
          },
        };

        setNodes((current) =>
          layoutWorkflowNodes([...current, newFeature], dimensions),
        );
        setEdges((current) => [...current, newEdge]);
        setCreateType(null);
        setCreateDefaultParentId("");
        return;
      }

      if (type === "story") {
        const parentNode = nodes.find(
          (node) =>
            node.id === parentId && ["feature", "epic"].includes(node.type),
        );
        if (!parentNode) return;

        const epicNode =
          parentNode.type === "epic"
            ? parentNode
            : nodes.find(
                (node) =>
                  node.type === "epic" && node.parentId === parentNode.parentId,
              );
        if (!epicNode) return;

        const storyId = createStableId(`${epicNode.id}-story`);
        const storyIssue = {
          issue_type: "Story",
          summary,
          description,
          parent: parentNode.data.summary,
          story_points: storyPoints,
          dependencies: [],
          acceptance_criteria: acceptanceCriteria || [],
          hasDoD: false,
        };
        const newStory = {
          id: storyId,
          type: "story",
          parentId: epicNode.parentId,
          position: { x: 40, y: 480 },
          style: { width: STORY_WIDTH, height: STORY_BASE_HEIGHT },
          data: {
            issue_type: "Story",
            summary,
            description,
            storyPoints,
            tasks: [],
            dependencies: [],
            acceptanceCriteria: acceptanceCriteria || [],
            parentNodeId: parentNode.id,
            originalIssue: storyIssue,
            onUpdate: handleUpdateNodeData,
            jiraKey: null,
            syncStatus: "idle",
            jiraError: null,
            changeState: "new",
            sadSectionId:
              parentNode.data.sadSectionId || epicNode.data.sadSectionId || "",
            priority: "Medium",
            status: "To Do",
            sprint: "",
            assignee: "",
            hasDoD: false,
            readinessIssues: getReadinessIssues(storyIssue, "Story"),
          },
        };

        const newEdge = {
          id: `${parentNode.id}-${storyId}`,
          source: parentNode.id,
          sourceHandle: "bottom",
          target: storyId,
          targetHandle: "top",
          type: "customEdge",
          markerEnd: { type: MarkerType.ArrowClosed, color: "#334155" },
          data: {
            edgeType: "primary",
            animated: true,
            relationship: "hierarchy",
            ...edgeHandlers,
          },
        };

        setNodes((current) => {
          const next = current
            .map((node) => {
              if (node.id === epicNode.id) {
                return {
                  ...node,
                  data: {
                    ...node.data,
                    storyCount: (node.data.storyCount || 0) + 1,
                  },
                };
              }
              if (node.id === parentNode.id && node.type === "feature") {
                return {
                  ...node,
                  data: {
                    ...node.data,
                    childCount: (node.data.childCount || 0) + 1,
                  },
                };
              }
              return node;
            })
            .concat(newStory);
          return layoutWorkflowNodes(next, dimensions);
        });
        setEdges((current) => [...current, newEdge]);
        setCreateType(null);
        setCreateDefaultParentId("");
        return;
      }

      if (type === "subtask") {
        setNodes((currentNodes) => {
          const updatedNodes = currentNodes.map((node) => {
            if (node.id !== parentId || node.type !== "story") return node;

            const existingTasks = Array.isArray(node.data.tasks)
              ? node.data.tasks
              : [];
            const newTask = {
              issue_type: "Sub-task",
              summary,
              description,
              parent: node.data.summary,
              nodeId: createStableId(`${node.id}-task`),
              jiraKey: null,
            };
            const updatedTasks = [...existingTasks, newTask];

            return {
              ...node,
              style: {
                ...node.style,
                height: calculateStoryHeight(
                  updatedTasks.length,
                  (node.data.readinessIssues || []).length > 0,
                ),
              },
              data: {
                ...node.data,
                tasks: updatedTasks,
                changeState:
                  node.data.jiraKey || node.data.changeState === "existing"
                    ? "modified"
                    : node.data.changeState || "new",
              },
            };
          });

          return layoutWorkflowNodes(updatedNodes, dimensions);
        });

        setCreateType(null);
        setCreateDefaultParentId("");
      }
    },
    [
      nodes,
      setNodes,
      setEdges,
      fitView,
      edgeHandlers,
      handleUpdateNodeData,
      dimensions,
    ],
  );

  // =======================================================
  // API CALL
  // =======================================================

  // =======================================================
  // Shared backend-response handling
  // =======================================================
  // Used by both the initial generation call (text or file) and
  // the "answer a clarification question" follow-up call, so both
  // paths react to "complete" / "needs_clarification" / "general"
  // / "error" the exact same way.

  const applyBackendResponse = useCallback(
    (data, isCancelled) => {
      if (data.session_id) {
        setSessionId(data.session_id);
        localStorage.setItem("scrumSessionId", data.session_id);
      }

      if (data.status === "general") {
        if (!isCancelled()) {
          localStorage.removeItem("scrumSessionId");

          navigate("/input", {
            state: {
              message:
                data.message || "Please enter a request related to Scrum.",
            },
          });
        }

        return;
      }

      if (data.status === "needs_clarification") {
        if (!isCancelled()) {
          setClarification({
            message: data.message || "I need a bit more detail.",
            questions: (Array.isArray(data.questions) ? data.questions : []).slice(0, 4),
          });
          setClarificationAnswers(
            (Array.isArray(data.questions) ? data.questions : []).slice(0, 4).map(() => ""),
          );

          setNodes([]);
          setEdges([]);
          setError("");
          setLoading(false);
        }

        return;
      }

      if (data.status !== "complete") {
        throw new Error(
          data.message || data.error?.message || "Unexpected response from server.",
        );
      }

      if (!data.jira_payload || !Array.isArray(data.jira_payload)) {
        throw new Error(
          "Backend response does not contain a valid jira_payload array.",
        );
      }

      if (isCancelled()) {
        return;
      }

      setClarification(null);
      localStorage.removeItem("scrumSessionId");

      setIssuesData(data.jira_payload);

      const diagram = createDiagram(
        data.jira_payload,
        handleUpdateNodeData,
        edgeHandlers,
        dimensions,
      );

      setNodes(diagram.nodes);
      setEdges(diagram.edges);

      setTimeout(() => {
        if (!isCancelled()) {
          fitView({
            padding: 0.08,
            duration: 500,
          });
        }
      }, 100);
    },
    [dimensions, edgeHandlers, fitView, handleUpdateNodeData, navigate],
  );

  // =======================================================
  // Answer a pending clarification question
  // =======================================================

  const handleClarificationSubmit = async (e) => {
    e.preventDefault();

    const answers = clarificationAnswers.map((answer) => answer.trim());

    if (answers.some((answer) => !answer) || submittingClarification) {
      return;
    }

    setSubmittingClarification(true);
    setError("");
    setClarification(null);
    setLoading(true);

    // The answers are now being turned into the final backlog, so transition
    // from the question screen to the same canvas skeleton used for generation.
    const skeleton = createSkeletonDiagram();
    setNodes(skeleton.nodes);
    setEdges(skeleton.edges);

    setTimeout(() => {
      fitView({ padding: 0.08, duration: 400 });
    }, 50);

    try {
      const response = await fetch(`${API_BASE_URL}/api/process`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session_id: sessionId,
          clarification_answers: answers,
        }),
      });

      const data = await response.json();

      if (!response.ok && data.status !== "needs_clarification") {
        throw new Error(
          data.error?.message || data.message || `Backend returned ${response.status}`,
        );
      }

      setClarificationAnswers([]);

      applyBackendResponse(data, () => false);
    } catch (err) {
      console.error("Clarification submit failed:", err);
      setError(err.message || "Failed to submit your answer.");
      setNodes([]);
      setEdges([]);
    } finally {
      setSubmittingClarification(false);
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;

    async function processWorkflow() {
      // ---------------------------------------------------
      // Resume saved progress — if this session was already
      // saved (via "Save Changes"), reload straight from
      // issues.json instead of regenerating/blanking the
      // canvas, so a page refresh doesn't lose your work.
      // ---------------------------------------------------

      const hasSavedProgress =
        localStorage.getItem("hasSavedProgress") === "true";

      if (hasSavedProgress) {
        try {
          const savedResponse = await fetch(`/api/issues`);

          if (savedResponse.ok) {
            const savedIssues = await savedResponse.json();

            if (Array.isArray(savedIssues) && savedIssues.length > 0) {
              if (!cancelled) {
                setIssuesData(savedIssues);

                const diagram = createDiagram(
                  savedIssues,
                  handleUpdateNodeData,
                  edgeHandlers,
                  dimensions,
                );

                setNodes(diagram.nodes);
                setEdges(diagram.edges);
                setError("");
                setLoading(false);

                setTimeout(() => {
                  if (!cancelled) {
                    fitView({
                      padding: 0.08,
                      duration: 400,
                    });
                  }
                }, 100);
              }

              return;
            }
          }
        } catch (err) {
          console.warn(
            "Could not restore saved progress, falling back:",
            err,
          );
        }
      }

      // ---------------------------------------------------
      // Blank canvas mode — user chose to skip the prompt
      // and start with an empty canvas they build manually.
      // ---------------------------------------------------

      const isBlankCanvas = localStorage.getItem("canvasMode") === "blank";

      if (isBlankCanvas) {
        if (!cancelled) {
          setNodes([]);
          setEdges([]);
          setError("");
          setLoading(false);
        }

        return;
      }

      // ---------------------------------------------------
      // Figure out which intake mode this session started
      // with — an uploaded file (passed via router state from
      // the Input page) or typed text (in localStorage).
      // ---------------------------------------------------

      const uploadedFile = location.state?.uploadedFile || null;
      const clarificationsEnabled = location.state?.clarificationsEnabled === true;
      const storedInput = localStorage.getItem("userInput");

      if (!uploadedFile && (!storedInput || !storedInput.trim())) {
        if (!cancelled) {
          setError(
            "No workflow description was found. Please go back and enter your workflow.",
          );

          setLoading(false);
        }

        return;
      }

      const trimmedInput = storedInput ? storedInput.trim() : "";

      if (!cancelled) {
        setUserInput(trimmedInput);

        setLoading(true);
        setError("");

        if (!clarificationsEnabled) {
          // Standard generation retains the immediate canvas skeleton.
          const skeleton = createSkeletonDiagram();
          setNodes(skeleton.nodes);
          setEdges(skeleton.edges);

          setTimeout(() => {
            if (!cancelled) {
              fitView({
                padding: 0.08,
                duration: 400,
              });
            }
          }, 50);
        }
      }

      try {
        // -------------------------------------------------
        // Send request to Python backend — either the
        // uploaded file (multipart) or typed text (JSON).
        // -------------------------------------------------

        let response;

        if (uploadedFile) {
          console.log("Sending uploaded file to backend:", uploadedFile.name);

          const formData = new FormData();
          formData.append("file", uploadedFile);
          formData.append("clarifications_enabled", String(clarificationsEnabled));

          const query = sessionId
            ? `?session_id=${encodeURIComponent(sessionId)}`
            : "";

          response = await fetch(
            `${API_BASE_URL}/api/process/file${query}`,
            {
              method: "POST",
              body: formData,
            },
          );
        } else {
          console.log("Sending workflow to backend:", trimmedInput);

          response = await fetch(`${API_BASE_URL}/api/process`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              session_id: sessionId,
              message: trimmedInput,
              clarifications_enabled: clarificationsEnabled,
            }),
          });
        }

        // -------------------------------------------------
        // Parse response
        // -------------------------------------------------

        const data = await response.json();

        console.log("Backend response:", data);

        if (!response.ok && data.status !== "needs_clarification") {
          throw new Error(
            data.error?.message ||
              data.message ||
              `Backend returned ${response.status}`,
          );
        }

        if (!cancelled) {
          setCheckingClarifications(false);
        }
        applyBackendResponse(data, () => cancelled);
      } catch (err) {
        console.error("Workflow processing failed:", err);

        if (!cancelled) {
          setCheckingClarifications(false);
          setError(err.message || "Failed to process workflow.");

          // Clear skeleton on error
          setNodes([]);
          setEdges([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    processWorkflow();

    return () => {
      cancelled = true;
    };
  }, []);

  // ===========
  // JIRA status node
  // ===========

  const updateJiraNodeStatus = useCallback(
    (
      nodeId,
      status,
      jiraKey = null,
      error = null
    ) => {
      setNodes((currentNodes) =>
        currentNodes.map((node) => {
          if (node.id !== nodeId) {
            return node;
          }

          return {
            ...node,

            data: {
              ...node.data,

              syncStatus: status,

              jiraKey:
                jiraKey ||
                node.data.jiraKey ||
                null,

              jiraError: error,
            },
          };
        })
      );
    },
    [setNodes]
  );

  // ===========
  // Synn to JIRA
  // ===========

  const handleSyncToJira =
    useCallback(async () => {
      if (syncing) {
        return;
      }

      let eventSource = null;

      try {
        setSyncing(true);

        setSyncMessage(
          'Starting Jira synchronization...'
        );

        // Convert current diagram into Jira payload
        const workflowIssues =
          convertFlowToIssues(
            nodes,
            issuesData
          );

        // Mark nodes that will participate
        setNodes((currentNodes) =>
          currentNodes.map((node) => ({
            ...node,

            data: {
              ...node.data,

              syncStatus:
                node.data.jiraKey
                  ? 'created'
                  : 'idle',

              jiraError: null,
            },
          }))
        );

        // ------------------------------------------------
        // Start backend sync job
        // ------------------------------------------------

        const response =
          await fetch(
            `${API_BASE_URL}/api/jira/sync`,
            {
              method: 'POST',

              headers: {
                'Content-Type':
                  'application/json',
              },

              body: JSON.stringify({
                issues:
                  workflowIssues,
              }),
            }
          );

        const result =
          await response.json();

        if (!response.ok) {
          throw new Error(
            result.error ||
            'Failed to start Jira synchronization'
          );
        }

        const jobId =
          result.jobId;

        if (!jobId) {
          throw new Error(
            'Backend did not return jobId'
          );
        }

        setSyncMessage(
          'Jira sync started...'
        );

        // ------------------------------------------------
        // Connect to SSE
        // ------------------------------------------------

        eventSource =
          new EventSource(
            `${API_BASE_URL}/api/jira/sync/${jobId}/events`
          );

        eventSource.onmessage =
          (event) => {
            try {
              const update =
                JSON.parse(
                  event.data
                );

              console.log(
                'Jira Sync:',
                update
              );

              // ------------------------------------------
              // Creating
              // ------------------------------------------

              if (
                update.status ===
                'syncing'
              ) {
                updateJiraNodeStatus(
                  update.nodeId,
                  'syncing'
                );

                setSyncMessage(
                  `Creating ${update.issue_type}: ${update.summary}`
                );

                return;
              }

              // ------------------------------------------
              // Created
              // ------------------------------------------

              if (
                update.status ===
                  'created' ||
                update.status ===
                  'skipped'
              ) {
                updateJiraNodeStatus(
                  update.nodeId,
                  'created',
                  update.key
                );

                setSyncMessage(
                  `✓ ${update.issue_type}: ${update.key}`
                );

                return;
              }

              // ------------------------------------------
              // Failed
              // ------------------------------------------

              if (
                update.status ===
                'failed'
              ) {
                updateJiraNodeStatus(
                  update.nodeId,
                  'failed',
                  null,
                  update.error
                );

                setSyncMessage(
                  `✕ ${update.summary}`
                );

                return;
              }

              // ------------------------------------------
              // Complete
              // ------------------------------------------

              if (
                update.status ===
                'completed'
              ) {
                setSyncMessage(
                  '✓ Jira synchronization completed'
                );

                eventSource.close();

                setSyncing(false);

                return;
              }

              // ------------------------------------------
              // Job failed
              // ------------------------------------------

              if (
                update.status ===
                'job_failed'
              ) {
                setSyncMessage(
                  `✕ Jira synchronization failed: ${
                    update.error ||
                    'Unknown error'
                  }`
                );

                eventSource.close();

                setSyncing(false);
              }
            } catch (error) {
              console.error(
                'Invalid SSE event',
                error
              );
            }
          };

        eventSource.onerror =
          (error) => {
            console.error(
              'SSE connection error',
              error
            );

            eventSource.close();

            setSyncing(false);

            setSyncMessage(
              '✕ Lost connection to Jira sync service'
            );
          };
      } catch (error) {
        console.error(
          'Jira sync failed:',
          error
        );

        if (eventSource) {
          eventSource.close();
        }

        setSyncing(false);

        setSyncMessage(
          `✕ ${error.message}`
        );
      }
    }, [
      syncing,
      nodes,
      issuesData,
      setNodes,
      updateJiraNodeStatus,
    ]); 


  // =======================================================
  // Connect Nodes
  // =======================================================

  const onConnect = useCallback(
    (params) => {
      if (!params?.source || !params?.target || params.source === params.target) {
        setCanvasNotice("Choose two different work items.");
        return;
      }

      const sourceNode = nodes.find((node) => node.id === params.source);
      const targetNode = nodes.find((node) => node.id === params.target);
      if (!sourceNode || !targetNode || ["group"].includes(sourceNode.type) || ["group"].includes(targetNode.type)) {
        setCanvasNotice("Relationships can only be created between work items.");
        return;
      }

      setPendingConnection({ params, sourceNode, targetNode });
    },
    [nodes],
  );

  const handleRelationshipChoice = useCallback(
    (relationship, dependencyType) => {
      if (!pendingConnection) return;
      const { params, sourceNode, targetNode } = pendingConnection;

      if (relationship === "hierarchy") {
        if (!canCreateHierarchy(sourceNode, targetNode)) {
          setCanvasNotice(`A ${sourceNode.type} cannot be the parent of a ${targetNode.type}.`);
          setPendingConnection(null);
          return;
        }
        reparentWorkItem(
          targetNode.id,
          sourceNode.id,
          `Re-parent ${targetNode.data?.summary || targetNode.type}`,
        );
        setPendingConnection(null);
        return;
      }

      const duplicate = edges.some(
        (edge) =>
          edge.data?.relationship === "dependency" &&
          edge.source === params.source &&
          edge.target === params.target &&
          edge.data?.dependencyType === dependencyType,
      );
      if (duplicate) {
        setCanvasNotice("That dependency already exists.");
        setPendingConnection(null);
        return;
      }

      rememberForUndo(`Add ${dependencyType.replaceAll("_", " ")} dependency`);
      setEdges((eds) =>
        addEdge(
          {
            ...params,
            id: `dependency-${params.source}-${params.target}-${Date.now()}`,
            type: "customEdge",
            markerEnd: {
              type: MarkerType.ArrowClosed,
              color: "#64748B",
            },
            data: {
              edgeType: "secondary",
              animated: false,
              relationship: "dependency",
              dependencyType,
              ...edgeHandlers,
            },
          },
          eds,
        ),
      );
      setCanvasNotice(`Dependency created: ${dependencyType.replaceAll("_", " ")}.`);
      setPendingConnection(null);
    },
    [pendingConnection, reparentWorkItem, edges, setEdges, edgeHandlers, rememberForUndo],
  );

  // =======================================================
  // SAVE TO issues.json
  // =======================================================

  const handleSaveChanges = async () => {
    if (saving) {
      return;
    }

    try {
      setSaving(true);
      setSaveMessage("");

      const updatedIssues = convertFlowToIssues(nodes, issuesData);

      // Note: issues.json is served by the local Express server
      // (server.cjs on port 3001), not the Python backend at
      // API_BASE_URL. Use a relative path so Vite's dev proxy
      // (see vite.config.js) forwards it to the right place.
      const response = await fetch(`/api/issues`, {
        method: "PUT",

        headers: {
          "Content-Type": "application/json",
        },

        body: JSON.stringify(updatedIssues),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Failed to save issues.json");
      }

      setIssuesData(updatedIssues);

      const formatted = JSON.stringify(updatedIssues, null, 2);

      setJsonOutput(formatted);

      setCopied(false);

      // Remember that this session has saved progress, so a
      // page reload restores it instead of starting over.
      localStorage.setItem("hasSavedProgress", "true");

      setSaveMessage(`✓ Saved ${updatedIssues.length} issues to issues.json`);
    } catch (error) {
      console.error(error);

      setSaveMessage(`✕ Save failed: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  // =======================================================
  // Copy JSON
  // =======================================================

  const handleCopy = async () => {
    if (!jsonOutput) {
      return;
    }

    try {
      await navigator.clipboard.writeText(jsonOutput);

      setCopied(true);

      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Copy failed:", error);
    }
  };

  // =======================================================
  // Clarification Screen
  // =======================================================

  if (checkingClarifications) {
    return (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#F8FAFC", padding: "24px" }}>
        <div style={{ width: "min(440px, 100%)", background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: "16px", padding: "32px", boxShadow: "0 10px 30px rgba(15, 23, 42, 0.08)", textAlign: "center" }}>
          <div style={{ color: "#2563EB", fontSize: "12px", fontWeight: 700, letterSpacing: "0.02em", textTransform: "uppercase", marginBottom: "10px" }}>Preparing your plan</div>
          <h2 style={{ margin: "0 0 8px", color: "#0F172A" }}>Reviewing your input</h2>
          <p style={{ margin: 0, color: "#475569", fontSize: "14px", lineHeight: 1.5 }}>We’re checking for the details needed to create ready-to-plan stories and tasks.</p>
        </div>
      </div>
    );
  }

  if (clarification && !loading) {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#F8FAFC",
          padding: "24px",
        }}
      >
        <div
          style={{
            width: "min(560px, 100%)",
            background: "#FFFFFF",
            border: "1px solid #E2E8F0",
            borderRadius: "16px",
            padding: "32px",
            boxShadow: "0 10px 30px rgba(15, 23, 42, 0.08)",
          }}
        >
          <div
            style={{
              fontSize: "12px",
              fontWeight: 700,
              letterSpacing: "0.02em",
              textTransform: "uppercase",
              color: "#2563EB",
              marginBottom: "10px",
            }}
          >
            A few more details
          </div>

          <h2
            style={{
              margin: "0 0 16px",
              color: "#0F172A",
            }}
          >
            {clarification.message}
          </h2>

          <form onSubmit={handleClarificationSubmit}>
            {clarification.questions.map((question, index) => (
              <label key={index} style={{ display: "block", marginBottom: "14px", color: "#334155", fontSize: "14px", fontWeight: 600 }}>
                {index + 1}. {question}
                <textarea
                  value={clarificationAnswers[index] || ""}
                  onChange={(e) => setClarificationAnswers((answers) => answers.map((answer, answerIndex) => answerIndex === index ? e.target.value : answer))}
                  placeholder="Your answer..."
                  required
                  style={{ width: "100%", minHeight: "76px", resize: "vertical", padding: "10px 12px", border: "1px solid #CBD5E1", borderRadius: "8px", fontSize: "14px", fontFamily: "inherit", marginTop: "7px", boxSizing: "border-box" }}
                />
              </label>
            ))}

            {error && (
              <div
                style={{
                  color: "#B91C1C",
                  fontSize: "13px",
                  marginBottom: "14px",
                }}
              >
                {error}
              </div>
            )}

            <div style={{ display: "flex", gap: "10px" }}>
              <button
                type="submit"
                disabled={submittingClarification}
                style={{
                  border: "none",
                  borderRadius: "8px",
                  background: submittingClarification ? "#93C5FD" : "#2563EB",
                  color: "#FFFFFF",
                  padding: "10px 18px",
                  cursor: submittingClarification ? "default" : "pointer",
                  fontWeight: 600,
                }}
              >
                {submittingClarification ? "Sending..." : "Send answer"}
              </button>

              <button
                type="button"
                onClick={() => navigate("/start")}
                style={{
                  border: "1px solid #CBD5E1",
                  borderRadius: "8px",
                  background: "#FFFFFF",
                  color: "#334155",
                  padding: "10px 18px",
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                Start over
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  // =======================================================
  // Error Screen
  // =======================================================

  if (error && !loading) {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#F8FAFC",
          padding: "24px",
        }}
      >
        <div
          style={{
            width: "min(560px, 100%)",
            background: "#FFFFFF",
            border: "1px solid #FECACA",
            borderRadius: "16px",
            padding: "32px",
            boxShadow: "0 10px 30px rgba(15, 23, 42, 0.08)",
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontSize: "40px",
              marginBottom: "16px",
            }}
          >
            ⚠️
          </div>

          <h2
            style={{
              margin: "0 0 10px",
              color: "#991B1B",
            }}
          >
            Unable to create workflow
          </h2>

          <p
            style={{
              color: "#64748B",
              lineHeight: 1.6,
              marginBottom: "24px",
            }}
          >
            {error}
          </p>

          <button
            onClick={() => window.location.reload()}
            style={{
              border: "none",
              borderRadius: "8px",
              background: "#2563EB",
              color: "#FFFFFF",
              padding: "10px 18px",
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  // =======================================================
  // Render
  // =======================================================

  return (
    <>
      <ReactFlow
        nodes={displayedNodes}
        edges={displayedEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStop={handleNodeDragStop}
        onNodeDoubleClick={(event, node) => {
          event.preventDefault();

          if (["epic", "feature", "story"].includes(node.type)) {
            setCreateType(null);
            setCreateDefaultParentId("");
            setShowAddMenu(false);
            setSelectedNodeId(node.id);
          }
        }}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionMode={ConnectionMode.Loose}
        connectionRadius={25}
        proOptions={{
          hideAttribution: true,
        }}
      >
        <Background
          variant={BackgroundVariant.Lines}
          color="#E2E8F0"
          gap={28}
          size={1}
        />

        <Controls />

        <Panel position="top-left" className="foreman-board-panel-wrap">
          <BoardWorkspacePanel
            summary={boardSummary}
            sourceName={boardSourceName}
            search={boardSearch}
            onSearch={setBoardSearch}
            typeFilter={boardTypeFilter}
            onTypeFilter={setBoardTypeFilter}
            stateFilter={boardStateFilter}
            onStateFilter={setBoardStateFilter}
            showDependencies={showDependencies}
            onToggleDependencies={() => setShowDependencies((value) => !value)}
            onLoadDemo={handleLoadBundledDataset}
            onImport={handleExcelImport}
            importBusy={importBusy}
            importMessage={importMessage}
            onOpenHealth={() => setShowHealthDrawer(true)}
            onOpenSprints={() => setShowSprintDrawer(true)}
            onOpenSad={() => setShowSadDrawer(true)}
            onOpenChanges={() => setShowChangeDrawer(true)}
            changeRequestCount={boardDataset?.changeRequests?.length || 0}
            onFit={() => fitView({ padding: 0.05, duration: 400 })}
            fileInputRef={boardFileInputRef}
          />
        </Panel>

        <Panel position="top-right" className="panel-actions">
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
              Analyzing your workflow...
            </div>
          )}

          {!loading && (
            <>
              {undoSnapshot && (
                <button type="button" className="btn-canvas-undo" onClick={handleUndo}>
                  ↶ Undo
                </button>
              )}

              {canvasNotice && (
                <span className="canvas-notice" title={canvasNotice}>
                  {canvasNotice}
                </span>
              )}

              <button
                className="btn-save-json"
                onClick={handleSaveChanges}
                disabled={saving}
              >
                {saving ? "⏳ Saving..." : "💾 Save Changes"}
              </button>

              <button
                className="btn-jira-submit"
                onClick={handleSyncToJira}
                disabled={syncing}
              >
                {syncing ? "⏳ Syncing to JIRA..." : "🔄 Create JIRA Tickets"}
              </button>

              {syncMessage && (
                <span className="sync-message">
                  {syncMessage}
                </span>
          )}
          </>
          )}

          {saveMessage && (
            <span
              style={{
                background: "#FFFFFF",
                border: "1px solid #E2E8F0",
                borderRadius: "6px",
                padding: "7px 10px",
                fontSize: "11px",
                color: saveMessage.startsWith("✓") ? "#047857" : "#B91C1C",
              }}
            >
              {saveMessage}
            </span>
          )}
        </Panel>

        {!loading && (
          <Panel position="bottom-right" className="add-work-item-wrapper">
            <div className="add-work-item-container">
              {showAddMenu && (
                <div className="add-work-item-menu">
                  <div className="add-work-item-menu-header">Add work item</div>

                  <button
                    type="button"
                    className="add-work-item-option"
                    onClick={() => openCreatePanel("epic")}
                  >
                    <span className="add-type-icon epic">E</span>
                    <span>
                      <strong>Epic</strong>
                      <small>Create a new work stream or business capability.</small>
                    </span>
                  </button>

                  <button
                    type="button"
                    className="add-work-item-option"
                    onClick={() => openCreatePanel("feature")}
                  >
                    <span className="add-type-icon feature">F</span>
                    <span>
                      <strong>Feature</strong>
                      <small>Add a capability under an existing Epic.</small>
                    </span>
                  </button>

                  <button
                    type="button"
                    className="add-work-item-option"
                    onClick={() => openCreatePanel("story")}
                  >
                    <span className="add-type-icon story">S</span>
                    <span>
                      <strong>Story</strong>
                      <small>Add user-facing work under an existing Feature.</small>
                    </span>
                  </button>

                  <button
                    type="button"
                    className="add-work-item-option"
                    onClick={() => openCreatePanel("subtask")}
                  >
                    <span className="add-type-icon subtask">✓</span>
                    <span>
                      <strong>Sub-task</strong>
                      <small>Add implementation work under an existing Story.</small>
                    </span>
                  </button>
                </div>
              )}

              <button
                type="button"
                className="smart-add-work-item"
                onClick={() => setShowAddMenu((current) => !current)}
              >
                <span className="plus">+</span>
                Add work item
              </button>
            </div>
          </Panel>
        )}
      </ReactFlow>

      {showHealthDrawer && boardAnalysis && (
        <HealthDrawer
          analysis={boardAnalysis}
          onClose={() => setShowHealthDrawer(false)}
          onSelectTicket={focusBoardTicket}
        />
      )}

      {showSprintDrawer && boardDataset && (
        <SprintCapacityDrawer
          dataset={boardDataset}
          onClose={() => setShowSprintDrawer(false)}
        />
      )}

      {showSadDrawer && boardDataset && (
        <SadTraceabilityDrawer
          dataset={boardDataset}
          onClose={() => setShowSadDrawer(false)}
          onSelectTicket={focusBoardTicket}
        />
      )}

      {showChangeDrawer && boardDataset && (
        <ChangeRequestDrawer
          dataset={boardDataset}
          onClose={() => setShowChangeDrawer(false)}
        />
      )}

      {pendingConnection && (
        <RelationshipSelector
          sourceNode={pendingConnection.sourceNode}
          targetNode={pendingConnection.targetNode}
          onChoose={handleRelationshipChoice}
          onCancel={() => setPendingConnection(null)}
        />
      )}

      {createType && (
        <CreateWorkItemPanel
          type={createType}
          epicOptions={epicOptions}
          featureOptions={featureOptions}
          storyOptions={storyOptions}
          defaultParentId={createDefaultParentId}
          onClose={() => {
            setCreateType(null);
            setCreateDefaultParentId("");
          }}
          onCreate={handleCreateWorkItem}
        />
      )}

      {selectedNodeId && (
        <NodeEditPanel
          node={nodes.find((node) => node.id === selectedNodeId)}
          onClose={() => setSelectedNodeId(null)}
          onSave={handleUpdateNodeData}
        />
      )}

      {/* ===================================================
          JSON Modal
      =================================================== */}

      {jsonOutput && (
        <div
          className="json-modal-backdrop"
          onClick={() => setJsonOutput(null)}
        >
          <div className="json-modal" onClick={(e) => e.stopPropagation()}>
            <div className="json-modal-header">
              <div>
                <h3>Saved Workflow JSON</h3>

                <p>This is the exact payload written to issues.json.</p>
              </div>

              <div className="json-modal-actions">
                <button className="btn-copy" onClick={handleCopy}>
                  {copied ? "✓ Copied!" : "Copy Payload"}
                </button>

                <button
                  className="btn-close"
                  onClick={() => setJsonOutput(null)}
                >
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
    </>
  );
}

// =========================================================
// App
// =========================================================

export default function App() {
  return (
    <div className="flow-container">
      <ReactFlowProvider>
        <FlowCanvas />
      </ReactFlowProvider>
    </div>
  );
}
