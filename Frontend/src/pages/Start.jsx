import { useState } from "react";
import { useNavigate } from "react-router-dom";
import "./Auth.css";

function Start() {
  const navigate = useNavigate();

  const lastDatasetId = localStorage.getItem("foremanDatasetId");
  const lastDatasetName = localStorage.getItem("foremanDatasetName");

  const [showIdField, setShowIdField] = useState(false);
  const [datasetIdInput, setDatasetIdInput] = useState("");

  const handleUploadNew = () => {
    navigate("/upload");
  };

  const handleContinueLast = () => {
    navigate("/canvas", { state: { datasetId: lastDatasetId } });
  };

  const handleOpenById = (e) => {
    e.preventDefault();

    const trimmed = datasetIdInput.trim();
    if (!trimmed) {
      return;
    }

    localStorage.setItem("foremanDatasetId", trimmed);
    localStorage.removeItem("foremanDatasetName");

    navigate("/canvas", { state: { datasetId: trimmed } });
  };

  return (
    <div className="auth-page">

      <div className="foreman-watermark">
        Foreman<span>Knowledge</span>
      </div>

      <div className="auth-card auth-card-wide">

        <div className="auth-header">

          <div className="auth-logo">
            FK
          </div>

          <div className="auth-badge">
            Get Started
          </div>

          <h1 className="auth-title">
            How would you like to start?
          </h1>

          <p className="auth-subtitle">
            Upload an Excel knowledge base to ingest into Foreman, or
            reopen a dataset you've already processed.
          </p>

        </div>

        <div className="start-options">

          {lastDatasetId && (
            <button
              type="button"
              className="start-option"
              onClick={handleContinueLast}
            >
              <span className="start-option-icon">🗂️</span>

              <span className="start-option-text">
                <strong>Continue with your last dataset</strong>
                <small>
                  {lastDatasetName || lastDatasetId}
                </small>
              </span>

              <span className="start-option-arrow">→</span>
            </button>
          )}

          <button
            type="button"
            className="start-option"
            onClick={handleUploadNew}
          >
            <span className="start-option-icon">📤</span>

            <span className="start-option-text">
              <strong>Upload a new dataset</strong>
              <small>
                Upload an Excel knowledge base (Teams, Backlog,
                Dependencies, Sprints...) — we'll ingest it and build
                the canvas for you.
              </small>
            </span>

            <span className="start-option-arrow">→</span>
          </button>

          <button
            type="button"
            className="start-option"
            onClick={() => setShowIdField((current) => !current)}
          >
            <span className="start-option-icon">🔑</span>

            <span className="start-option-text">
              <strong>Open an existing dataset by ID</strong>
              <small>
                Already ingested a dataset elsewhere? Paste its
                dataset ID to reopen it.
              </small>
            </span>

            <span className="start-option-arrow">
              {showIdField ? "▲" : "→"}
            </span>
          </button>

          {showIdField && (
            <form className="auth-form" onSubmit={handleOpenById}>
              <div className="auth-field">
                <label className="auth-label">
                  Dataset ID
                </label>

                <input
                  className="auth-input"
                  type="text"
                  value={datasetIdInput}
                  onChange={(e) => setDatasetIdInput(e.target.value)}
                  placeholder="e.g. 2e4736a5982e46ebbe98e94efb645017"
                  autoFocus
                />
              </div>

              <button className="auth-button" type="submit">
                Open Dataset
              </button>
            </form>
          )}

        </div>

        <div className="auth-footer">
          Foreman Knowledge API · v1.0
        </div>

      </div>
    </div>
  );
}

export default Start;
