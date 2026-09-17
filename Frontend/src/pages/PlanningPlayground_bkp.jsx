import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap, useReactFlow,
  Handle, Position, addEdge, useEdgesState, useNodesState, MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./PlanningPlayground.css";
import { getCanvasGraph, runIntake, startJiraSync, watchJiraSync } from "../services/api";

const TYPES = ["Epic", "Feature", "Story", "Task", "Sub-task", "Note"];
const TYPE_CLASS = { Epic: "epic", Feature: "feature", Story: "story", Task: "task", "Sub-task": "task", Note: "note" };
const PARENT_TYPE = { Feature: "Epic", Story: "Feature", Task: "Feature", "Sub-task": "Story" };
const OPTION_GROUPS = [
  { key: "Existing", label: "Existing from dataset" },
  { key: "Draft", label: "New on this canvas" },
  { key: "Created", label: "Created from this canvas" },
];
const JIRA_BASE_URL = (import.meta.env.VITE_JIRA_BASE_URL || "").replace(/\/$/, "");
const jiraLink = (key) => JIRA_BASE_URL && /^[A-Z][A-Z0-9_]*-\d+$/i.test(key || "")
  ? `${JIRA_BASE_URL}/browse/${encodeURIComponent(key)}` : "";
const missingFor = (data) => [
  !data.title?.trim() && "title", !data.description?.trim() && "description",
  ["Story", "Task"].includes(data.type) && !(Number(data.points) > 0) && "positive story points",
  data.type === "Story" && !data.acceptanceCriteria?.trim() && "acceptance criteria",
  PARENT_TYPE[data.type] && !data.parentId && `${PARENT_TYPE[data.type]} placement`,
].filter(Boolean);
const DUPLICATE_HIGH = 0.18;
const DUPLICATE_POSSIBLE = 0.22;

// Stable, deterministic tree layout: siblings share a parent and occupy separate rows.
function layoutHierarchy(nodes) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const children = new Map();
  for (const node of nodes) {
    const parent = byId.has(node.data.parentId) && node.data.parentId !== node.id ? node.data.parentId : "__root__";
    children.set(parent, [...(children.get(parent) || []), node]);
  }
  const positions = new Map();
  const visited = new Set();
  let nextRow = 0;
  function visit(node, depth) {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    const kids = (children.get(node.id) || []).filter(child => !visited.has(child.id));
    if (!kids.length) { positions.set(node.id, { x: 90 + depth * 345, y: 90 + nextRow++ * 175 }); return; }
    for (const child of kids) visit(child, depth + 1);
    const rows = kids.map(child => positions.get(child.id)?.y).filter(y => y !== undefined);
    positions.set(node.id, { x: 90 + depth * 345, y: rows.length ? (Math.min(...rows) + Math.max(...rows)) / 2 : 90 + nextRow++ * 175 });
  }
  for (const root of children.get("__root__") || []) visit(root, 0);
  for (const node of nodes) if (!visited.has(node.id)) visit(node, 0);
  return nodes.map(node => ({ ...node, position: positions.get(node.id) || node.position }));
}

function WorkNode({ data, selected }) {
  const count = data.childCount || 0;
  return <div className={`pg-node pg-node-${TYPE_CLASS[data.type] || "note"} ${selected ? "is-selected" : ""}`}>
    <Handle type="target" position={Position.Left} />
    <div className="pg-node-top"><span className="pg-node-type">{data.type}</span>{count > 0 && <span className="pg-child-count">{count} items</span>}<span className={`pg-state ${data.jiraKey ? "created" : data.analysis ? "review" : "draft"}`}>{data.jiraKey ? `✓ ${data.jiraKey}` : data.publishStatus === "syncing" ? "◌ Creating" : data.publishStatus === "failed" ? "✕ Failed" : data.analysis ? "Reviewed" : "Draft"}</span></div>
    <strong>{data.title || "Untitled work item"}</strong>
    {data.parentTitle ? <small>↳ {data.parentTitle}</small> : data.sprint ? <small>{data.sprint}</small> : <small>Unscheduled</small>}
    {data.jiraKey && jiraLink(data.jiraKey) ? <a className="pg-jira-link" href={jiraLink(data.jiraKey)} target="_blank" rel="noopener noreferrer" onClick={(event)=>event.stopPropagation()}>Open {data.jiraKey} in Jira ↗</a> : null}
    {data.publishError ? <span className="pg-node-warning">{data.publishError}</span> : null}
    {data.duplicate?.ticket_id ? <span className="pg-node-warning">Potential overlap · review</span> : null}
    <Handle type="source" position={Position.Right} />
  </div>;
}
const nodeTypes = { work: WorkNode };
const norm = (v) => String(v || "").trim().toLowerCase();
const asDistance = (v) => v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null;

function PlaygroundInner() {
  const navigate = useNavigate();
  const { fitView } = useReactFlow();
  const [typeFilter, setTypeFilter] = useState("All");
  const [searchText, setSearchText] = useState("");
  const location = useLocation();
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [newType, setNewType] = useState("Story");
  const [title, setTitle] = useState("");
  const [datasetGraph, setDatasetGraph] = useState(null);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);
  const [bulkProgress, setBulkProgress] = useState(null);
  const publishCleanup = useRef(null);
  useEffect(() => () => publishCleanup.current?.(), []);
  const [notice, setNotice] = useState("");
  const [relationMode, setRelationMode] = useState("Auto");
  const datasetId = location.state?.datasetId || localStorage.getItem("foremanDatasetId") || "";

  const selectedNode = useMemo(() => nodes.find((n) => n.id === selectedId) || null, [nodes, selectedId]);

  useEffect(() => {
    if (!datasetId) return;
    getCanvasGraph(datasetId).then(setDatasetGraph).catch(() => setDatasetGraph(null));
  }, [datasetId]);

  useEffect(() => {
    const context = location.state?.contextItem;
    if (!context?.id) return;
    setNotice(`Planning with context: ${context.title || context.summary || context.id}. Existing dataset work stays read-only; add a draft to propose changes.`);
  }, [location.state]);

  // Consume the SAD proposal once, keeping existing dataset records read-only.
  const importedProposal = useRef(null);
  useEffect(() => {
    const proposal = location.state?.sadProposal;
    if (!proposal?.tickets?.length || importedProposal.current === proposal) return;
    importedProposal.current = proposal;
    const batchId = `sad-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const idMap = new Map(proposal.tickets.map((ticket, index) => [ticket.id, `${batchId}-${index}`]));
    const titles = new Map(proposal.tickets.map(ticket => [ticket.id, ticket.title]));
    const draftNodes = proposal.tickets.map((ticket, index) => ({
      id: idMap.get(ticket.id), type: "work",
      position: { x: 110 + Math.max(0, ["Epic", "Feature", "Story", "Task"].indexOf(ticket.type)) * 310, y: 110 + index * 115 },
      data: { type: ticket.type, title: ticket.title, description: ticket.description,
        acceptanceCriteria: (ticket.acceptance_criteria || []).join("\n"), points: "", sprint: "", priority: "Medium",
        parentId: idMap.get(ticket.parent_id) || "", parentTitle: titles.get(ticket.parent_id) || "",
        parentSource: "Draft", sourceSectionId: ticket.source_section_id, sourceExcerpt: ticket.source_excerpt,
        assumptions: ticket.assumptions, duplicateCandidates: ticket.duplicate_candidates || [],
        duplicate: ticket.duplicate_candidates?.[0] || null,
        duplicateReviewed: false, analysis: null, jiraKey: "", reviewStatus: ticket.review_status },
    }));
    const draftEdges = proposal.tickets.filter(ticket => idMap.has(ticket.parent_id)).map(ticket => ({
      id: `parent-${idMap.get(ticket.parent_id)}-${idMap.get(ticket.id)}`,
      source: idMap.get(ticket.parent_id), target: idMap.get(ticket.id),
      label: "contains", data: { kind: "hierarchy" }, markerEnd: { type: MarkerType.ArrowClosed },
    }));
    const positioned = layoutHierarchy(draftNodes);
    setNodes(current => [...current, ...positioned]);
    setEdges(current => [...current, ...draftEdges]);
    setSelectedId(draftNodes[0]?.id || null);
    window.setTimeout(() => fitView({ padding: 0.12, duration: 450 }), 150);
    setNotice(`Imported ${draftNodes.length} SAD drafts. Review duplicate candidates and readiness before publishing. Existing dataset unchanged.`);
    navigate(location.pathname, { replace: true, state: { datasetId } });
  }, [location.state?.sadProposal, datasetId, setNodes, setEdges, navigate, location.pathname, fitView]);

  const existingByType = useMemo(() => {
    const all = [...(datasetGraph?.epics || []), ...(datasetGraph?.issues || [])];
    return TYPES.reduce((acc, type) => {
      acc[type] = all.filter((x) => norm(x.type) === norm(type)).sort((a,b) => String(a.title).localeCompare(String(b.title)));
      return acc;
    }, {});
  }, [datasetGraph]);

  const parentOptions = useMemo(() => {
    if (!selectedNode) return [];
    const required = PARENT_TYPE[selectedNode.data.type];
    if (!required) return [];
    const existing = (existingByType[required] || []).map((x) => ({ id:x.id, title:x.title, source:"Existing", item:x }));
    const drafts = nodes.filter((n) => n.id !== selectedId && n.data.type === required).map((n) => ({ id:n.id, title:n.data.title, source:n.data.jiraKey ? "Created" : "Draft", item:n.data }));
    return [...existing, ...drafts];
  }, [existingByType, nodes, selectedId, selectedNode]);

  const addNode = useCallback(() => {
    const cleanTitle = title.trim() || `New ${newType}`;
    const id = `draft-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const index = nodes.length;
    setNodes((current) => [...current, { id, type:"work", position:{ x:120+(index%4)*280, y:120+Math.floor(index/4)*180 }, data:{ type:newType, title:cleanTitle, points:"", sprint:"", description:"", acceptanceCriteria:"", priority:"Medium", parentId:"", parentTitle:"", analysis:null, duplicate:null, jiraKey:"" } }]);
    setSelectedId(id); setTitle("");
  }, [newType, nodes.length, setNodes, title]);

  const updateNodeById = useCallback((nodeId, patch) => {
    if (!nodeId) return;
    setNodes((current) => current.map((n) => n.id === nodeId ? { ...n, data:{ ...n.data, ...patch, ...(Object.keys(patch).some((k) => ["title","description","type"].includes(k)) ? { analysis:null, duplicate:null, suggestedParentId:"", duplicateReviewed:false } : {}) } } : n));
  }, [setNodes]);
  const updateSelected = useCallback((patch) => updateNodeById(selectedId, patch), [selectedId, updateNodeById]);

  const onConnect = useCallback((params) => {
    const sourceNode = nodes.find((node) => node.id === params.source);
    const targetNode = nodes.find((node) => node.id === params.target);
    if (!sourceNode || !targetNode || sourceNode.id === targetNode.id) return;

    const validHierarchy = PARENT_TYPE[targetNode.data.type] === sourceNode.data.type;
    const useHierarchy = relationMode === "Hierarchy" || (relationMode === "Auto" && validHierarchy);

    if (useHierarchy) {
      if (!validHierarchy) {
        setNotice(`Invalid hierarchy: ${sourceNode.data.type} cannot be the parent of ${targetNode.data.type}. Use Epic → Feature → Story/Task.`);
        return;
      }
      const parentTitle = sourceNode.data.title || sourceNode.id;
      updateNodeById(targetNode.id, { parentId: sourceNode.id, parentTitle, parentSource: sourceNode.data.jiraKey ? "Created" : "Draft" });
      setEdges((current) => {
        const withoutOldParent = current.filter((edge) => !(edge.data?.kind === "hierarchy" && edge.target === targetNode.id));
        return addEdge({ ...params, id:`parent-${sourceNode.id}-${targetNode.id}`, label:"parent", data:{kind:"hierarchy"}, markerEnd:{type:MarkerType.ArrowClosed} }, withoutOldParent);
      });
      return;
    }

    const relation = relationMode === "Auto" ? "Relates" : relationMode;
    setEdges((current) => addEdge({ ...params, id:`${relation.toLowerCase()}-${params.source}-${params.target}-${Date.now()}`, markerEnd:{ type:MarkerType.ArrowClosed }, label:relation.toLowerCase(), data:{ kind:"dependency", relation } }, current));
  }, [nodes, relationMode, setEdges, updateNodeById]);
  const setParent = (parentId) => {
    const option = parentOptions.find((x) => x.id === parentId);
    updateSelected({ parentId, parentTitle: option?.title || "", parentSource: option?.source || "" });
    setEdges((current) => {
      const withoutHierarchy = current.filter((e) => !(e.data?.kind === "hierarchy" && e.target === selectedId));
      if (!parentId || !nodes.some((n) => n.id === parentId)) return withoutHierarchy;
      return addEdge({ id:`parent-${parentId}-${selectedId}`, source:parentId, target:selectedId, label:"contains", data:{kind:"hierarchy"}, markerEnd:{type:MarkerType.ArrowClosed} }, withoutHierarchy);
    });
  };

  const analyzeSelected = useCallback(async () => {
    if (!selectedNode || selectedNode.data.type === "Note") return;
    if (!datasetId) { setNotice("Connect a dataset to compare this draft with the existing backlog."); return; }
    const text = [selectedNode.data.title, selectedNode.data.description, selectedNode.data.acceptanceCriteria].filter(Boolean).join("\n");
    if (!text.trim()) return;
    setAnalysisBusy(true); setNotice("");
    try {
      const result = await runIntake(datasetId, text, 8);
      const candidates = (result.overlap_candidates || []).filter((c) => c.ticket_id).sort((a,b) => (asDistance(a.distance) ?? 99) - (asDistance(b.distance) ?? 99));
      const best = candidates[0] || null;
      const duplicate = best && asDistance(best.distance) !== null && asDistance(best.distance) <= DUPLICATE_POSSIBLE ? best : null;

      // Suggest the hierarchy from the closest grounded backlog item, but never
      // change the user's parent automatically. ParentID remains authoritative.
      let suggestedParentId = "";
      const allExisting = [...(datasetGraph?.epics || []), ...(datasetGraph?.issues || [])];
      const byId = new Map(allExisting.map((item) => [String(item.id), item]));
      let cursor = best?.ticket_id ? byId.get(String(best.ticket_id)) : null;
      const requiredParentType = PARENT_TYPE[selectedNode.data.type];
      if (cursor && requiredParentType) {
        if (norm(cursor.type) === norm(requiredParentType)) suggestedParentId = cursor.id;
        while (!suggestedParentId && cursor?.parent_id) {
          cursor = byId.get(String(cursor.parent_id));
          if (cursor && norm(cursor.type) === norm(requiredParentType)) suggestedParentId = cursor.id;
        }
      }
      updateSelected({ analysis:result, duplicate, suggestedParentId });
    } catch (error) { setNotice(error.message || "Foreman analysis failed."); }
    finally { setAnalysisBusy(false); }
  }, [datasetGraph, datasetId, selectedNode, updateSelected]);

  const publishSelected = async () => {
    if (!selectedNode || selectedNode.data.type === "Note" || publishBusy || selectedNode.data.jiraKey) return;
    const data = selectedNode.data;
    const missing = [
      !data.title?.trim() && "title",
      !data.description?.trim() && "description",
      ["Story", "Task"].includes(data.type) && !(Number(data.points) > 0) && "positive story points",
      data.type === "Story" && !data.acceptanceCriteria?.trim() && "acceptance criteria",
      PARENT_TYPE[data.type] && !data.parentId && `${PARENT_TYPE[data.type]} placement`,
    ].filter(Boolean);
    if (missing.length) { setNotice(`Complete before publishing: ${missing.join(", ")}.`); return; }
    if (data.duplicateCandidates?.length && !data.duplicateReviewed) { setNotice("Review the SAD duplicate candidates before publishing."); return; }
    if (data.duplicate?.ticket_id && !window.confirm(`Potential overlap with ${data.duplicate.ticket_id}. Have you reviewed it and confirmed this is genuinely new work?`)) return;
    if (!window.confirm(`Publish "${data.title}" to sandbox Jira? This creates a real ticket.`)) return;
    setPublishBusy(true);
    setNotice("Starting Jira creation…");
    const nodeId = selectedNode.id;
    const issue = {
      nodeId, issue_type:data.type, summary:data.title,
      description:[data.description, data.parentTitle ? `Planning hierarchy: ${PARENT_TYPE[data.type] || "Parent"}: ${data.parentTitle}` : ""].filter(Boolean).join("\n\n"),
      priority:data.priority || "Medium", story_points:data.points || undefined, sprint:data.sprint || undefined,
      acceptance_criteria:(data.acceptanceCriteria || "").split("\n").map((x) => x.replace(/^[-•]\s*/, "").trim()).filter(Boolean),
    };
    const parentDraft = nodes.find((n) => n.id === data.parentId);
    if (data.type === "Feature" && parentDraft?.data?.type === "Epic" && parentDraft.data.jiraKey) issue.epic_link = parentDraft.data.jiraKey;
    if (data.type === "Story" && parentDraft?.data?.type === "Feature") {
      const epicDraft = nodes.find((n) => n.id === parentDraft.data.parentId);
      if (epicDraft?.data?.type === "Epic" && epicDraft.data.jiraKey) issue.epic_link = epicDraft.data.jiraKey;
    }
    if (data.type === "Task" && parentDraft?.data?.type === "Story" && parentDraft.data.jiraKey) issue.parent = parentDraft.data.jiraKey;
    try {
      const started = await startJiraSync([issue]);
      if (!started?.jobId) throw new Error("Jira did not return a job ID.");
      let finished = false;
      let createdKey = "";
      let closeStream = () => {};
      const timeout = window.setTimeout(() => {
        if (finished) return;
        finished = true;
        closeStream();
        setPublishBusy(false);
        setNotice(`Jira job ${started.jobId} has not reported a final result. Check Jira before retrying to avoid duplicate tickets.`);
      }, 90000);
      const finish = (message) => {
        if (finished) return;
        finished = true;
        window.clearTimeout(timeout);
        closeStream();
        publishCleanup.current = null;
        setPublishBusy(false);
        setNotice(message);
      };
      closeStream = watchJiraSync(started.jobId, {
        onEvent:(event) => {
          if (finished) return;
          if (event.status === "created" && event.nodeId === nodeId && event.key) {
            createdKey = event.key;
            updateNodeById(nodeId, { jiraKey:event.key });
            setNotice(`Created ${event.key} in Jira; waiting for job completion…`);
          } else if (event.status === "failed" && (!event.nodeId || event.nodeId === nodeId)) {
            finish(event.error || "Jira creation failed.");
          } else if (event.status === "job_failed") {
            finish(event.error || "Jira job failed. Check Jira before retrying.");
          } else if (event.status === "completed") {
            finish(createdKey ? `Created ${createdKey} in Jira.` : `Job ${started.jobId} completed without a ticket key. Check Jira before retrying.`);
          }
        },
        onError:() => finish(`Jira progress disconnected for job ${started.jobId}. Check Jira before retrying; creation may have succeeded.`),
      });
      if (finished) closeStream();
      else publishCleanup.current = () => { window.clearTimeout(timeout); closeStream(); };
    } catch (error) {
      publishCleanup.current?.();
      publishCleanup.current = null;
      setPublishBusy(false);
      setNotice(error.message || "Could not start Jira creation.");
    }
  };

  const publishAll = async () => {
    if (publishBusy) return;
    const pending = nodes.filter((node) => node.data.type !== "Note" && !node.data.jiraKey);
    if (!pending.length) { setNotice("There are no unpublished tickets on this canvas."); return; }
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const problems = pending.flatMap((node) => {
      const missing = missingFor(node.data);
      const parent = byId.get(node.data.parentId);
      if (parent && parent.data.type !== PARENT_TYPE[node.data.type]) missing.push("valid parent type");
      if (node.data.parentId && !parent && !node.data.parentJiraKey) {
        missing.push("parent must be a canvas draft or confirmed Jira key");
      }
      if (node.data.type === "Sub-task" && !parent?.data.jiraKey && !pending.some((draft)=>draft.id===node.data.parentId)) missing.push("created Story parent");
      return missing.length ? [`${node.data.title || node.id}: ${missing.join(", ")}`] : [];
    });
    if (problems.length) { setNotice(`Resolve readiness before creating all: ${problems.slice(0, 4).join("; ")}${problems.length > 4 ? ` (+${problems.length - 4} more)` : ""}.`); return; }
    const unreviewed = pending.filter(node => node.data.duplicateCandidates?.length && !node.data.duplicateReviewed);
    if (unreviewed.length) { setNotice(`Review duplicate candidates for ${unreviewed.length} SAD drafts before creating tickets.`); return; }
    const duplicates = pending.filter((node)=>node.data.duplicate?.ticket_id);
    if (duplicates.length && !window.confirm(`${duplicates.length} drafts have potential duplicate matches. Review these before publishing. Continue anyway?`)) return;
    if (!window.confirm(`Create ${pending.length} Jira tickets in Epic → Feature → Story/Task → Sub-task order? This writes to Jira and cannot be undone here.`)) return;
    const findEpic = (node) => {
      const seen = new Set(); let current = node;
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        if (current.data.type === "Epic") return current;
        current = byId.get(current.data.parentId);
      }
      return null;
    };
    const issues = pending.map((node) => {
      const data = node.data;
      const parent = byId.get(data.parentId);
      const epic = findEpic(node);
      return {
        nodeId:node.id, issue_type:data.type, summary:data.title,
        description:[data.description, data.parentTitle ? `Planning hierarchy: ${data.parentTitle}` : ""].filter(Boolean).join("\n\n"),
        priority:data.priority || "Medium", story_points:data.points || undefined,
        sprint:data.sprint || undefined,
        acceptance_criteria:(data.acceptanceCriteria || "").split("\n").map((line)=>line.replace(/^[-•]\s*/, "").trim()).filter(Boolean),
        parentNodeId:parent && !parent.data.jiraKey ? parent.id : undefined,
        parentJiraKey:data.type === "Sub-task" ? parent?.data.jiraKey : undefined,
        epicNodeId:epic && epic.id !== node.id && !epic.data.jiraKey ? epic.id : undefined,
        epic_link:epic?.data.jiraKey || undefined,
      };
    });
    const pendingIds = new Set(pending.map((node)=>node.id));
    setPublishBusy(true);
    setBulkProgress({ total:pending.length, completed:0, created:0, failed:0, jobId:"" });
    setNodes((current)=>current.map((node)=>pendingIds.has(node.id) ? {...node, data:{...node.data,publishStatus:"waiting",publishError:""}} : node));
    try {
      const started = await startJiraSync(issues);
      if (!started?.jobId) throw new Error("Jira did not return a job ID.");
      let finished = false;
      let closeStream = () => {};
      const outcomes = new Set();
      const finish = (message) => {
        if (finished) return;
        finished = true;
        window.clearTimeout(timeout);
        closeStream();
        publishCleanup.current = null;
        setPublishBusy(false);
        setNotice(message);
      };
      const timeout = window.setTimeout(()=>finish(`Jira job ${started.jobId} has not completed. Check Jira before retrying to avoid duplicates.`), 180000);
      setBulkProgress((current)=>({...current,jobId:started.jobId}));
      closeStream = watchJiraSync(started.jobId, {
        onEvent:(event)=>{
          if (finished) return;
          if (event.nodeId && pendingIds.has(event.nodeId)) {
            if (event.status === "syncing") updateNodeById(event.nodeId,{publishStatus:"syncing"});
            if (["created","skipped","failed"].includes(event.status)) {
              updateNodeById(event.nodeId, event.status === "failed"
                ? {publishStatus:"failed",publishError:event.error || "Jira creation failed."}
                : {publishStatus:"created",jiraKey:event.key || "",publishError:""});
              if (!outcomes.has(event.nodeId)) {
                outcomes.add(event.nodeId);
                setBulkProgress((current)=>({...current,completed:current.completed+1,
                  created:current.created+(event.status === "failed" ? 0 : 1),
                  failed:current.failed+(event.status === "failed" ? 1 : 0)}));
              }
            }
          }
          if (event.status === "completed") finish(`Jira job finished. ${event.created ?? "See cards for created tickets"} created, ${event.failed ?? "see cards for failures"} failed.`);
          if (event.status === "job_failed") finish(`Jira job failed: ${event.error || "Unknown error"}. Check Jira before retrying.`);
        },
        onError:()=>finish(`Jira progress disconnected for job ${started.jobId}. Check Jira before retrying; some tickets may have been created.`),
      });
      if (finished) closeStream();
      else publishCleanup.current = ()=>{window.clearTimeout(timeout);closeStream();};
    } catch (error) {
      publishCleanup.current?.();publishCleanup.current=null;
      setPublishBusy(false);setNotice(error.message || "Unable to start bulk Jira creation.");
    }
  };

  const deleteSelected = () => { if (publishBusy || !selectedId) return; setNodes((c) => c.filter((n) => n.id !== selectedId)); setEdges((c) => c.filter((e) => e.source !== selectedId && e.target !== selectedId)); setSelectedId(null); };
  const clearBoard = () => { if (publishBusy) return; if (!nodes.length || window.confirm("Clear every item from this planning canvas?")) { setNodes([]); setEdges([]); setSelectedId(null); } };
  const draftKey = `foremanPlanningPlayground:${datasetId || "no-dataset"}`;
  const saveBoard = () => { try { localStorage.setItem(draftKey, JSON.stringify({ nodes, edges, savedAt:new Date().toISOString() })); setNotice("Draft saved for this dataset."); } catch { setNotice("Unable to save draft: browser storage may be full."); } };
  const restoreBoard = () => { try { const saved=JSON.parse(localStorage.getItem(draftKey)||"null"); if(saved?.nodes)setNodes(saved.nodes); if(saved?.edges)setEdges(saved.edges); } catch {} };

  const counts = useMemo(() => TYPES.reduce((acc, type) => ({ ...acc, [type]: nodes.filter(n => n.data.type === type).length }), {}), [nodes]);
  const visibleIds = useMemo(() => {
    const matches = nodes.filter(n => (typeFilter === "All" || n.data.type === typeFilter || (typeFilter === "Duplicates" && n.data.duplicateCandidates?.length)) && (!searchText.trim() || `${n.data.title} ${n.data.description}`.toLowerCase().includes(searchText.toLowerCase())));
    if (typeFilter === "All" && !searchText.trim()) return new Set(nodes.map(n => n.id));
    const ids = new Set(matches.map(n => n.id));
    for (const n of matches) { let cursor = n; const seen = new Set(); while (cursor?.data.parentId && !seen.has(cursor.id)) { seen.add(cursor.id); ids.add(cursor.data.parentId); cursor = nodes.find(x => x.id === cursor.data.parentId); } }
    return ids;
  }, [nodes, typeFilter, searchText]);
  const displayedNodes = useMemo(() => nodes.filter(n => visibleIds.has(n.id)).map(n => ({...n, data: {...n.data, childCount: nodes.filter(child => child.data.parentId === n.id).length}})), [nodes, visibleIds]);
  const displayedEdges = useMemo(() => edges.filter(e => visibleIds.has(e.source) && visibleIds.has(e.target)), [edges, visibleIds]);
  const arrange = () => { setNodes(current => layoutHierarchy(current)); window.setTimeout(() => fitView({padding: 0.12, duration: 450}), 50); };
  const duplicate = selectedNode?.data?.duplicate;
  const distance = asDistance(duplicate?.distance);
  const duplicateLevel = distance !== null && distance <= DUPLICATE_HIGH ? "High overlap" : "Possible overlap";
  const readinessMissing = selectedNode ? missingFor(selectedNode.data) : [];

  return <div className="pg-shell">
    <header className="pg-topbar"><button className="pg-brand" onClick={() => navigate("/start")}>Foreman</button><div className="pg-title-wrap"><strong>Planning Playground</strong><span>Plan freely · Foreman checks context · you decide what reaches Jira</span></div><div className="pg-dataset-state"><span className={datasetId ? "on" : "off"}></span>{datasetId ? "Backlog intelligence connected" : "No dataset connected"}</div><div className="pg-actions"><button className="pg-bulk-create" disabled={publishBusy || !nodes.some((n)=>n.data.type!=="Note" && !n.data.jiraKey)} onClick={publishAll}>{publishBusy ? "Creating tickets…" : `Create all tickets (${nodes.filter((n)=>n.data.type!=="Note" && !n.data.jiraKey).length})`}</button><button onClick={restoreBoard}>Restore</button><button onClick={saveBoard}>Save draft</button><button className="danger" onClick={clearBoard}>Clear</button></div></header>
    <div className="pg-studio-controls"><div className="pg-filters">{["All", "Epic", "Feature", "Story", "Task", "Duplicates"].map(type => <button key={type} className={typeFilter === type ? "active" : ""} onClick={() => setTypeFilter(type)}>{type === "All" ? "All" : type === "Duplicates" ? "Needs duplicate review" : `${type}s`} <b>{type === "All" ? nodes.length : type === "Duplicates" ? nodes.filter(n => n.data.duplicateCandidates?.length).length : counts[type]}</b></button>)}</div><div className="pg-view-actions"><input aria-label="Search work items" placeholder="Search work items…" value={searchText} onChange={e => setSearchText(e.target.value)}/><button onClick={arrange}>Organize layout</button><button onClick={() => fitView({padding: 0.12, duration: 400})}>Fit view</button><span>Hierarchy view</span></div></div>
    <div className="pg-toolbar"><select value={newType} onChange={(e)=>setNewType(e.target.value)}>{TYPES.map((t)=><option key={t}>{t}</option>)}</select><input value={title} onChange={(e)=>setTitle(e.target.value)} onKeyDown={(e)=>e.key==="Enter"&&addNode()} placeholder="Describe a work item…"/><button className="primary" onClick={addNode}>+ Add to canvas</button><span className="pg-link-label">Arrow:</span><select value={relationMode} onChange={(e)=>setRelationMode(e.target.value)} title="Auto maps valid Epic → Feature → Story/Task arrows as hierarchy"><option>Auto</option><option>Hierarchy</option><option>Blocks</option><option>Requires</option><option>Relates</option></select><span className="pg-tip">Draw arrows to map hierarchy or dependencies · Draft → Analyze → Review → Create</span></div>
    {bulkProgress && <div className="pg-bulk-progress" role="status"><strong>Jira creation · {bulkProgress.completed}/{bulkProgress.total}</strong><span>✓ {bulkProgress.created} created · ✕ {bulkProgress.failed} failed</span><progress value={bulkProgress.completed} max={bulkProgress.total} />{bulkProgress.jobId && <small>Job {bulkProgress.jobId}</small>}</div>}
    {notice && <div className="pg-notice">{notice}<button onClick={()=>setNotice("")}>×</button></div>}
    <main className="pg-main"><section className="pg-canvas">{nodes.length===0&&<div className="pg-empty"><div className="pg-empty-icon">✦</div><h2>Your planning space is empty</h2><p>Add work, arrange it visually, then let Foreman compare drafts with the existing backlog before publishing.</p><div className="pg-empty-hints"><span>Epic → Feature → Story</span><span>Duplicate check</span><span>Dependencies</span><span>Human approval</span></div></div>}
      <ReactFlow nodes={displayedNodes} edges={displayedEdges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeClick={(_,n)=>setSelectedId(n.id)} onPaneClick={()=>setSelectedId(null)} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding:0.18, minZoom:0.45, maxZoom:1 }} minZoom={.2} maxZoom={1.8} defaultEdgeOptions={{ style:{ strokeWidth:1.7 } }} proOptions={{hideAttribution:true}}><Background variant={BackgroundVariant.Dots} gap={24} size={1}/><MiniMap pannable zoomable nodeColor={n => ({Epic:"#8b5cf6",Feature:"#2563eb",Story:"#0d9488",Task:"#f97316"}[n.data.type] || "#64748b")}/><Controls/></ReactFlow></section>
      <aside className={`pg-inspector ${selectedNode?"open":""}`}>{selectedNode ? <>
        <div className="pg-inspector-head"><div><span>{selectedNode.data.jiraKey ? "Created ticket" : "Draft work item"}</span><strong>{selectedNode.data.type} · {selectedNode.data.title}</strong><small>{nodes.filter(n => n.data.parentId === selectedId).length} direct children</small></div><button onClick={()=>setSelectedId(null)}>×</button></div>
        <label>Type<select value={selectedNode.data.type} disabled={Boolean(selectedNode.data.jiraKey)} onChange={(e)=>updateSelected({type:e.target.value,parentId:"",parentTitle:""})}>{TYPES.map((t)=><option key={t}>{t}</option>)}</select></label>
        <label>Title<input value={selectedNode.data.title||""} disabled={Boolean(selectedNode.data.jiraKey)} onChange={(e)=>updateSelected({title:e.target.value})}/></label>
        {PARENT_TYPE[selectedNode.data.type] && <label className="pg-parent-field"><span className="pg-label-row"><span>{PARENT_TYPE[selectedNode.data.type]} placement</span><span className="pg-option-count">{parentOptions.length} available</span></span><select className="pg-parent-select" value={selectedNode.data.parentId||""} disabled={Boolean(selectedNode.data.jiraKey)} onChange={(e)=>setParent(e.target.value)}><option value="">Choose {PARENT_TYPE[selectedNode.data.type]}…</option>{OPTION_GROUPS.map((group)=>{const opts=parentOptions.filter((x)=>x.source===group.key);return opts.length?<optgroup key={group.key} label={`${group.label} (${opts.length})`}>{opts.map((x)=><option key={`${group.key}-${x.id}`} value={x.id}>{x.title} · {x.id}</option>)}</optgroup>:null;})}</select><small className="pg-field-help">Existing {PARENT_TYPE[selectedNode.data.type]}s from the connected dataset and newly created {PARENT_TYPE[selectedNode.data.type]}s on this canvas are suggested together.</small>{selectedNode.data.suggestedParentId && selectedNode.data.suggestedParentId !== selectedNode.data.parentId ? <button type="button" className="pg-parent-suggestion" onClick={()=>setParent(selectedNode.data.suggestedParentId)}>✦ Foreman suggests {parentOptions.find((x)=>x.id===selectedNode.data.suggestedParentId)?.title || selectedNode.data.suggestedParentId}</button> : null}</label>}
        <div className="pg-mapping-help">Tip: you can also map this item by drawing an arrow from its parent card. Valid hierarchy is Epic → Feature → Story/Task.</div><div className="pg-two"><label>Story points<input type="number" min="0" disabled={Boolean(selectedNode.data.jiraKey)} value={selectedNode.data.points||""} onChange={(e)=>updateSelected({points:e.target.value})}/></label><label>Priority<select disabled={Boolean(selectedNode.data.jiraKey)} value={selectedNode.data.priority||"Medium"} onChange={(e)=>updateSelected({priority:e.target.value})}><option>Highest</option><option>High</option><option>Medium</option><option>Low</option><option>Lowest</option></select></label></div>
        <label>Sprint<input value={selectedNode.data.sprint||""} disabled={Boolean(selectedNode.data.jiraKey)} onChange={(e)=>updateSelected({sprint:e.target.value})} placeholder="Jira sprint ID"/></label>
        <label>Description<textarea rows="4" disabled={Boolean(selectedNode.data.jiraKey)} value={selectedNode.data.description||""} onChange={(e)=>updateSelected({description:e.target.value})} placeholder="What is needed and why?"/></label>
        {selectedNode.data.type==="Story" && <label>Acceptance criteria<textarea rows="4" disabled={Boolean(selectedNode.data.jiraKey)} value={selectedNode.data.acceptanceCriteria||""} onChange={(e)=>updateSelected({acceptanceCriteria:e.target.value})} placeholder="One criterion per line…"/></label>}
        {selectedNode.data.sourceSectionId && <section className="pg-ai-card"><strong>SAD traceability</strong><p>Source section: {selectedNode.data.sourceSectionId}</p><p>{selectedNode.data.sourceExcerpt || "No source excerpt returned; verify against the document."}</p>{selectedNode.data.assumptions?.length > 0 && <p>Assumptions to review: {selectedNode.data.assumptions.join("; ")}</p>}</section>}
        {selectedNode.data.duplicateCandidates?.length > 0 && <section className="pg-ai-card"><strong>Existing backlog candidates · review required</strong><p>Lexical/title screening only; these are not confirmed duplicates.</p>{selectedNode.data.duplicateCandidates.map(candidate => <p key={candidate.ticket_id}><b>{candidate.ticket_id}</b> · {candidate.title} · score {candidate.score}</p>)}<label><input type="checkbox" checked={Boolean(selectedNode.data.duplicateReviewed)} disabled={Boolean(selectedNode.data.jiraKey)} onChange={e => updateSelected({ duplicateReviewed: e.target.checked })}/> I reviewed these candidates and confirm this is separate new work.</label></section>}
        {selectedNode.data.type!=="Note" && <section className="pg-ai-card"><div className="pg-ai-head"><div><span className="pg-spark">✦</span><strong>Foreman review</strong></div><button onClick={analyzeSelected} disabled={analysisBusy||Boolean(selectedNode.data.jiraKey)}>{analysisBusy?"Checking…":selectedNode.data.analysis?"Check again":"Analyze"}</button></div>
          {!datasetId ? <p>Connect a dataset to check this draft against existing work.</p> : selectedNode.data.analysis ? <>{duplicate ? <div className="pg-duplicate"><div><strong>{duplicateLevel}</strong><span>{distance!==null?`distance ${distance.toFixed(3)}`:"semantic candidate"}</span></div><b>{duplicate.ticket_id}</b><p>{duplicate.title}</p><div className="pg-dup-actions"><button onClick={()=>updateSelected({duplicate:null})}>Not duplicate</button><button onClick={()=>navigate("/canvas",{state:{datasetId}})}>View existing</button></div></div> : <div className="pg-clear-check">✓ No high-confidence overlap was flagged by the current review threshold.</div>}
          {(selectedNode.data.analysis.architecture_areas||[]).length>0&&<div className="pg-suggestions"><span>Architecture context</span>{selectedNode.data.analysis.architecture_areas.slice(0,3).map((a)=><button key={a.sad_section_id} title={a.sad_title}>{a.sad_section_id} · {a.title}</button>)}</div>}</> : <p>Analyze before publishing to surface related work, architecture context and dependency evidence.</p>}
        </section>}
        <div className="pg-readiness"><strong>Readiness</strong>{readinessMissing.length ? <span>Needs {readinessMissing.join(", ")}</span> : <span className="ready">Ready for review</span>}</div>
        {selectedNode.data.jiraKey ? <div className="pg-created-box">✓ Created in Jira {jiraLink(selectedNode.data.jiraKey) ? <a href={jiraLink(selectedNode.data.jiraKey)} target="_blank" rel="noopener noreferrer">{selectedNode.data.jiraKey} ↗</a> : <strong>{selectedNode.data.jiraKey}</strong>}</div> : selectedNode.data.type==="Note" ? <button className="pg-create" onClick={()=>updateSelected({type:"Task"})}>Convert note to Task</button> : <button className="pg-create" disabled={publishBusy||!selectedNode.data.title?.trim()||readinessMissing.length>0||(selectedNode.data.duplicateCandidates?.length>0&&!selectedNode.data.duplicateReviewed)} onClick={publishSelected}>{publishBusy?"Creating…":"Create ticket in Jira"}</button>}
        <div className="pg-inspector-note">Creation is always explicit. Existing dataset IDs are used for planning context only and are never assumed to be Jira keys.</div><button className="pg-delete" disabled={publishBusy || Boolean(selectedNode.data.jiraKey)} onClick={deleteSelected}>Delete work item</button>
      </> : <div className="pg-inspector-empty"><strong>Inspector</strong><p>Select a card to edit it, choose its hierarchy, check for overlap and create it in Jira.</p></div>}</aside></main>
  </div>;
}
export default function PlanningPlayground(){return <ReactFlowProvider><PlaygroundInner/></ReactFlowProvider>;}
