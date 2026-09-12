import { useMemo, useState, useCallback, useEffect } from 'react';
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
} from '@xyflow/react';

import '@xyflow/react/dist/style.css';
import './App.css';

// =========================================================
// Base Component Dimensions
// =========================================================

const EPIC_WIDTH = 290;
const EPIC_HEIGHT = 210;

const STORY_WIDTH = 320;
const STORY_BASE_HEIGHT = 170;
const STORY_TASK_HEIGHT = 28;

// =========================================================
// Dynamic Spacing
// =========================================================

function calculateDynamicSpacing(viewportWidth, viewportHeight, maxStoriesInLane) {
  const availableWidth = Math.max(viewportWidth - 120, 1200);

  const reservedNodesWidth =
    EPIC_WIDTH + maxStoriesInLane * STORY_WIDTH;

  const remainingWidth = Math.max(
    availableWidth - reservedNodesWidth,
    180
  );

  const epicToStoryGap = Math.min(
    Math.max(remainingWidth * 0.3, 80),
    160
  );

  const storyGap =
    maxStoriesInLane > 1
      ? Math.min(
        Math.max(
          (remainingWidth * 0.7) / (maxStoriesInLane - 1),
          60
        ),
        120
      )
      : 80;

  const laneGap = Math.min(
    Math.max(viewportHeight * 0.05, 40),
    80
  );

  const lanePaddingY = Math.min(
    Math.max(viewportHeight * 0.03, 24),
    48
  );

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

  const isPrimary = data.edgeType !== 'secondary';
  const isAnimated = data.animated ?? isPrimary;

  const edgeStroke = isPrimary ? '#334155' : '#94A3B8';
  const edgeWidth = isPrimary ? 2.5 : 1.5;
  const strokeDasharray = isPrimary ? 'none' : '6,6';

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: selected ? '#2563EB' : edgeStroke,
          strokeWidth: selected ? 3 : edgeWidth,
          strokeDasharray: isAnimated
            ? '8,8'
            : strokeDasharray,
        }}
        className={
          isAnimated ? 'animated-edge-flow' : ''
        }
      />

      {selected && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform:
                `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: 'all',
            }}
            className="edge-popover nodrag nopan"
          >
            <button
              className={`popover-btn ${isPrimary ? 'active' : ''
                }`}
              onClick={() =>
                data.onTypeToggle &&
                data.onTypeToggle(id, 'primary')
              }
            >
              Primary
            </button>

            <button
              className={`popover-btn ${!isPrimary ? 'active' : ''
                }`}
              onClick={() =>
                data.onTypeToggle &&
                data.onTypeToggle(id, 'secondary')
              }
            >
              Secondary
            </button>

            <button
              className={`popover-btn ${isAnimated ? 'active-pulse' : ''
                }`}
              onClick={() =>
                data.onAnimToggle &&
                data.onAnimToggle(id)
              }
            >
              {isAnimated ? '⚡ Flow' : '⏸ Pause'}
            </button>

            <button
              className="popover-btn delete-btn"
              onClick={() =>
                data.onDelete &&
                data.onDelete(id)
              }
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
  const [description, setDescription] = useState(
    data.description || ''
  );

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
    <div
      className={`epic-card ${isEditing ? 'editing' : ''
        }`}
      onDoubleClick={() =>
        !isEditing && setIsEditing(true)
      }
    >
      <div className="card-header">
        <span className="badge epic-badge">
          EPIC
        </span>

        {isEditing ? (
          <button
            className="btn-save"
            onClick={handleSave}
          >
            Save 🔒
          </button>
        ) : (
          <span className="edit-hint">
            Double-click to edit
          </span>
        )}
      </div>

      {isEditing ? (
        <div
          className="edit-form"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="text"
            className="input-field"
            value={summary}
            onChange={(e) =>
              setSummary(e.target.value)
            }
            placeholder="Epic title..."
            autoFocus
          />

          <textarea
            className="input-field textarea-field"
            value={description}
            onChange={(e) =>
              setDescription(e.target.value)
            }
            placeholder="Epic description..."
          />
        </div>
      ) : (
        <div className="card-body">
          <div className="card-title">
            {data.summary}
          </div>

          <div className="card-description">
            {data.description}
          </div>
        </div>
      )}

      <div className="card-footer">
        <span className="footer-meta">
          {data.storyCount}{' '}
          {data.storyCount === 1
            ? 'Story'
            : 'Stories'}
        </span>
      </div>

      {/* Connection handle pointing downward to feed the Stories below */}
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

  const [summary, setSummary] = useState(
    data.summary
  );

  const [description, setDescription] = useState(
    data.description || ''
  );

  const [storyPoints, setStoryPoints] = useState(
    data.storyPoints ?? ''
  );

  const [tasks, setTasks] = useState(
    data.tasks ? [...data.tasks] : []
  );

  const handleSave = (e) => {
    e.stopPropagation();

    setIsEditing(false);

    if (data.onUpdate) {
      data.onUpdate(id, {
        summary,
        description,
        storyPoints:
          storyPoints !== ''
            ? Number(storyPoints)
            : null,
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
        issue_type: 'Task',
        summary: 'New Task',
        description: '',
        parent: data.summary,
      },
    ]);
  };

  const handleRemoveTask = (index) => {
    setTasks(
      tasks.filter((_, i) => i !== index)
    );
  };

  return (
    <div
      className={`story-card ${isEditing ? 'editing' : ''
        }`}
      onDoubleClick={() =>
        !isEditing && setIsEditing(true)
      }
    >
      {/* Target handle at the TOP to receive connection lines coming down from the Epic */}
      <Handle
        type="target"
        position={Position.Top}
        id="top"
        className="handle handle-top nodrag"
      />

      {/* Source handle at the BOTTOM (optional, if you want stories to branch further down) */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="bottom"
        className="handle handle-bottom nodrag"
      />

      <div className="card-header">
        <span className="badge story-badge">
          STORY
        </span>

        <div className="header-actions">
          {!isEditing &&
            data.storyPoints != null && (
              <span className="sp-pill">
                {data.storyPoints} SP
              </span>
            )}

          {isEditing && (
            <button
              className="btn-save"
              onClick={handleSave}
            >
              Save 🔒
            </button>
          )}
        </div>
      </div>

      {isEditing ? (
        <div
          className="edit-form"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="sp-input-row">
            <label>Points:</label>

            <input
              type="number"
              className="input-field sp-field"
              value={storyPoints}
              onChange={(e) =>
                setStoryPoints(e.target.value)
              }
            />
          </div>

          <input
            type="text"
            className="input-field"
            value={summary}
            onChange={(e) =>
              setSummary(e.target.value)
            }
            placeholder="Story title..."
            autoFocus
          />

          <textarea
            className="input-field textarea-field"
            value={description}
            onChange={(e) =>
              setDescription(e.target.value)
            }
            placeholder="Story description..."
          />

          <div className="tasks-editor">
            <div className="tasks-editor-header">
              <span>
                Tasks ({tasks.length})
              </span>

              <button
                type="button"
                className="btn-add-task"
                onClick={handleAddTask}
              >
                + Add
              </button>
            </div>

            {tasks.map((task, idx) => (
              <div
                key={idx}
                className="task-input-row"
              >
                <input
                  type="text"
                  className="input-field"
                  value={task.summary}
                  onChange={(e) =>
                    handleTaskChange(
                      idx,
                      e.target.value
                    )
                  }
                />

                <button
                  type="button"
                  className="btn-remove-task"
                  onClick={() =>
                    handleRemoveTask(idx)
                  }
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="card-body">
          <div className="card-title">
            {data.summary}
          </div>

          {data.description && (
            <div className="card-description">
              {data.description}
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
                  <div
                    key={idx}
                    className="task-item"
                  >
                    <span className="task-icon">
                      ✓
                    </span>

                    <span className="task-text">
                      {task.summary}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="no-tasks">
                No subtasks
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const nodeTypes = {
  epic: EpicNode,
  story: StoryNode,
};

const edgeTypes = {
  customEdge: CustomEdge,
};

// =========================================================
// Create Diagram (Top-Down Branching Tree Layout)
// =========================================================

function createDiagram(
  issuesData,
  onUpdateNodeData,
  edgeHandlers,
  dimensions
) {
  const epics = issuesData.filter(
    (issue) => issue.issue_type === 'Epic'
  );

  const nodes = [];
  const edges = [];

  let currentY = 40;

  epics.forEach((epic, epicIndex) => {
    const laneId = `lane-${epicIndex}`;
    const epicId = `epic-${epicIndex}`;

    const stories = issuesData.filter(
      (issue) =>
        issue.issue_type === 'Story' &&
        issue.parent === epic.summary
    );

    // 1. Calculate dimensions for stories laid out horizontally
    const storyLayouts = stories.map((story, storyIndex) => {
      const tasks = issuesData.filter(
        (issue) =>
          issue.issue_type === 'Task' &&
          issue.parent === story.summary
      );

      const storyHeight =
        STORY_BASE_HEIGHT + tasks.length * STORY_TASK_HEIGHT;

      return {
        story,
        tasks,
        storyHeight,
        storyIndex,
      };
    });

    const storyGap = 40; // horizontal gap between stories
    const totalStoriesWidth =
      storyLayouts.length > 0
        ? storyLayouts.length * STORY_WIDTH +
        (storyLayouts.length - 1) * storyGap
        : EPIC_WIDTH;

    // Find the max height among stories to size the lane properly
    const maxStoryHeight = storyLayouts.reduce(
      (max, s) => Math.max(max, s.storyHeight),
      STORY_BASE_HEIGHT
    );

    const epicToStoryVerticalGap = 80; // Vertical distance from Epic bottom to Stories top
    const lanePaddingY = 40;
    const lanePaddingX = 40;

    const laneHeight =
      lanePaddingY * 2 +
      EPIC_HEIGHT +
      epicToStoryVerticalGap +
      maxStoryHeight;

    const laneWidth =
      lanePaddingX * 2 + Math.max(EPIC_WIDTH, totalStoriesWidth);

    // Push Group Node (Lane)
    nodes.push({
      id: laneId,
      type: 'group',
      position: {
        x: 40,
        y: currentY,
      },
      data: {
        label: epic.summary,
      },
      style: {
        width: laneWidth,
        height: laneHeight,
      },
      draggable: false,
      selectable: false,
    });

    // 2. Position Epic Horizontally Centered at the Top of the Lane
    const epicX = (laneWidth - EPIC_WIDTH) / 2;
    const epicY = lanePaddingY;

    nodes.push({
      id: epicId,
      type: 'epic',
      parentId: laneId,
      extent: 'parent',
      position: {
        x: epicX,
        y: epicY,
      },
      style: {
        width: EPIC_WIDTH,
        height: EPIC_HEIGHT,
      },
      data: {
        issue_type: 'Epic',
        summary: epic.summary,
        description: epic.description,
        storyCount: stories.length,
        originalIssue: epic,
        onUpdate: onUpdateNodeData,
      },
    });

    // 3. Position Stories in a horizontal row below the Epic
    const storiesRowY = epicY + EPIC_HEIGHT + epicToStoryVerticalGap;
    let startX = (laneWidth - totalStoriesWidth) / 2;

    storyLayouts.forEach(
      ({ story, tasks, storyHeight, storyIndex }) => {
        const storyId = `${epicId}-story-${storyIndex}`;

        nodes.push({
          id: storyId,
          type: 'story',
          parentId: laneId,
          extent: 'parent',
          position: {
            x: startX,
            y: storiesRowY,
          },
          style: {
            width: STORY_WIDTH,
            height: storyHeight,
          },
          data: {
            issue_type: 'Story',
            summary: story.summary,
            description: story.description,
            storyPoints: story.story_points,
            tasks,
            dependencies: story.dependencies || [],
            acceptanceCriteria: story.acceptance_criteria || [],
            originalIssue: story,
            onUpdate: onUpdateNodeData,
          },
        });

        // Create top-down branching edge from Epic (Bottom) -> Story (Top)
        edges.push({
          id: `${epicId}-${storyId}`,
          source: epicId,
          sourceHandle: 'bottom', // Exits from the bottom of Epic
          target: storyId,
          targetHandle: 'top',    // Enters into the top of Story
          type: 'customEdge',
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: '#334155',
          },
          data: {
            edgeType: 'primary',
            animated: true,
            relationship: 'workflow',
            ...edgeHandlers,
          },
        });

        startX += STORY_WIDTH + storyGap;
      }
    );

    currentY += laneHeight + 30; // Gap between multiple epic lanes
  });

  return {
    nodes,
    edges,
  };
}

// =========================================================
// Convert React Flow State -> issues.json
// =========================================================

function convertFlowToIssues(nodes, originalIssues) {
  const result = [];

  const epicNodes = nodes.filter(
    (node) => node.type === 'epic'
  );

  const storyNodes = nodes.filter(
    (node) => node.type === 'story'
  );

  // -------------------------------------------------------
  // EPICS
  // -------------------------------------------------------

  epicNodes.forEach((node) => {
    const original =
      node.data.originalIssue || {};

    result.push({
      ...original,

      issue_type: 'Epic',

      summary: node.data.summary,

      description:
        node.data.description || '',
    });
  });

  // -------------------------------------------------------
  // STORIES + TASKS
  // -------------------------------------------------------

  storyNodes.forEach((node) => {
    const original =
      node.data.originalIssue || {};

    const storySummary =
      node.data.summary;

    const oldStorySummary =
      original.summary;

    // Find original parent.
    let parent = original.parent;

    // If the epic was renamed, update
    // the story's parent automatically.
    const epicNode = epicNodes.find(
      (epic) => {
        const originalEpic =
          epic.data.originalIssue || {};

        return (
          originalEpic.summary ===
          parent
        );
      }
    );

    if (epicNode) {
      parent = epicNode.data.summary;
    }

    const storyIssue = {
      ...original,

      issue_type: 'Story',

      summary: storySummary,

      description:
        node.data.description || '',

      story_points:
        node.data.storyPoints !== '' &&
          node.data.storyPoints != null
          ? Number(node.data.storyPoints)
          : null,

      parent,

      dependencies:
        Array.isArray(
          node.data.dependencies
        )
          ? [...node.data.dependencies]
          : [],

      acceptance_criteria:
        Array.isArray(
          node.data.acceptanceCriteria
        )
          ? [...node.data.acceptanceCriteria]
          : [],
    };

    result.push(storyIssue);

    // -----------------------------------------------------
    // TASKS
    // -----------------------------------------------------

    const tasks =
      node.data.tasks || [];

    tasks.forEach((task) => {
      const originalTask = {
        ...task,
      };

      result.push({
        ...originalTask,

        issue_type: 'Task',

        summary:
          task.summary || '',

        description:
          task.description || '',

        parent: storySummary,
      });
    });
  });

  // -------------------------------------------------------
  // Preserve any issue types not represented in React Flow
  // -------------------------------------------------------

  const representedOriginalSummaries =
    new Set();

  originalIssues.forEach((issue) => {
    if (
      issue.issue_type === 'Epic' ||
      issue.issue_type === 'Story' ||
      issue.issue_type === 'Task'
    ) {
      representedOriginalSummaries.add(
        `${issue.issue_type}:${issue.summary}`
      );
    }
  });

  // This section intentionally does not duplicate
  // Epic/Story/Task records.
  //
  // It is here so future issue types can survive
  // a round trip through the UI.

  originalIssues
    .filter(
      (issue) =>
        !['Epic', 'Story', 'Task'].includes(
          issue.issue_type
        )
    )
    .forEach((issue) => {
      result.push({
        ...issue,
      });
    });

  return result;
}

// =========================================================
// Flow Canvas Component
// =========================================================
function FlowCanvas() {
  const [nodes, setNodes, onNodesChange] =
    useNodesState([]);

  const [edges, setEdges, onEdgesChange] =
    useEdgesState([]);

  const [issuesData, setIssuesData] =
    useState([]);

  const [jsonOutput, setJsonOutput] =
    useState(null);

  const [copied, setCopied] =
    useState(false);

  const [loading, setLoading] =
    useState(true);

  const [saving, setSaving] =
    useState(false);

  const [saveMessage, setSaveMessage] =
    useState('');

  const [dimensions, setDimensions] =
    useState({
      width: window.innerWidth,
      height: window.innerHeight,
    });

  const { fitView } =
    useReactFlow();

  // =======================================================
  // Load issues.json from API
  // =======================================================

  useEffect(() => {
    let cancelled = false;

    async function loadIssues() {
      try {
        setLoading(true);

        const response = await fetch(
          '/api/issues'
        );

        if (!response.ok) {
          throw new Error(
            `Failed to load issues.json (${response.status})`
          );
        }

        const data =
          await response.json();

        if (!cancelled) {
          setIssuesData(data);
        }
      } catch (error) {
        console.error(error);

        if (!cancelled) {
          setSaveMessage(
            `Failed to load issues.json: ${error.message}`
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadIssues();

    return () => {
      cancelled = true;
    };
  }, []);

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

    window.addEventListener(
      'resize',
      handleResize
    );

    return () =>
      window.removeEventListener(
        'resize',
        handleResize
      );
  }, []);

  // =======================================================
  // Update node data
  // =======================================================

  const handleUpdateNodeData =
    useCallback(
      (nodeId, updatedFields) => {
        setNodes((currentNodes) =>
          currentNodes.map((node) => {
            if (node.id !== nodeId) {
              return node;
            }

            const updatedTasks =
              updatedFields.tasks ??
              node.data.tasks ??
              [];

            const newStoryHeight =
              STORY_BASE_HEIGHT +
              updatedTasks.length *
              STORY_TASK_HEIGHT;

            return {
              ...node,

              style:
                node.type === 'story'
                  ? {
                    ...node.style,
                    height:
                      newStoryHeight,
                  }
                  : node.style,

              data: {
                ...node.data,
                ...updatedFields,
              },
            };
          })
        );
      },
      [setNodes]
    );

  // =======================================================
  // Edge handlers
  // =======================================================

  const handleEdgeTypeToggle =
    useCallback(
      (edgeId, newType) => {
        setEdges((eds) =>
          eds.map((edge) => {
            if (edge.id !== edgeId) {
              return edge;
            }

            const isPrimary =
              newType === 'primary';

            return {
              ...edge,

              markerEnd: {
                type:
                  MarkerType.ArrowClosed,
                color: isPrimary
                  ? '#334155'
                  : '#94A3B8',
              },

              data: {
                ...edge.data,
                edgeType: newType,
              },
            };
          })
        );
      },
      [setEdges]
    );

  const handleEdgeAnimToggle =
    useCallback(
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
                animated:
                  !edge.data.animated,
              },
            };
          })
        );
      },
      [setEdges]
    );

  const handleEdgeDelete =
    useCallback(
      (edgeId) => {
        setEdges((eds) =>
          eds.filter(
            (edge) =>
              edge.id !== edgeId
          )
        );
      },
      [setEdges]
    );

  const edgeHandlers = useMemo(
    () => ({
      onTypeToggle:
        handleEdgeTypeToggle,

      onAnimToggle:
        handleEdgeAnimToggle,

      onDelete:
        handleEdgeDelete,
    }),
    [
      handleEdgeTypeToggle,
      handleEdgeAnimToggle,
      handleEdgeDelete,
    ]
  );

  // =======================================================
  // Generate initial diagram ONLY after JSON loads
  // =======================================================

  useEffect(() => {
    if (!issuesData.length) {
      return;
    }

    const diagram =
      createDiagram(
        issuesData,
        handleUpdateNodeData,
        edgeHandlers,
        dimensions
      );

    setNodes(diagram.nodes);
    setEdges(diagram.edges);

    setTimeout(() => {
      fitView({
        padding: 0.08,
        duration: 400,
      });
    }, 50);
  }, [
    issuesData,
    handleUpdateNodeData,
    edgeHandlers,
    setNodes,
    setEdges,
    fitView,
  ]);

  // =======================================================
  // Connect nodes
  // =======================================================

  const onConnect = useCallback(
    (params) => {
      setEdges((eds) =>
        addEdge(
          {
            ...params,

            type: 'customEdge',

            markerEnd: {
              type:
                MarkerType.ArrowClosed,
              color: '#334155',
            },

            data: {
              edgeType: 'primary',
              animated: true,
              relationship: 'user',
              ...edgeHandlers,
            },
          },
          eds
        )
      );
    },
    [edgeHandlers, setEdges]
  );

  // =======================================================
  // SAVE TO issues.json
  // =======================================================

  const handleSaveChanges =
    async () => {
      if (saving) {
        return;
      }

      try {
        setSaving(true);
        setSaveMessage('');

        const updatedIssues =
          convertFlowToIssues(
            nodes,
            issuesData
          );

        const response =
          await fetch(
            '/api/issues',
            {
              method: 'PUT',

              headers: {
                'Content-Type':
                  'application/json',
              },

              body: JSON.stringify(
                updatedIssues
              ),
            }
          );

        const result =
          await response.json();

        if (!response.ok) {
          throw new Error(
            result.error ||
            'Failed to save issues.json'
          );
        }

        setIssuesData(
          updatedIssues
        );

        const formatted =
          JSON.stringify(
            updatedIssues,
            null,
            2
          );

        setJsonOutput(formatted);
        setCopied(false);

        setSaveMessage(
          `✓ Saved ${updatedIssues.length} issues to issues.json`
        );
      } catch (error) {
        console.error(error);

        setSaveMessage(
          `✕ Save failed: ${error.message}`
        );
      } finally {
        setSaving(false);
      }
    };

  // =======================================================
  // Copy
  // =======================================================

  const handleCopy = async () => {
    if (!jsonOutput) {
      return;
    }

    try {
      await navigator.clipboard.writeText(
        jsonOutput
      );

      setCopied(true);

      setTimeout(
        () => setCopied(false),
        2000
      );
    } catch (error) {
      console.error(
        'Copy failed:',
        error
      );
    }
  };

  // =======================================================
  // Loading
  // =======================================================

  if (loading) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#475569',
        }}
      >
        Loading workflow...
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
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionMode={
          ConnectionMode.Loose
        }
        connectionRadius={25}
        proOptions={{
          hideAttribution: true,
        }}
      >
        <Background
          variant={
            BackgroundVariant.Lines
          }
          color="#E2E8F0"
          gap={28}
          size={1}
        />

        <Controls />

        <Panel
          position="top-right"
          className="panel-actions"
        >
          <button
            className="btn-save-json"
            onClick={handleSaveChanges}
            disabled={saving}
          >
            {saving
              ? '⏳ Saving...'
              : '💾 Save Changes to JSON'}
          </button>

          <button
            className="btn-jira-submit"
            onClick={() =>
              alert(
                'Syncing structural workflow with Jira...'
              )
            }
          >
            Sync to Jira Workflows
          </button>

          {saveMessage && (
            <span
              style={{
                background: '#FFFFFF',
                border:
                  '1px solid #E2E8F0',
                borderRadius: '6px',
                padding:
                  '7px 10px',
                fontSize: '11px',
                color:
                  saveMessage.startsWith(
                    '✓'
                  )
                    ? '#047857'
                    : '#B91C1C',
              }}
            >
              {saveMessage}
            </span>
          )}
        </Panel>
      </ReactFlow>

      {jsonOutput && (
        <div
          className="json-modal-backdrop"
          onClick={() =>
            setJsonOutput(null)
          }
        >
          <div
            className="json-modal"
            onClick={(e) =>
              e.stopPropagation()
            }
          >
            <div className="json-modal-header">
              <div>
                <h3>
                  Saved Workflow JSON
                </h3>

                <p>
                  This is the exact
                  payload written to
                  issues.json.
                </p>
              </div>

              <div className="json-modal-actions">
                <button
                  className="btn-copy"
                  onClick={handleCopy}
                >
                  {copied
                    ? '✓ Copied!'
                    : 'Copy Payload'}
                </button>

                <button
                  className="btn-close"
                  onClick={() =>
                    setJsonOutput(null)
                  }
                >
                  ×
                </button>
              </div>
            </div>

            <div className="json-modal-body">
              <pre>
                <code>
                  {jsonOutput}
                </code>
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