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
  const [step, setStep] = useState("form"); // "form" | "clarify"
  const [clarifications, setClarifications] = useState([]);

  const finish = (proposal) => {
    if (!Array.isArray(proposal?.tickets) || !proposal.tickets.length) throw new Error("No ticket proposals were returned.");
    // Router state carries the proposal; the dataset workbook remains untouched.
    navigate("/playground", { state: { datasetId, sadProposal: proposal } });
  };

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      const proposal = mode === "file" ? await generateSADFile(datasetId, file) : await generateSADText(datasetId, text, title);
      if (proposal?.status === "needs_clarification") {
        setClarifications((proposal.clarifications || []).map(q => ({ ...q, mode: "default", custom: "" })));
        setStep("clarify");
        return;
      }
      finish(proposal);
    } catch (err) { setError(err.message || "Unable to generate SAD proposal."); }
    finally { setBusy(false); }
  };

  const submitClarifications = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      const answers = clarifications.map(({ question, mode: answerMode, custom, default_answer }) => ({
        question,
        answer: (answerMode === "custom" ? custom.trim() : "") || default_answer,
      }));
      const proposal = mode === "file" ? await generateSADFile(datasetId, file, answers) : await generateSADText(datasetId, text, title, answers);
      finish(proposal);
    } catch (err) { setError(err.message || "Unable to generate SAD proposal."); }
    finally { setBusy(false); }
  };

  const setAnswerMode = (id, answerMode) => {
    setClarifications(prev => prev.map(q => (q.id === id ? { ...q, mode: answerMode } : q)));
  };

  const setCustomAnswer = (id, value) => {
    setClarifications(prev => prev.map(q => (q.id === id ? { ...q, mode: "custom", custom: value } : q)));
  };

  const backToForm = () => { setStep("form"); setClarifications([]); setError(""); };

  return <div className="sad-page">
    <div className="sad-intro"><span className="sad-eyebrow">ARCHITECTURE → DELIVERY</span><h2>Add System Architecture Document</h2><p>Generate a traceable, editable backlog proposal and review possible overlaps with your existing dataset. Jira is never changed automatically.</p></div>
    {step === "clarify" ? (
      <div className="sad-panel sad-clarify">
        <p className="sad-context">Before generating the backlog, confirm a few points. Pick the suggested answer or write your own.</p>
        {clarifications.map((q, idx) => (
          <div className="sad-clarify-item" key={q.id || idx}>
            <label className="sad-clarify-question">{idx + 1}. {q.question}</label>
            {q.context && <p className="sad-clarify-context">{q.context}</p>}
            <div className="sad-clarify-options">
              <label className={`sad-clarify-option${q.mode === "default" ? " is-selected" : ""}`}>
                <input type="radio" name={`clarify-${q.id || idx}`} checked={q.mode === "default"} onChange={() => setAnswerMode(q.id, "default")} />
                <div>
                  <span className="sad-clarify-option-label">Use suggested answer</span>
                  <p className="sad-clarify-option-text">{q.default_answer}</p>
                </div>
              </label>
              <label className={`sad-clarify-option${q.mode === "custom" ? " is-selected" : ""}`}>
                <input type="radio" name={`clarify-${q.id || idx}`} checked={q.mode === "custom"} onChange={() => setAnswerMode(q.id, "custom")} />
                <div><span className="sad-clarify-option-label">Write my own answer</span></div>
              </label>
              {q.mode === "custom" && (
                <textarea className="sad-clarify-custom" rows={3} value={q.custom} onChange={e => setCustomAnswer(q.id, e.target.value)} placeholder="Type your answer…" autoFocus />
              )}
            </div>
          </div>
        ))}
        {error && <div className="sad-error" role="alert">{error}</div>}
        <div className="sad-clarify-actions">
          <button type="button" className="sad-back" onClick={backToForm} disabled={busy}>← Back</button>
          <button type="button" className="sad-submit" onClick={submitClarifications} disabled={busy}>{busy ? "Generating backlog proposal…" : "Submit answers & generate backlog →"}</button>
        </div>
      </div>
    ) : (
      <form className="sad-panel" onSubmit={submit}>
        <div className="sad-switch"><button type="button" className={mode === "file" ? "active" : ""} onClick={() => setMode("file")}>Upload document</button><button type="button" className={mode === "text" ? "active" : ""} onClick={() => setMode("text")}>Paste content</button></div>
        {mode === "file" ? <label className="sad-upload">Select a PDF, DOCX, TXT or Markdown document<input type="file" accept=".pdf,.docx,.txt,.md" onChange={e => setFile(e.target.files?.[0] || null)} />{file && <strong>{file.name}</strong>}</label> : <><label htmlFor="sad-title">Document title</label><input id="sad-title" value={title} onChange={e => setTitle(e.target.value)} maxLength={200}/><label htmlFor="sad-content">Architecture content</label><textarea id="sad-content" value={text} onChange={e => setText(e.target.value)} rows={12} placeholder="Describe architecture, components, interfaces, security, deployment and testing…" /></>}
        <p className="sad-context">{datasetId ? "✓ Existing dataset connected. Candidate duplicates will be shown for review." : "Connect an Excel dataset first to enable existing-backlog comparison."}</p>
        {error && <div className="sad-error" role="alert">{error}</div>}
        <button className="sad-submit" disabled={busy || !datasetId || (mode === "file" ? !file : text.trim().length < 60)}>{busy ? "Analyzing SAD and checking backlog…" : "Generate backlog proposal →"}</button>
      </form>
    )}
  </div>;
}
