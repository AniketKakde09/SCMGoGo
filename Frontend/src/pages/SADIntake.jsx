import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { generateSADFile, generateSADText } from "../services/api";
import "./SADIntake.css";

export default function SADIntake() {
  const navigate = useNavigate();
  const datasetId = localStorage.getItem("foremanDatasetId") || "";
  const [mode, setMode] = useState("file");
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState("System Architecture Document");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      const proposal = mode === "file" ? await generateSADFile(datasetId, file) : await generateSADText(datasetId, text, title);
      if (!Array.isArray(proposal?.tickets) || !proposal.tickets.length) throw new Error("No ticket proposals were returned.");
      // Router state carries the proposal; the dataset workbook remains untouched.
      navigate("/playground", { state: { datasetId, sadProposal: proposal } });
    } catch (err) { setError(err.message || "Unable to generate SAD proposal."); }
    finally { setBusy(false); }
  };
  return <div className="sad-page">
    <div className="sad-intro"><span className="sad-eyebrow">ARCHITECTURE → DELIVERY</span><h2>Add System Architecture Document</h2><p>Generate a traceable, editable backlog proposal and review possible overlaps with your existing dataset. Jira is never changed automatically.</p></div>
    <form className="sad-panel" onSubmit={submit}>
      <div className="sad-switch"><button type="button" className={mode === "file" ? "active" : ""} onClick={() => setMode("file")}>Upload document</button><button type="button" className={mode === "text" ? "active" : ""} onClick={() => setMode("text")}>Paste content</button></div>
      {mode === "file" ? <label className="sad-upload">Select a PDF, DOCX, TXT or Markdown document<input type="file" accept=".pdf,.docx,.txt,.md" onChange={e => setFile(e.target.files?.[0] || null)} />{file && <strong>{file.name}</strong>}</label> : <><label htmlFor="sad-title">Document title</label><input id="sad-title" value={title} onChange={e => setTitle(e.target.value)} maxLength={200}/><label htmlFor="sad-content">Architecture content</label><textarea id="sad-content" value={text} onChange={e => setText(e.target.value)} rows={12} placeholder="Describe architecture, components, interfaces, security, deployment and testing…" /></>}
      <p className="sad-context">{datasetId ? "✓ Existing dataset connected. Candidate duplicates will be shown for review." : "Connect an Excel dataset first to enable existing-backlog comparison."}</p>
      {error && <div className="sad-error" role="alert">{error}</div>}
      <button className="sad-submit" disabled={busy || !datasetId || (mode === "file" ? !file : text.trim().length < 60)}>{busy ? "Analyzing SAD and checking backlog…" : "Generate backlog proposal →"}</button>
    </form>
  </div>;
}
