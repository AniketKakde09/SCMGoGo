import { useMemo, useState, useCallback, useEffect } from "react";
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

// =========================================================
// Backend Configuration
// =========================================================

const API_BASE_URL = "http://localhost:8000";

// =========================================================
// Base Component Dimensions
// =========================================================

const EPIC_WIDTH = 290;
const EPIC_HEIGHT = 210;

const STORY_WIDTH = 320;
const STORY_BASE_HEIGHT = 170;
const STORY_TASK_HEIGHT = 28;

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

  const isPrimary = data.edgeType !== "secondary";

  const isAnimated = data.animated ?? isPrimary;

  const edgeStroke = isPrimary ? "#334155" : "#94A3B8";

  const edgeWidth = isPrimary ? 2.5 : 1.5;

  const strokeDasharray = isPrimary ? "none" : "6,6";

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
            <button
              className={`popover-btn ${isPrimary ? "active" : ""}`}
              onClick={() =>
                data.onTypeToggle && data.onTypeToggle(id, "primary")
              }
            >
              Primary
            </button>

            <button
              className={`popover-btn ${!isPrimary ? "active" : ""}`}
              onClick={() =>
                data.onTypeToggle && data.onTypeToggle(id, "secondary")
              }
            >
              Secondary
            </button>

            <button
              className={`popover-btn ${isAnimated ? "active-pulse" : ""}`}
              onClick={() => data.onAnimToggle && data.onAnimToggle(id)}
            >
              {isAnimated ? "⚡ Flow" : "⏸ Pause"}
            </button>

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
    <div className={`epic-card ${isEditing ? "editing" : ""}`}>
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
    <div className={`story-card ${isEditing ? "editing" : ""}`}>
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
        <span className="badge story-badge">STORY</span>

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
  }, [node]);

  if (!node) {
    return null;
  }

  const isEpic = node.type === "epic";
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
    JSON.stringify(acceptanceCriteria) !== JSON.stringify(originalCriteria);

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

  const issueLabel = isEpic ? "EPIC" : "STORY";
  const status = node.data.syncStatus || "idle";

  return (
    <>

      <aside className="smart-node-panel" onDoubleClick={(e) => e.stopPropagation()}>
        <div className="smart-panel-header">
          <div className="smart-panel-title-area">
            <div className={`smart-panel-icon ${isEpic ? "epic" : "story"}`}>
              {isEpic ? "E" : "S"}
            </div>

            <div style={{ minWidth: 0 }}>
              <div className="smart-panel-meta">
                <span className={`smart-panel-type ${isEpic ? "epic" : "story"}`}>
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

              <h2>{isEpic ? "Edit Epic" : "Edit Story"}</h2>
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
              Update the selected {isEpic ? "epic" : "story"}. Changes are applied to the
              workflow only when you click Save Changes.
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

    if (type === "story") {
      setParentId(epicOptions[0]?.id || "");
    } else if (type === "subtask") {
      setParentId(storyOptions[0]?.id || "");
    } else {
      setParentId("");
    }
  }, [type, defaultParentId, epicOptions, storyOptions]);

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

  const parentOptions = isStory ? epicOptions : isSubtask ? storyOptions : [];
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
        isStory
          ? "Select a parent Epic before creating the Story."
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

  const label = isEpic ? "EPIC" : isStory ? "STORY" : "SUB-TASK";
  const title = isEpic ? "Create Epic" : isStory ? "Create Story" : "Create Sub-task";
  const icon = isEpic ? "E" : isStory ? "S" : "✓";
  const tone = isEpic ? "epic" : isStory ? "story" : "subtask";

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
              Parent {isStory ? "Epic" : "Story"}
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
                Select {isStory ? "an Epic" : "a Story"}...
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
                {isStory
                  ? "Create an Epic first. A Story must belong to an Epic."
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
            Add {isEpic ? "Epic" : isStory ? "Story" : "Sub-task"}
          </button>
        </div>
      </div>
    </aside>
  );
}

// =========================================================
// React Flow Node / Edge Types
// =========================================================

const nodeTypes = {
  epic: EpicNode,
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
      extent: "parent",
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
const EPIC_TO_STORY_GAP = 60;
const STORY_GAP_X = 24;
const STORY_GAP_Y = 24;
const MAX_STORIES_PER_ROW = 3;

function layoutWorkflowNodes(inputNodes, dimensions) {
  if (!Array.isArray(inputNodes) || inputNodes.length === 0) {
    return inputNodes;
  }

  const viewportWidth = Math.max(Number(dimensions?.width) || 1440, 900);
  const availableCanvasWidth = Math.max(
    viewportWidth - LAYOUT_MARGIN_X * 2,
    STORY_WIDTH + LANE_PADDING_X * 2,
  );

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

      const stories = nodes
        .filter(
          (node) => node.type === "story" && node.parentId === group.id,
        )
        .sort((a, b) => {
          const ax = Number(a.position?.x) || 0;
          const ay = Number(a.position?.y) || 0;
          const bx = Number(b.position?.x) || 0;
          const by = Number(b.position?.y) || 0;
          return ay - by || ax - bx;
        });

      // Keep a lane compact enough that multiple Epics can share the same
      // viewport row, while allowing larger Epics to use up to 3 story columns.
      const viewportStoryColumns = Math.max(
        1,
        Math.min(
          MAX_STORIES_PER_ROW,
          Math.floor(
            (availableCanvasWidth - LANE_PADDING_X * 2 + STORY_GAP_X) /
              (STORY_WIDTH + STORY_GAP_X),
          ),
        ),
      );

      const storyColumns = Math.max(
        1,
        Math.min(stories.length || 1, viewportStoryColumns),
      );

      const storyGridWidth =
        storyColumns * STORY_WIDTH +
        Math.max(0, storyColumns - 1) * STORY_GAP_X;

      const laneWidth = Math.min(
        availableCanvasWidth,
        Math.max(
          EPIC_WIDTH + LANE_PADDING_X * 2,
          storyGridWidth + LANE_PADDING_X * 2,
        ),
      );

      epic.position = {
        x: (laneWidth - EPIC_WIDTH) / 2,
        y: LANE_PADDING_Y,
      };

      epic.style = {
        ...epic.style,
        width: EPIC_WIDTH,
        height: EPIC_HEIGHT,
      };

      const storiesStartY =
        LANE_PADDING_Y + EPIC_HEIGHT + EPIC_TO_STORY_GAP;

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
          y: storiesStartY + (rowOffsets[row] || 0),
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
          ? storiesStartY + storyRowsHeight + LANE_PADDING_Y
          : LANE_PADDING_Y * 2 + EPIC_HEIGHT;

      group.style = {
        ...group.style,
        width: laneWidth,
        height: laneHeight,
      };

      group.data = {
        ...group.data,
        label: epic.data?.summary || group.data?.label || "",
      };

      return {
        group,
        width: laneWidth,
        height: laneHeight,
        order: groupOrder.get(group.id) ?? 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.order - b.order);

  // Pack Epic lanes from left to right and wrap only when the next lane
  // would exceed the current viewport. This removes the large empty space
  // created by the previous one-lane-per-row layout.
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

    lane.group.position = {
      x: cursorX,
      y: cursorY,
    };

    cursorX += lane.width + LANE_GAP_X;
    currentRowHeight = Math.max(currentRowHeight, lane.height);
  });

  return nodes;
}

// =========================================================
// Create Real Diagram
// =========================================================

function createDiagram(issuesData, onUpdateNodeData, edgeHandlers, dimensions) {
  const epics = issuesData.filter((issue) => issue.issue_type === "Epic");

  const nodes = [];
  const edges = [];

  epics.forEach((epic, epicIndex) => {
    const laneId = `lane-${epicIndex}`;
    const epicId = `epic-${epicIndex}`;

    const stories = issuesData.filter(
      (issue) => issue.issue_type === "Story" && issue.parent === epic.summary,
    );

    nodes.push({
      id: laneId,
      type: "group",
      position: { x: 0, y: 0 },
      data: { label: epic.summary },
      style: {
        width: EPIC_WIDTH + LANE_PADDING_X * 2,
        height: EPIC_HEIGHT + LANE_PADDING_Y * 2,
      },
      draggable: false,
      selectable: false,
    });

    nodes.push({
      id: epicId,
      type: "epic",
      parentId: laneId,
      extent: "parent",
      position: { x: LANE_PADDING_X, y: LANE_PADDING_Y },
      style: {
        width: EPIC_WIDTH,
        height: EPIC_HEIGHT,
      },
      data: {
        issue_type: "Epic",
        summary: epic.summary,
        description: epic.description,
        storyCount: stories.length,
        originalIssue: epic,
        onUpdate: onUpdateNodeData,
        jiraKey: epic.jiraKey || null,
        syncStatus: epic.jiraKey ? "created" : "idle",
        jiraError: null,
      },
    });

    stories.forEach((story, storyIndex) => {
      const tasks = issuesData.filter(
        (issue) =>
          ["Task", "Sub-task", "Subtask"].includes(issue.issue_type) &&
          issue.parent === story.summary,
      );

      const storyId = `${epicId}-story-${storyIndex}`;
      const storyHeight =
        STORY_BASE_HEIGHT + tasks.length * STORY_TASK_HEIGHT;

      nodes.push({
        id: storyId,
        type: "story",
        parentId: laneId,
        extent: "parent",
        position: { x: LANE_PADDING_X, y: 0 },
        style: {
          width: STORY_WIDTH,
          height: storyHeight,
        },
        data: {
          issue_type: "Story",
          summary: story.summary,
          description: story.description,
          storyPoints: story.story_points,
          tasks,
          dependencies: story.dependencies || [],
          acceptanceCriteria: story.acceptance_criteria || [],
          originalIssue: story,
          onUpdate: onUpdateNodeData,
          jiraKey: story.jiraKey || null,
          syncStatus: story.jiraKey ? "created" : "idle",
          jiraError: null,
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
          color: "#334155",
        },
        data: {
          edgeType: "primary",
          animated: true,
          relationship: "workflow",
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

  const storyNodes = nodes.filter((node) => node.type === "story");

  // -------------------------------------------------------
  // EPICS
  // -------------------------------------------------------

  epicNodes.forEach((node) => {
    const original = node.data.originalIssue || {};

    result.push({
      ...original,

      issue_type: "Epic",

      summary: node.data.summary,

      description: node.data.description || "",

      nodeId: node.id,

      jiraKey:
        node.data.jiraKey ||
        original.jiraKey ||
        null,

    });
  });

  // -------------------------------------------------------
  // STORIES + TASKS
  // -------------------------------------------------------

  storyNodes.forEach((node) => {
    const original = node.data.originalIssue || {};

    const storySummary = node.data.summary;

    let parent = original.parent;

    const epicNode = epicNodes.find((epic) => {
      const originalEpic = epic.data.originalIssue || {};

      return originalEpic.summary === parent;
    });

    if (epicNode) {
      parent = epicNode.data.summary;
    }

    const storyIssue = {
      ...original,

      issue_type: "Story",

      summary: storySummary,

      description: node.data.description || "",

      nodeId: node.id,

      jiraKey:
        node.data.jiraKey ||
        original.jiraKey ||
        null,

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

    // ---------------------------------------------------
    // TASKS
    // ---------------------------------------------------

    const tasks = node.data.tasks || [];

    tasks.forEach((task, taskIndex) => {
      const originalTask = {
        ...task,
      };

      result.push({
        ...originalTask,

        issue_type: "Sub-task",

        summary: task.summary || "",

        description: task.description || "",

        parent: storySummary,

        nodeId: task.nodeId || `${node.id}-task-${taskIndex}`,

        jiraKey: task.jiraKey || null,
      });
    });
  });

  // -------------------------------------------------------
  // Preserve future issue types
  // -------------------------------------------------------

  originalIssues
    .filter((issue) => !["Epic", "Story", "Task", "Sub-task", "Subtask"].includes(issue.issue_type))
    .forEach((issue) => {
      result.push({
        ...issue,
      });
    });

  return result;
}

// =========================================================
// Flow Canvas
// =========================================================

function FlowCanvas() {
  const navigate = useNavigate();
  const location = useLocation();

  const [nodes, setNodes, onNodesChange] = useNodesState([]);

  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  const [issuesData, setIssuesData] = useState([]);

  const [jsonOutput, setJsonOutput] = useState(null);

  const [copied, setCopied] = useState(false);

  const [loading, setLoading] = useState(true);

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

  // Clarification round-trip: when the backend needs more detail
  // before it can build a dependable plan.
  const [clarification, setClarification] = useState(null);

  const [clarificationAnswer, setClarificationAnswer] = useState("");

  const [submittingClarification, setSubmittingClarification] = useState(false);

  const [sessionId, setSessionId] = useState(
    () => localStorage.getItem("scrumSessionId") || null,
  );

  const [dimensions, setDimensions] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });

  const { fitView } = useReactFlow();

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

          const newStoryHeight =
            STORY_BASE_HEIGHT + updatedTasks.length * STORY_TASK_HEIGHT;

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
            },
          };
        });

        return layoutWorkflowNodes(updatedNodes, dimensions);
      });
    },
    [setNodes, dimensions],
  );

  // Keep the workflow packed when the browser is resized.
  useEffect(() => {
    setNodes((currentNodes) =>
      layoutWorkflowNodes(currentNodes, dimensions),
    );
  }, [dimensions.width, dimensions.height, setNodes]);

  // =======================================================
  // Smart Add Work Item
  // =======================================================

  const epicOptions = useMemo(
    () =>
      nodes
        .filter((node) => node.type === "epic")
        .map((node) => ({ id: node.id, summary: node.data.summary || "Untitled Epic" })),
    [nodes],
  );

  const storyOptions = useMemo(
    () =>
      nodes
        .filter((node) => node.type === "story")
        .map((node) => ({ id: node.id, summary: node.data.summary || "Untitled Story" })),
    [nodes],
  );

  const openCreatePanel = useCallback(
    (type) => {
      let defaultParentId = "";
      const selectedNode = nodes.find((node) => node.id === selectedNodeId);

      if (type === "story") {
        if (selectedNode?.type === "epic") {
          defaultParentId = selectedNode.id;
        } else {
          defaultParentId = epicOptions[0]?.id || "";
        }
      }

      if (type === "subtask") {
        if (selectedNode?.type === "story") {
          defaultParentId = selectedNode.id;
        } else {
          defaultParentId = storyOptions[0]?.id || "";
        }
      }

      setCreateDefaultParentId(defaultParentId);
      setSelectedNodeId(null);
      setShowAddMenu(false);
      setCreateType(type);
    },
    [nodes, selectedNodeId, epicOptions, storyOptions],
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
        const laneWidth = 760;
        const laneHeight = 430;

        const groupNodes = nodes.filter((node) => node.type === "group");
        const nextY = groupNodes.reduce((bottom, lane) => {
          const laneHeightValue = Number(lane.style?.height) || 430;
          return Math.max(bottom, (lane.position?.y || 0) + laneHeightValue + 30);
        }, 40);

        const newLane = {
          id: laneId,
          type: "group",
          position: { x: 40, y: nextY },
          data: { label: summary },
          style: {
            width: laneWidth,
            height: laneHeight,
          },
          draggable: false,
          selectable: false,
        };

        const newEpic = {
          id: epicId,
          type: "epic",
          parentId: laneId,
          extent: "parent",
          position: {
            x: (laneWidth - EPIC_WIDTH) / 2,
            y: 40,
          },
          style: {
            width: EPIC_WIDTH,
            height: EPIC_HEIGHT,
          },
          data: {
            issue_type: "Epic",
            summary,
            description,
            storyCount: 0,
            originalIssue: {
              issue_type: "Epic",
              summary,
              description,
            },
            onUpdate: handleUpdateNodeData,
            jiraKey: null,
            syncStatus: "idle",
            jiraError: null,
          },
        };

        setNodes((current) =>
          layoutWorkflowNodes([...current, newLane, newEpic], dimensions),
        );
        setCreateType(null);
        setCreateDefaultParentId("");

        setTimeout(() => {
          fitView({ padding: 0.08, duration: 400 });
        }, 50);

        return;
      }

      if (type === "story") {
        const epicNode = nodes.find(
          (node) => node.id === parentId && node.type === "epic",
        );

        if (!epicNode) return;

        const laneId = epicNode.parentId;
        const laneNode = nodes.find((node) => node.id === laneId);
        if (!laneNode) return;

        const existingStories = nodes.filter(
          (node) => node.type === "story" && node.parentId === laneId,
        );

        const storyId = createStableId(`${epicNode.id}-story`);
        const lanePaddingX = 40;
        const storyGap = 40;
        const storyY = 40 + EPIC_HEIGHT + 80;
        const storyX = lanePaddingX + existingStories.length * (STORY_WIDTH + storyGap);
        const requestedWidth = storyX + STORY_WIDTH + lanePaddingX;
        const currentLaneWidth = Number(laneNode.style?.width) || 760;
        const newLaneWidth = Math.max(currentLaneWidth, requestedWidth);
        const storyHeight = STORY_BASE_HEIGHT;
        const currentLaneHeight = Number(laneNode.style?.height) || 430;
        const newLaneHeight = Math.max(
          currentLaneHeight,
          storyY + storyHeight + 40,
        );

        const newStory = {
          id: storyId,
          type: "story",
          parentId: laneId,
          extent: "parent",
          position: {
            x: storyX,
            y: storyY,
          },
          style: {
            width: STORY_WIDTH,
            height: storyHeight,
          },
          data: {
            issue_type: "Story",
            summary,
            description,
            storyPoints,
            tasks: [],
            dependencies: [],
            acceptanceCriteria: acceptanceCriteria || [],
            originalIssue: {
              issue_type: "Story",
              summary,
              description,
              parent: epicNode.data.summary,
              story_points: storyPoints,
              dependencies: [],
              acceptance_criteria: acceptanceCriteria || [],
            },
            onUpdate: handleUpdateNodeData,
            jiraKey: null,
            syncStatus: "idle",
            jiraError: null,
          },
        };

        const newEdge = {
          id: `${epicNode.id}-${storyId}`,
          source: epicNode.id,
          sourceHandle: "bottom",
          target: storyId,
          targetHandle: "top",
          type: "customEdge",
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: "#334155",
          },
          data: {
            edgeType: "primary",
            animated: true,
            relationship: "workflow",
            ...edgeHandlers,
          },
        };

        setNodes((current) => {
          const updatedNodes = current
            .map((node) => {
              if (node.id === laneId) {
                return {
                  ...node,
                  data: {
                    ...node.data,
                    label: epicNode.data.summary,
                  },
                };
              }

              if (node.id === epicNode.id) {
                return {
                  ...node,
                  data: {
                    ...node.data,
                    storyCount: (node.data.storyCount || 0) + 1,
                  },
                };
              }

              return node;
            })
            .concat(newStory);

          return layoutWorkflowNodes(updatedNodes, dimensions);
        });

        setEdges((current) => [...current, newEdge]);
        setCreateType(null);
        setCreateDefaultParentId("");

        setTimeout(() => {
          fitView({ padding: 0.08, duration: 400 });
        }, 50);

        return;
      }

      if (type === "subtask") {
        setNodes((currentNodes) => {
          const updatedNodes = currentNodes.map((node) => {
            if (node.id !== parentId || node.type !== "story") {
              return node;
            }

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
                height:
                  STORY_BASE_HEIGHT + updatedTasks.length * STORY_TASK_HEIGHT,
              },
              data: {
                ...node.data,
                tasks: updatedTasks,
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
            questions: Array.isArray(data.questions) ? data.questions : [],
          });

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

    const answer = clarificationAnswer.trim();

    if (!answer || submittingClarification) {
      return;
    }

    setSubmittingClarification(true);
    setError("");

    try {
      const response = await fetch(`${API_BASE_URL}/api/process`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session_id: sessionId,
          message: answer,
        }),
      });

      const data = await response.json();

      if (!response.ok && data.status !== "needs_clarification") {
        throw new Error(
          data.error?.message || data.message || `Backend returned ${response.status}`,
        );
      }

      setClarificationAnswer("");

      applyBackendResponse(data, () => false);
    } catch (err) {
      console.error("Clarification submit failed:", err);
      setError(err.message || "Failed to submit your answer.");
    } finally {
      setSubmittingClarification(false);
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

        // Show skeleton immediately
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

        applyBackendResponse(data, () => cancelled);
      } catch (err) {
        console.error("Workflow processing failed:", err);

        if (!cancelled) {
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
      setEdges((eds) =>
        addEdge(
          {
            ...params,

            type: "customEdge",

            markerEnd: {
              type: MarkerType.ArrowClosed,
              color: "#334155",
            },

            data: {
              edgeType: "primary",
              animated: true,
              relationship: "user",
              ...edgeHandlers,
            },
          },
          eds,
        ),
      );
    },
    [edgeHandlers, setEdges],
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

          <ul
            style={{
              margin: "0 0 22px",
              padding: "0 0 0 20px",
              color: "#334155",
              lineHeight: 1.6,
              fontSize: "14px",
            }}
          >
            {clarification.questions.map((question, index) => (
              <li key={index} style={{ marginBottom: "8px" }}>
                {question}
              </li>
            ))}
          </ul>

          <form onSubmit={handleClarificationSubmit}>
            <textarea
              value={clarificationAnswer}
              onChange={(e) => setClarificationAnswer(e.target.value)}
              placeholder="Answer the question(s) above..."
              required
              style={{
                width: "100%",
                minHeight: "120px",
                resize: "vertical",
                padding: "12px 14px",
                border: "1px solid #CBD5E1",
                borderRadius: "8px",
                fontSize: "14px",
                fontFamily: "inherit",
                marginBottom: "14px",
                boxSizing: "border-box",
              }}
            />

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
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDoubleClick={(event, node) => {
          event.preventDefault();

          if (node.type === "epic" || node.type === "story") {
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
                    onClick={() => openCreatePanel("story")}
                  >
                    <span className="add-type-icon story">S</span>
                    <span>
                      <strong>Story</strong>
                      <small>Add user-facing work under an existing Epic.</small>
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

      {createType && (
        <CreateWorkItemPanel
          type={createType}
          epicOptions={epicOptions}
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
