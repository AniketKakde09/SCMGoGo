import { useState } from "react";
import "./SmartSprintPlanner.css";
const API = (import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL || "http://localhost:8000").replace(/\/$/, "");
const day = (date, offset) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate()+offset); return d.toISOString().slice(0,10); };
export default function SmartSprintPlanner({ nodes, edges, datasetId, onClose }) {
  const [source, setSource] = useState(datasetId ? "dataset" : "manual");
  const [jiraSprintMappings, setJiraSprintMappings] = useState("");
  const [jiraIssueMappings, setJiraIssueMappings] = useState("");
  const [firstDate, setFirstDate] = useState("");
  const [ids, setIds] = useState("");
  const [capacity, setCapacity] = useState("30");
  const [velocity, setVelocity] = useState("30");
  const [holidays, setHolidays] = useState("");
  const [committedIds, setCommittedIds] = useState("");
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState(null);
  const parseMappings = (input, numeric) => {
    const result = {};
    for (const line of input.split(/[\n,]+/).map(x=>x.trim()).filter(Boolean)) {
      const separator = line.indexOf("=");
      if (separator < 1) throw new Error(`Invalid mapping: ${line}. Use DATASET-ID=JIRA-ID`);
      const key = line.slice(0, separator).trim(), raw = line.slice(separator+1).trim();
      if (!key || !raw || Object.hasOwn(result,key)) throw new Error(`Invalid or duplicate mapping: ${line}`);
      if (numeric && (!/^\d+$/.test(raw) || Number(raw) < 1)) throw new Error(`Invalid Jira sprint ID: ${raw}`);
      result[key] = numeric ? Number(raw) : raw;
    }
    return result;
  };
  const createPreview = async () => {
    setBusy(true); setError(""); setPreview(null); setConfirmed(false); setResult(null);
    try {
      if (source === "dataset") {
        if (!datasetId) throw new Error("Connect an uploaded dataset first.");
        const response = await fetch(`${API}/api/planning/sprints/datasets/${encodeURIComponent(datasetId)}/preview`, {
          method:"POST", headers:{"Content-Type":"application/json"},
          body:JSON.stringify({jira_sprint_ids:parseMappings(jiraSprintMappings,true),jira_issue_keys:parseMappings(jiraIssueMappings,false)})
        });
        const data=await response.json();
        if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail));
        setPreview(data);
        return;
      }
      const sprintIds = ids.split(",").map(v=>Number(v.trim()));
      if (!firstDate || !sprintIds.length || sprintIds.some(v=>!Number.isSafeInteger(v)||v<=0) || new Set(sprintIds).size!==sprintIds.length) throw new Error("Provide a start date and unique numeric Jira sprint IDs.");
      const locked = new Set(committedIds.split(",").map(v=>Number(v.trim())).filter(Boolean));
      const sprintRows = sprintIds.map((id,i)=>({id,name:`Sprint ${id}`,start:day(firstDate,i*14),end:day(firstDate,i*14+13),capacity_points:Number(capacity),team:"default",committed:locked.has(id)}));
      const tickets = nodes.filter(n=>["Story","Task","Sub-task"].includes(n.data.type)).map(n=>({id:n.id,title:n.data.title||"",points:Number(n.data.points),jira_key:n.data.jiraKey||null,current_sprint_id:n.data.sprint && /^\d+$/.test(String(n.data.sprint))?Number(n.data.sprint):null,committed:Boolean(n.data.committed),team:"default"}));
      if (!tickets.length || tickets.some(t=>!Number.isFinite(t.points)||t.points<=0)) throw new Error("All Stories and Tasks need positive story points before planning.");
      const included = new Set(tickets.map(t=>t.id));
      const dependencies = edges.filter(e=>e.data?.kind==="dependency" && ["Blocks","Requires"].includes(e.data.relation)).map(e=>e.data.relation==="Requires"?[e.target,e.source]:[e.source,e.target]).filter(([a,b])=>included.has(a)&&included.has(b));
      const response = await fetch(`${API}/api/planning/sprints/preview`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tickets,dependencies,sprints:sprintRows,holidays:holidays.split(",").map(v=>v.trim()).filter(Boolean),velocity_points:{default:Number(velocity)},baseline_workdays:10})});
      const data=await response.json(); if(!response.ok) throw new Error(typeof data.detail==="string"?data.detail:JSON.stringify(data.detail));
      setPreview(data);
    } catch(e) { setError(e.message); } finally {setBusy(false);}
  };
  const sync = async () => {
    setBusy(true); setError("");
    try {
      const response=await fetch(`${API}/api/planning/sprints/apply`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({preview_id:preview.preview_id,confirmation:"SYNC APPROVED SPRINTS",allow_committed_changes:false})});
      const data=await response.json();if(!response.ok) throw new Error(typeof data.detail==="string"?data.detail:JSON.stringify(data.detail));
      setResult(data);
    } catch(e){setError(e.message);}finally{setBusy(false);}
  };
  return <div className="ssp-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><section className="ssp-dialog" role="dialog" aria-modal="true" aria-label="Smart Sprint Planner">
    <header><div><small>FOREMAN / PLANNING</small><h2>Smart Sprint Planner</h2><p>Preview dependency-first scheduling. Jira is never changed by a preview.</p></div><button type="button" onClick={onClose} aria-label="Close planner">×</button></header>
    <div className="ssp-fields"><label>Planning source<select value={source} onChange={e=>{setSource(e.target.value);setPreview(null);setResult(null);}}><option value="dataset" disabled={!datasetId}>Uploaded Excel dataset</option><option value="manual">Manual planning (legacy)</option></select></label></div>
    {source === "dataset" ? <><p className="ssp-note">Reads Teams, TeamMembers, Sprints, Holidays, Backlog and Dependencies from your already uploaded dataset. No re-entry of dates, velocity, capacity or holidays. Dataset sprint IDs are NOT Jira sprint IDs.</p><details><summary>Optional: map dataset IDs to verified Jira IDs for synchronization</summary><div className="ssp-fields"><label>Dataset sprint = Jira sprint ID<textarea rows="3" placeholder="SPR-04=123" value={jiraSprintMappings} onChange={e=>setJiraSprintMappings(e.target.value)}/></label><label>Dataset ticket = Jira issue key<textarea rows="3" placeholder="T-100=PROJ-123" value={jiraIssueMappings} onChange={e=>setJiraIssueMappings(e.target.value)}/></label></div><p className="ssp-note">Only explicitly mapped existing Jira issues can be moved, and only to explicitly mapped future Jira sprints after approval.</p></details></> : <><div className="ssp-fields"><label>First sprint starts<input type="date" value={firstDate} onChange={e=>setFirstDate(e.target.value)}/></label><label>Future Jira sprint IDs (comma separated)<input placeholder="101, 102, 103" value={ids} onChange={e=>setIds(e.target.value)}/></label><label>Capacity points / sprint<input type="number" min="0" value={capacity} onChange={e=>setCapacity(e.target.value)}/></label><label>Velocity points / sprint<input type="number" min="1" value={velocity} onChange={e=>setVelocity(e.target.value)}/></label><label>Holiday dates (YYYY-MM-DD, comma separated)<input placeholder="2026-10-02, 2026-10-20" value={holidays} onChange={e=>setHolidays(e.target.value)}/></label><label>Committed sprint IDs (never changed)<input placeholder="101" value={committedIds} onChange={e=>setCommittedIds(e.target.value)}/></label></div>
    <p className="ssp-note">Manual mode assumes 14-day sprints. Enter actual future Jira sprint IDs. Hierarchy edges are not scheduling dependencies.</p></>}
    <button type="button" className="ssp-primary" disabled={busy} onClick={createPreview}>{busy?"Working…":"Generate planning preview"}</button>
    {error&&<p className="ssp-error" role="alert">{error}</p>}
    {preview&&<div className="ssp-result"><h3>Proposed plan</h3><p>{preview.heuristic}</p><p>Conditional completion: <strong>{preview.completion_date||"Not forecastable"}</strong> · Unscheduled: {preview.unscheduled.length} · Conflicts: {preview.conflicts.length}</p><div className="ssp-list">{preview.capacity.map(s=><div key={s.id}>{s.dataset_sprint_id || `Sprint ${s.id}`}{s.name ? ` · ${s.name}` : ""}: {s.working_days} working days · {s.effective_capacity} pts {s.committed?"· locked":""}</div>)}</div><div className="ssp-list">{preview.changes.map(c=><div key={c.ticket_id}>{c.title||c.ticket_id}: {c.from_dataset_sprint_id||c.from_sprint_id||"Unscheduled"} → {c.to_dataset_sprint_id||c.to_sprint_id} {c.jira_key?`· ${c.jira_key}`:"· local draft"}</div>)}</div>{preview.dataset_warnings?.map((warning,i)=><p className="ssp-note" key={`warning-${i}`}>⚠ {warning}</p>)}{preview.warnings?.map((warning,i)=><p className="ssp-note" key={`general-${i}`}>{warning}</p>)}{preview.conflicts.map((c,i)=><p className="ssp-error" key={i}>{c.ticket_id}: {c.reason}</p>)}<p className="ssp-note">Local drafts are preview-only. Jira sync moves existing Jira issues only; it does not update the Canvas or create tickets.</p><label className="ssp-confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> I reviewed the proposed changes and authorize moving existing Jira issues to future sprints.</label><button type="button" className="ssp-primary" disabled={!confirmed||busy||preview.conflicts.length>0||!(source === "dataset" ? preview.jira_sync_ready : preview.changes.some(c=>c.jira_key))||Boolean(result)} onClick={sync}>Synchronize approved Jira sprint changes</button></div>}
    {result&&<p role="status">Jira sync: {result.status}. Applied: {result.applied.length}; failed: {result.failed.length}. {result.failed.map(f=>`${f.jira_key}: ${f.error}`).join("; ")}</p>}
  </section></div>;
}
