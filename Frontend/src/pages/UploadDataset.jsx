import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import "./Auth.css";

import { uploadDataset, waitForDatasetReady, reingestDataset } from "../services/api";

const ACCEPTED_FILE_EXTENSIONS = [".xlsx", ".xls"];
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25MB

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const STATUS_COPY = {
  uploaded: "Upload received, queued for ingestion...",
  ingesting: "Embedding rows and building the dependency graph...",
  ready: "Dataset is ready to explore.",
  failed: "Ingestion failed.",
};

function UploadDataset() {
  const navigate = useNavigate();
  const fileInputRef = useRef(null);

  const [selectedFile, setSelectedFile] = useState(null);
  const [fileError, setFileError] = useState("");

  const [phase, setPhase] = useState("idle"); // idle | uploading | polling | ready | error
  const [uploadProgress, setUploadProgress] = useState(0);
  const [datasetId, setDatasetId] = useState(null);
  const [datasetStatus, setDatasetStatus] = useState(null);
  const [errorMessage, setErrorMessage] = useState("");

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const extension = file.name.includes(".")
      ? "." + file.name.split(".").pop().toLowerCase()
      : "";

    if (!ACCEPTED_FILE_EXTENSIONS.includes(extension)) {
      setFileError(
        `"${extension || "this file"}" isn't supported. Upload an ` +
          `${ACCEPTED_FILE_EXTENSIONS.join(" or ")} workbook.`,
      );
      setSelectedFile(null);
      return;
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      setFileError(
        `That file is too large — max ${formatFileSize(MAX_FILE_SIZE_BYTES)}.`,
      );
      setSelectedFile(null);
      return;
    }

    setFileError("");
    setSelectedFile(file);
  };

  const handleRemoveFile = () => {
    setSelectedFile(null);
    setFileError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const beginPolling = (id) => {
    setPhase("polling");

    waitForDatasetReady(id, {
      onTick: (metadata) => setDatasetStatus(metadata),
    })
      .then((metadata) => {
        setDatasetStatus(metadata);
        setPhase("ready");

        localStorage.setItem("foremanDatasetId", id);
        localStorage.setItem(
          "foremanDatasetName",
          metadata.filename || selectedFile?.name || id,
        );

        // Ingestion is done. Stay on this screen and let the person
        // choose where to go next — the canvas, or straight to the
        // forecast report.
      })
      .catch((err) => {
        setPhase("error");
        setErrorMessage(err.message || "Ingestion failed.");
      });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!selectedFile) {
      setFileError("Choose an Excel dataset to upload first.");
      return;
    }

    setErrorMessage("");
    setPhase("uploading");
    setUploadProgress(0);

    try {
      const result = await uploadDataset(selectedFile, {
        onProgress: setUploadProgress,
      });

      setDatasetId(result.dataset_id);
      setDatasetStatus({
        status: result.status || "uploaded",
        filename: selectedFile.name,
      });

      beginPolling(result.dataset_id);
    } catch (err) {
      setPhase("error");
      setErrorMessage(err.message || "Upload failed.");
    }
  };

  const handleRetryIngest = async () => {
    if (!datasetId) return;

    setErrorMessage("");
    try {
      await reingestDataset(datasetId);
      beginPolling(datasetId);
    } catch (err) {
      setPhase("error");
      setErrorMessage(err.message || "Re-ingestion failed.");
    }
  };

  const isBusy = phase === "uploading" || phase === "polling";

  return (
    <div className="auth-page">

      <div className="foreman-watermark">
        Foreman<span>Knowledge</span>
      </div>

      <div className="auth-card auth-card-wide">

        <div className="auth-header">

          <div className="auth-logo">
            GOGO
          </div>

          <div className="auth-badge">
            Step 1 of 2
          </div>

          <h1 className="auth-title">
            Upload your dataset base
          </h1>

          <p className="auth-subtitle">
            Upload the Excel workbook (Teams, TeamMembers, Sprints,
            Holidays, Backlog, Dependencies, SAD_Sections)
          </p>

        </div>

        {phase === "idle" && (
          <div className="prompt-guidance">
            <div className="prompt-guidance-title">
              What to upload
            </div>

            <ul className="prompt-guidance-list">
              <li>
                An <strong>.xlsx</strong> or <strong>.xls</strong> workbook
                with a <code>Backlog</code>, <code>Teams</code>,
                <code> Sprints</code> and <code>Dependencies</code> sheet
                (max {formatFileSize(MAX_FILE_SIZE_BYTES)}).
              </li>
              <li>
                Each upload gets its own isolated Chroma collection and
                dependency graph, so you can keep multiple datasets.
              </li>
            </ul>
          </div>
        )}

        {phase === "idle" && (
          <form className="auth-form" onSubmit={handleSubmit}>
            <div className="auth-field">
              <label className="auth-label">
                Excel workbook
              </label>

              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPTED_FILE_EXTENSIONS.join(",")}
                onChange={handleFileChange}
                className="file-input-hidden"
                id="dataset-upload"
              />

              {!selectedFile && (
                <label htmlFor="dataset-upload" className="file-dropzone">
                  <span className="file-dropzone-title">
                    Click to choose a file
                  </span>
                  <span className="file-dropzone-subtitle">
                    or drag one here
                  </span>
                </label>
              )}

              {selectedFile && (
                <div className="file-chip">
                  <span className="file-chip-name">
                    {selectedFile.name}
                  </span>
                  <span className="file-chip-size">
                    {formatFileSize(selectedFile.size)}
                  </span>
                  <button
                    type="button"
                    className="file-chip-remove"
                    onClick={handleRemoveFile}
                    aria-label="Remove file"
                  >
                    ×
                  </button>
                </div>
              )}

              {fileError && (
                <div className="auth-message">
                  {fileError}
                </div>
              )}
            </div>

            <button className="auth-button" type="submit">
              Upload &amp; Ingest
            </button>

            <button
              className="auth-secondary-button"
              type="button"
              onClick={() => navigate("/start")}
            >
              Back
            </button>
          </form>
        )}

        {isBusy && (
          <div className="auth-form">
            {phase === "uploading" && (
              <div className="auth-field">
                <label className="auth-label">
                  Uploading {selectedFile?.name}
                </label>

                <div className="upload-progress-track">
                  <div
                    className="upload-progress-fill"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>
            )}

            <div className="dataset-status-row">
              <span
                className={`dataset-status-dot ${datasetStatus?.status || "uploaded"}`}
              />

              <div className="dataset-status-text">
                <strong>{datasetStatus?.status || "uploaded"}</strong>
                <span>
                  {STATUS_COPY[datasetStatus?.status] ||
                    "Working on your dataset..."}
                </span>
              </div>

              {datasetId && (
                <span className="dataset-id-chip">{datasetId}</span>
              )}
            </div>
          </div>
        )}

        {phase === "ready" && (
          <div className="auth-form">
            <div className="dataset-status-row">
              <span className="dataset-status-dot ready" />

              <div className="dataset-status-text">
                <strong>ready</strong>
                <span>{STATUS_COPY.ready}</span>
              </div>

              {datasetId && (
                <span className="dataset-id-chip">{datasetId}</span>
              )}
            </div>

            <button
              className="auth-button"
              type="button"
              onClick={() =>
                navigate("/report", { state: { datasetId } })
              }
            >
              View Forecast Report
            </button>

            <button
              className="auth-secondary-button"
              type="button"
              onClick={() =>
                navigate("/canvas", { state: { datasetId } })
              }
            >
              Open Canvas
            </button>
          </div>
        )}

        {phase === "error" && (
          <div className="auth-form">
            <div className="auth-message">
              {errorMessage}
            </div>

            <button
              className="auth-button"
              type="button"
              onClick={handleRetryIngest}
              disabled={!datasetId}
            >
              Retry Ingestion
            </button>

            <button
              className="auth-secondary-button"
              type="button"
              onClick={() => {
                setPhase("idle");
                setSelectedFile(null);
                setDatasetId(null);
                setDatasetStatus(null);
                setErrorMessage("");
              }}
            >
              Start Over
            </button>
          </div>
        )}

        <div className="auth-footer">
          Ingestion builds the graph; the forecast runs on demand
        </div>

      </div>

    </div>
  );
}

export default UploadDataset;
