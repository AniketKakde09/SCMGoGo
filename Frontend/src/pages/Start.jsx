import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getDatasetStatus } from "../services/api";
import "./Start.css";

const JOURNEY = [
  { step: "01", icon: "▤", title: "Connect knowledge", text: "Ingest the synthetic workbook, architecture sections and existing backlog.", route: "/upload", action: "Manage dataset" },
  { step: "02", icon: "◇", title: "Explore delivery", text: "Inspect traceability and dependencies, search existing work and clarify new demand.", route: "/canvas", action: "Open Canvas", needsDataset: true },
  { step: "03", icon: "▧", title: "Refine & review", text: "Build a change proposal and inspect suggested hierarchy before publishing.", route: "/playground", action: "Open Planning studio" },
  { step: "04", icon: "▥", title: "Forecast delivery", text: "Review the capacity-based sprint forecast and download its report.", route: "/report", action: "View forecast", needsDataset: true },
];

export default function Start() {
  const navigate = useNavigate();
  const [datasetId, setDatasetId] = useState(() => localStorage.getItem("foremanDatasetId") || "");
  const [datasetName, setDatasetName] = useState(() => localStorage.getItem("foremanDatasetName") || "");
  const [status, setStatus] = useState(datasetId ? "checking" : "missing");
  const [error, setError] = useState("");
  const [showIdField, setShowIdField] = useState(false);
  const [datasetIdInput, setDatasetIdInput] = useState("");

  useEffect(() => {
    if (!datasetId) return;
    let active = true;
    getDatasetStatus(datasetId).then((result) => {
      if (!active) return;
      setStatus(result.status || "unknown");
      setError(result.error || "");
      if (result.filename) { setDatasetName(result.filename); localStorage.setItem("foremanDatasetName", result.filename); }
    }).catch((err) => { if (active) { setStatus("unreachable"); setError(err.message || "Cannot reach the dataset API."); } });
    return () => { active = false; };
  }, [datasetId]);

  const openById = (event) => {
    event.preventDefault();
    const id = datasetIdInput.trim();
    if (!id) return;
    localStorage.setItem("foremanDatasetId", id);
    localStorage.removeItem("foremanDatasetName");
    setDatasetId(id);
    setDatasetName("");
    setStatus("checking");
    setError("");
    setShowIdField(false);
  };

  return <div className="fm-home">
    <section className="fm-home-hero">
      <div className="fm-home-hero-copy">
        <span className="fm-home-kicker">Gogo / AI Scrum Master</span>
        <h2>Turn complex demand into a delivery-ready plan.</h2>
        <p>Work from architecture to backlog, understand existing work, and shape sprint decisions with human oversight.</p>
        <div className="fm-home-hero-actions">
          <button className="fm-home-primary" type="button" onClick={() => navigate(datasetId && status === "ready" ? "/canvas" : "/upload")}>{datasetId && status === "ready" ? "Open Delivery Canvas" : "Connect a dataset"} <span aria-hidden="true">↗</span></button>
          <button className="fm-home-secondary" type="button" onClick={() => navigate("/playground")}>Open Planning studio</button>
        </div>
      </div>
      <div className="fm-home-hero-mark" aria-hidden="true"><span>GOGO</span><i /><i /><i /></div>
    </section>
    <section className="fm-home-dataset" aria-label="Active dataset">
      <div className="fm-home-dataset-main">
        <span className="fm-home-dataset-symbol">▤</span>
        <div><small>ACTIVE KNOWLEDGE</small><h3>{datasetName || (datasetId ? "Saved dataset" : "No dataset connected")}</h3><p>{status === "ready" ? "Indexed and ready for search, intake and forecasting." : status === "checking" ? "Checking the saved dataset…" : status === "missing" ? "Upload the synthetic pack to begin a dataset-grounded workflow." : status === "unreachable" ? "The dataset service could not be reached. Check that the backend is running." : `Dataset status: ${status}.`}</p></div>
      </div>
      <div className="fm-home-dataset-actions">
        <span className={`fm-home-status ${status}`}>{status === "ready" ? "● Ready" : status === "missing" ? "Not connected" : status === "checking" ? "Checking…" : status === "unreachable" ? "Unavailable" : status}</span>
        <button type="button" onClick={() => navigate("/upload")}>Upload / replace ↗</button>
      </div>
    </section>
    {error && <p className="fm-home-error" role="alert">{error}</p>}
    <div className="fm-home-section-title"><div><span className="fm-home-kicker">YOUR WORKFLOW</span><h3>One connected delivery workspace</h3></div><span>Four steps · Human-owned decisions</span></div>
    <section className="fm-home-journey" aria-label="Foreman workflow">
      {JOURNEY.map((item) => <article className="fm-home-journey-card" key={item.step}>
        <div className="fm-home-card-head"><span>{item.step}</span><span className="fm-home-card-icon" aria-hidden="true">{item.icon}</span></div>
        <h4>{item.title}</h4><p>{item.text}</p>
        <button type="button" disabled={item.needsDataset && status !== "ready"} onClick={() => navigate(item.route)}>{item.action} <span aria-hidden="true">→</span></button>
      </article>)}
    </section>
    <section className="fm-home-footnote"><div><strong>Have a dataset ID?</strong><span>Reconnect an existing dataset without uploading it again.</span></div><button type="button" onClick={() => setShowIdField((open) => !open)}>{showIdField ? "Close" : "Connect by ID"}</button></section>
    {showIdField && <form className="fm-home-id-form" onSubmit={openById}><label htmlFor="fm-existing-id">Dataset ID</label><input id="fm-existing-id" value={datasetIdInput} onChange={(event) => setDatasetIdInput(event.target.value)} placeholder="Paste an existing dataset ID" required /><button type="submit">Connect dataset</button></form>}
  </div>;
}
