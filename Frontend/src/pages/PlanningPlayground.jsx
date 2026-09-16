import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap,
  Handle, Position, addEdge, useEdgesState, useNodesState, MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./PlanningPlayground.css";
import { getCanvasGraph, runIntake, startJiraSync, watchJiraSync } from "../services/api";

const TYPES = ["Epic", "Feature", "Story", "Task", "Note"];
const TYPE_CLASS = { Epic: "epic", Feature: "feature", Story: "story", Task: "task", Note: "note" };
const PARENT_TYPE = { Feature: "Epic", Story: "Feature", Task: "Feature" };
const OPTION_GROUPS = [
  { key: "Existing", label: "Existing from dataset" },
  { key: "Draft", label: "New on this canvas" },
  { key: "Created", label: "Created from this canvas" },
];
const DUPLICATE_HIGH = 0.22;
const DUPLICATE_POSSIBLE = 0.36;

function WorkNode({ data, selected }) {
  return <div className={`pg-node pg-node-${TYPE_CLASS[data.type] || "note"} ${selected ? "is-selected" : ""}`}>
    <Handle type="target" position={Position.Left} />
    <div className="pg-node-top"><span className="pg-node-type">{data.type}</span><span className={`pg-state ${data.jiraKey ? "created" : data.analysis ? "review" : "draft"}`}>{data.jiraKey ? data.jiraKey : data.analysis ? "Reviewed" : "Draft"}</span></div>
    <strong>{data.title || "Untitled work item"}</strong>
    {data.parentTitle ? <small>↳ {data.parentTitle}</small> : data.sprint ? <small>{data.sprint}</small> : <small>Unscheduled</small>}
    {data.duplicate?.ticket_id ? <span className="pg-node-warning">⚠ Similar: {data.duplicate.ticket_id}</span> : null}
    <Handle type="source" position={Position.Right} />
  </div>;
}
const nodeTypes = { work: WorkNode };
const norm = (v) => String(v || "").trim().toLowerCase();
const asDistance = (v) => Number.isFinite(Number(v)) ? Number(v) : null;

function PlaygroundInner() {
  const navigate = useNavigate();
  const location = useLocation();
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [newType, setNewType] = useState("Story");
  const [title, setTitle] = useState("");
  const [datasetGraph, setDatasetGraph] = useState(null);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);
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
    const id = `draft-${Date.now()}`;
    const index = nodes.length;
    setNodes((current) => [...current, { id, type:"work", position:{ x:120+(index%4)*280, y:120+Math.floor(index/4)*180 }, data:{ type:newType, title:cleanTitle, points:"", sprint:"", description:"", acceptanceCriteria:"", priority:"Medium", parentId:"", parentTitle:"", analysis:null, duplicate:null, jiraKey:"" } }]);
    setSelectedId(id); setTitle("");
  }, [newType, nodes.length, setNodes, title]);

  const updateNodeById = useCallback((nodeId, patch) => {
    if (!nodeId) return;
    setNodes((current) => current.map((n) => n.id === nodeId ? { ...n, data:{ ...n.data, ...patch, ...(Object.keys(patch).some((k) => ["title","description","type"].includes(k)) ? { analysis:null, duplicate:null, suggestedParentId:"" } : {}) } } : n));
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
    if (!selectedNode || selectedNode.data.type === "Note") return;
    if (!selectedNode.data.title?.trim()) { setNotice("Add a title before creating a Jira ticket."); return; }
    if (selectedNode.data.jiraKey) return;
    setPublishBusy(true); setNotice("Creating Jira ticket…");
    const data = selectedNode.data;
    const issue = {
      nodeId:selectedNode.id, issue_type:data.type, summary:data.title, description:[data.description, data.parentTitle ? `Planning hierarchy: ${PARENT_TYPE[data.type] || "Parent"}: ${data.parentTitle}` : ""].filter(Boolean).join("\n\n"),
      priority:data.priority || "Medium", story_points:data.points || undefined, sprint:data.sprint || undefined,
      acceptance_criteria:(data.acceptanceCriteria || "").split("\n").map((x) => x.replace(/^[-•]\s*/, "").trim()).filter(Boolean),
    };
    // Only send a Jira parent reference when it is a Playground item already created in Jira.
    // Dataset TicketIDs are knowledge-base IDs and must not be assumed to be Jira keys.
    const parentDraft = nodes.find((n) => n.id === data.parentId);
    if (data.type === "Feature" && parentDraft?.data?.type === "Epic" && parentDraft.data.jiraKey) {
      issue.epic_link = parentDraft.data.jiraKey;
    }
    if (data.type === "Story" && parentDraft?.data?.type === "Feature") {
      const epicDraft = nodes.find((n) => n.id === parentDraft.data.parentId);
      if (epicDraft?.data?.type === "Epic" && epicDraft.data.jiraKey) issue.epic_link = epicDraft.data.jiraKey;
    }
    if (data.type === "Task" && parentDraft?.data?.type === "Story" && parentDraft.data.jiraKey) {
      issue.parent = parentDraft.data.jiraKey;
    }
    try {
      const started = await startJiraSync([issue]);
      watchJiraSync(started.jobId, {
        onEvent:(event) => {
          if (event.status === "created" && event.nodeId === selectedNode.id) {
            updateNodeById(selectedNode.id, { jiraKey:event.key }); setNotice(`Created ${event.key} in Jira.`);
          } else if (event.status === "failed" || event.status === "job_failed") setNotice(event.error || "Jira creation failed.");
          else if (event.status === "completed") setPublishBusy(false);
        },
        onError:() => { setPublishBusy(false); setNotice("Jira progress connection closed. Check Jira before retrying."); },
      });
    } catch (error) { setPublishBusy(false); setNotice(error.message || "Could not start Jira creation."); }
  };

  const deleteSelected = () => { if (!selectedId) return; setNodes((c) => c.filter((n) => n.id !== selectedId)); setEdges((c) => c.filter((e) => e.source !== selectedId && e.target !== selectedId)); setSelectedId(null); };
  const clearBoard = () => { if (!nodes.length || window.confirm("Clear every item from this planning canvas?")) { setNodes([]); setEdges([]); setSelectedId(null); } };
  const saveBoard = () => localStorage.setItem("foremanPlanningPlayground", JSON.stringify({ nodes, edges, savedAt:new Date().toISOString() }));
  const restoreBoard = () => { try { const saved=JSON.parse(localStorage.getItem("foremanPlanningPlayground")||"null"); if(saved?.nodes)setNodes(saved.nodes); if(saved?.edges)setEdges(saved.edges); } catch {} };

  const duplicate = selectedNode?.data?.duplicate;
  const distance = asDistance(duplicate?.distance);
  const duplicateLevel = distance !== null && distance <= DUPLICATE_HIGH ? "High overlap" : "Possible overlap";
  const readinessMissing = selectedNode ? [!selectedNode.data.description && "description", ["Story","Task"].includes(selectedNode.data.type) && !selectedNode.data.points && "story points", selectedNode.data.type === "Story" && !selectedNode.data.acceptanceCriteria && "acceptance criteria", PARENT_TYPE[selectedNode.data.type] && !selectedNode.data.parentId && `${PARENT_TYPE[selectedNode.data.type]} placement`].filter(Boolean) : [];

  return <div className="pg-shell">
    <header className="pg-topbar"><button className="pg-brand" onClick={() => navigate("/start")}>Foreman</button><div className="pg-title-wrap"><strong>Planning Playground</strong><span>Plan freely · Foreman checks context · you decide what reaches Jira</span></div><div className="pg-dataset-state"><span className={datasetId ? "on" : "off"}></span>{datasetId ? "Backlog intelligence connected" : "No dataset connected"}</div><div className="pg-actions"><button onClick={restoreBoard}>Restore</button><button onClick={saveBoard}>Save draft</button><button className="danger" onClick={clearBoard}>Clear</button></div></header>
    <div className="pg-toolbar"><select value={newType} onChange={(e)=>setNewType(e.target.value)}>{TYPES.map((t)=><option key={t}>{t}</option>)}</select><input value={title} onChange={(e)=>setTitle(e.target.value)} onKeyDown={(e)=>e.key==="Enter"&&addNode()} placeholder="Describe a work item…"/><button className="primary" onClick={addNode}>+ Add to canvas</button><span className="pg-link-label">Arrow:</span><select value={relationMode} onChange={(e)=>setRelationMode(e.target.value)} title="Auto maps valid Epic → Feature → Story/Task arrows as hierarchy"><option>Auto</option><option>Hierarchy</option><option>Blocks</option><option>Requires</option><option>Relates</option></select><span className="pg-tip">Draw arrows to map hierarchy or dependencies · Draft → Analyze → Review → Create</span></div>
    {notice && <div className="pg-notice">{notice}<button onClick={()=>setNotice("")}>×</button></div>}
    <main className="pg-main"><section className="pg-canvas">{nodes.length===0&&<div className="pg-empty"><div className="pg-empty-icon">✦</div><h2>Your planning space is empty</h2><p>Add work, arrange it visually, then let Foreman compare drafts with the existing backlog before publishing.</p><div className="pg-empty-hints"><span>Epic → Feature → Story</span><span>Duplicate check</span><span>Dependencies</span><span>Human approval</span></div></div>}
      <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeClick={(_,n)=>setSelectedId(n.id)} onPaneClick={()=>setSelectedId(null)} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding:0.18, minZoom:0.45, maxZoom:1 }} minZoom={.2} maxZoom={1.8} defaultEdgeOptions={{ style:{ strokeWidth:1.7 } }} proOptions={{hideAttribution:true}}><Background variant={BackgroundVariant.Dots} gap={24} size={1}/><MiniMap pannable zoomable/><Controls/></ReactFlow></section>
      <aside className={`pg-inspector ${selectedNode?"open":""}`}>{selectedNode ? <>
        <div className="pg-inspector-head"><div><span>{selectedNode.data.jiraKey ? "Created ticket" : "Draft work item"}</span><strong>{selectedNode.data.type}</strong></div><button onClick={()=>setSelectedId(null)}>×</button></div>
        <label>Type<select value={selectedNode.data.type} disabled={Boolean(selectedNode.data.jiraKey)} onChange={(e)=>updateSelected({type:e.target.value,parentId:"",parentTitle:""})}>{TYPES.map((t)=><option key={t}>{t}</option>)}</select></label>
        <label>Title<input value={selectedNode.data.title||""} disabled={Boolean(selectedNode.data.jiraKey)} onChange={(e)=>updateSelected({title:e.target.value})}/></label>
        {PARENT_TYPE[selectedNode.data.type] && <label className="pg-parent-field"><span className="pg-label-row"><span>{PARENT_TYPE[selectedNode.data.type]} placement</span><span className="pg-option-count">{parentOptions.length} available</span></span><select className="pg-parent-select" value={selectedNode.data.parentId||""} disabled={Boolean(selectedNode.data.jiraKey)} onChange={(e)=>setParent(e.target.value)}><option value="">Choose {PARENT_TYPE[selectedNode.data.type]}…</option>{OPTION_GROUPS.map((group)=>{const opts=parentOptions.filter((x)=>x.source===group.key);return opts.length?<optgroup key={group.key} label={`${group.label} (${opts.length})`}>{opts.map((x)=><option key={`${group.key}-${x.id}`} value={x.id}>{x.title} · {x.id}</option>)}</optgroup>:null;})}</select><small className="pg-field-help">Existing {PARENT_TYPE[selectedNode.data.type]}s from the connected dataset and newly created {PARENT_TYPE[selectedNode.data.type]}s on this canvas are suggested together.</small>{selectedNode.data.suggestedParentId && selectedNode.data.suggestedParentId !== selectedNode.data.parentId ? <button type="button" className="pg-parent-suggestion" onClick={()=>setParent(selectedNode.data.suggestedParentId)}>✦ Foreman suggests {parentOptions.find((x)=>x.id===selectedNode.data.suggestedParentId)?.title || selectedNode.data.suggestedParentId}</button> : null}</label>}
        <div className="pg-mapping-help">Tip: you can also map this item by drawing an arrow from its parent card. Valid hierarchy is Epic → Feature → Story/Task.</div><div className="pg-two"><label>Story points<input type="number" min="0" disabled={Boolean(selectedNode.data.jiraKey)} value={selectedNode.data.points||""} onChange={(e)=>updateSelected({points:e.target.value})}/></label><label>Priority<select disabled={Boolean(selectedNode.data.jiraKey)} value={selectedNode.data.priority||"Medium"} onChange={(e)=>updateSelected({priority:e.target.value})}><option>Highest</option><option>High</option><option>Medium</option><option>Low</option><option>Lowest</option></select></label></div>
        <label>Sprint<input value={selectedNode.data.sprint||""} disabled={Boolean(selectedNode.data.jiraKey)} onChange={(e)=>updateSelected({sprint:e.target.value})} placeholder="Jira sprint ID"/></label>
        <label>Description<textarea rows="4" disabled={Boolean(selectedNode.data.jiraKey)} value={selectedNode.data.description||""} onChange={(e)=>updateSelected({description:e.target.value})} placeholder="What is needed and why?"/></label>
        {selectedNode.data.type==="Story" && <label>Acceptance criteria<textarea rows="4" disabled={Boolean(selectedNode.data.jiraKey)} value={selectedNode.data.acceptanceCriteria||""} onChange={(e)=>updateSelected({acceptanceCriteria:e.target.value})} placeholder="One criterion per line…"/></label>}
        {selectedNode.data.type!=="Note" && <section className="pg-ai-card"><div className="pg-ai-head"><div><span className="pg-spark">✦</span><strong>Foreman review</strong></div><button onClick={analyzeSelected} disabled={analysisBusy||Boolean(selectedNode.data.jiraKey)}>{analysisBusy?"Checking…":selectedNode.data.analysis?"Check again":"Analyze"}</button></div>
          {!datasetId ? <p>Connect a dataset to check this draft against existing work.</p> : selectedNode.data.analysis ? <>{duplicate ? <div className="pg-duplicate"><div><strong>{duplicateLevel}</strong><span>{distance!==null?`distance ${distance.toFixed(3)}`:"semantic candidate"}</span></div><b>{duplicate.ticket_id}</b><p>{duplicate.title}</p><div className="pg-dup-actions"><button onClick={()=>updateSelected({duplicate:null})}>Not duplicate</button><button onClick={()=>navigate("/canvas",{state:{datasetId}})}>View existing</button></div></div> : <div className="pg-clear-check">✓ No high-confidence overlap was flagged by the current review threshold.</div>}
          {(selectedNode.data.analysis.architecture_areas||[]).length>0&&<div className="pg-suggestions"><span>Architecture context</span>{selectedNode.data.analysis.architecture_areas.slice(0,3).map((a)=><button key={a.sad_section_id} title={a.sad_title}>{a.sad_section_id} · {a.title}</button>)}</div>}</> : <p>Analyze before publishing to surface related work, architecture context and dependency evidence.</p>}
        </section>}
        <div className="pg-readiness"><strong>Readiness</strong>{readinessMissing.length ? <span>Needs {readinessMissing.join(", ")}</span> : <span className="ready">Ready for review</span>}</div>
        {selectedNode.data.jiraKey ? <div className="pg-created-box">✓ Created in Jira <strong>{selectedNode.data.jiraKey}</strong></div> : selectedNode.data.type==="Note" ? <button className="pg-create" onClick={()=>updateSelected({type:"Task"})}>Convert note to Task</button> : <button className="pg-create" disabled={publishBusy||!selectedNode.data.title?.trim()} onClick={publishSelected}>{publishBusy?"Creating…":"Create ticket in Jira"}</button>}
        <div className="pg-inspector-note">Creation is always explicit. Existing dataset IDs are used for planning context only and are never assumed to be Jira keys.</div><button className="pg-delete" disabled={Boolean(selectedNode.data.jiraKey)} onClick={deleteSelected}>Delete work item</button>
      </> : <div className="pg-inspector-empty"><strong>Inspector</strong><p>Select a card to edit it, choose its hierarchy, check for overlap and create it in Jira.</p></div>}</aside></main>
  </div>;
}
export default function PlanningPlayground(){return <ReactFlowProvider><PlaygroundInner/></ReactFlowProvider>;}
