import { useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import "./Auth.css";

// Kept in sync with backend/services/document_converter.py
// SUPPORTED_EXTENSIONS.
const ACCEPTED_FILE_EXTENSIONS = [
  ".pdf",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
  ".csv",
  ".txt",
  ".md",
  ".html",
  ".htm",
];

const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15MB, matches backend

// Optional dataset upload configuration
const DATASET_ACCEPTED_EXTENSION = ".xlsx";
const DATASET_MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15MB

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function UserInput() {
  const navigate = useNavigate();
  const location = useLocation();

  // Main document upload
  const fileInputRef = useRef(null);

  // Optional dataset upload
  const datasetInputRef = useRef(null);

  const [mode, setMode] = useState("text");
  const [input, setInput] = useState("");
  const [clarificationsEnabled, setClarificationsEnabled] = useState(false);

  // Main document
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileError, setFileError] = useState("");

  // Optional dataset
  const [selectedDataset, setSelectedDataset] = useState(null);
  const [datasetError, setDatasetError] = useState("");

  const [message, setMessage] = useState(
    location.state?.message || ""
  );

  const clearSessionState = () => {
    // Any of these paths start a brand-new plan — never let a
    // leftover session, saved-progress, or blank-canvas flag from
    // a previous visit bleed into it.
    localStorage.removeItem("canvasMode");
    localStorage.removeItem("hasSavedProgress");
    localStorage.removeItem("scrumSessionId");
  };

  const handleModeChange = (nextMode) => {
    setMode(nextMode);
    setMessage("");
    setFileError("");
  };

  // ---------------------------------------------------------
  // Main document upload
  // ---------------------------------------------------------

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];

    if (!file) {
      return;
    }

    const extension = file.name.includes(".")
      ? "." + file.name.split(".").pop().toLowerCase()
      : "";

    if (!ACCEPTED_FILE_EXTENSIONS.includes(extension)) {
      setFileError(
        `"${extension || "this file"}" isn't supported. Try ` +
          `${ACCEPTED_FILE_EXTENSIONS.join(", ")}.`,
      );
      setSelectedFile(null);
      return;
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      setFileError(
        `That file is too large — max ${formatFileSize(
          MAX_FILE_SIZE_BYTES
        )}.`,
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

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  // ---------------------------------------------------------
  // Optional dataset upload
  // ---------------------------------------------------------

  const handleDatasetChange = (e) => {
    const file = e.target.files?.[0];

    if (!file) {
      return;
    }

    const extension = file.name.includes(".")
      ? "." + file.name.split(".").pop().toLowerCase()
      : "";

    // Dataset must be XLSX only
    if (extension !== DATASET_ACCEPTED_EXTENSION) {
      setDatasetError("Only .xlsx Excel files are supported.");
      setSelectedDataset(null);
      return;
    }

    // Dataset size validation
    if (file.size > DATASET_MAX_FILE_SIZE_BYTES) {
      setDatasetError(
        `That dataset is too large — max ${formatFileSize(
          DATASET_MAX_FILE_SIZE_BYTES
        )}.`,
      );
      setSelectedDataset(null);
      return;
    }

    setDatasetError("");
    setSelectedDataset(file);
  };

  const handleRemoveDataset = () => {
    setSelectedDataset(null);
    setDatasetError("");

    if (datasetInputRef.current) {
      datasetInputRef.current.value = "";
    }
  };

  // ---------------------------------------------------------
  // Submit
  // ---------------------------------------------------------

  const handleSubmit = (e) => {
    e.preventDefault();

    clearSessionState();

    // -------------------------------------------------------
    // Document mode
    // -------------------------------------------------------
    if (mode === "file") {
      if (!selectedFile) {
        setFileError("Choose a document to upload first.");
        return;
      }

      localStorage.removeItem("userInput");

      // The File objects are passed via router state (in-memory).
      // They can't be JSON-serialized into localStorage.
      //
      // Canvas.jsx can later read:
      // location.state.uploadedFile
      // location.state.uploadedDataset
      navigate("/canvas", {
        state: {
          uploadedFile: selectedFile,
          uploadedDataset: selectedDataset,
          clarificationsEnabled,
        },
      });

      return;
    }

    // -------------------------------------------------------
    // Prompt mode
    // -------------------------------------------------------

    const trimmedInput = input.trim();

    if (!trimmedInput) {
      return;
    }

    localStorage.setItem("userInput", trimmedInput);

    // Dataset is optional and can be supplied together with
    // the prompt.
    navigate("/canvas", {
      state: {
        uploadedDataset: selectedDataset,
        clarificationsEnabled,
      },
    });
  };

  return (
    <div className="auth-page">

      <div className="scrum-watermark">
        ScrumMaster<span>GoGo</span>
      </div>

      <div className="auth-card auth-card-wide">

        <div className="auth-header">

          <div className="auth-logo">
            PI
          </div>

          <div className="auth-badge">
            Step 1 of 2
          </div>

          <h1 className="auth-title">
            Define your PI plan
          </h1>

          <p className="auth-subtitle">
            Describe your Program Increment, or upload a document
            (such as a System Architecture Document) — we'll use
            it to build the planning canvas.
          </p>

        </div>

        <div className="intake-mode-toggle">

          <button
            type="button"
            className={
              mode === "text"
                ? "intake-mode-btn intake-mode-btn-active"
                : "intake-mode-btn"
            }
            onClick={() => handleModeChange("text")}
          >
            Write a prompt
          </button>

          <button
            type="button"
            className={
              mode === "file"
                ? "intake-mode-btn intake-mode-btn-active"
                : "intake-mode-btn"
            }
            onClick={() => handleModeChange("file")}
          >
            Upload a document
          </button>

        </div>

        {mode === "text" && (
          <div className="prompt-guidance">

            <div className="prompt-guidance-title">
              What to include in your prompt
            </div>

            <ul className="prompt-guidance-list">
              <li>
                <strong>PI name</strong> — e.g. "PI 2026.1" or the quarter
                this increment covers.
              </li>

              <li>
                <strong>Epic names</strong> — the major work streams you
                want represented on the canvas.
              </li>

              <li>
                <strong>Planning details</strong> — teams involved, key
                dependencies, target sprints, and any goals or
                constraints for the PI.
              </li>
            </ul>

          </div>
        )}

        {mode === "file" && (
          <div className="prompt-guidance">

            <div className="prompt-guidance-title">
              What to upload
            </div>

            <ul className="prompt-guidance-list">
              <li>
                A <strong>System/Software Architecture Document</strong>,
                PRD, workshop notes, or similar planning document.
              </li>

              <li>
                Supported types: {ACCEPTED_FILE_EXTENSIONS.join(", ")}
                {" "}(max {formatFileSize(MAX_FILE_SIZE_BYTES)}).
              </li>

              <li>
                If anything important is missing, we'll ask you
                follow-up questions before building the plan.
              </li>
            </ul>

          </div>
        )}

        <form
          className="auth-form"
          onSubmit={handleSubmit}
        >

          {/* ------------------------------------------------
              Prompt input
          ------------------------------------------------- */}

          {mode === "text" && (
            <div className="auth-field">

              <label className="auth-label">
                PI planning description
              </label>

              <textarea
                className="auth-textarea auth-textarea-lg"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder='e.g. "PI 2026.1 for the Payments and Onboarding teams. Epics: Checkout Redesign, Fraud Detection Upgrade, New User Onboarding. Checkout Redesign depends on..."'
                required
              />

            </div>
          )}

          {/* ------------------------------------------------
              Main document upload
          ------------------------------------------------- */}

          {mode === "file" && (
            <div className="auth-field">

              <label className="auth-label">
                Document
              </label>

              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPTED_FILE_EXTENSIONS.join(",")}
                onChange={handleFileChange}
                className="file-input-hidden"
                id="pi-document-upload"
              />

              {!selectedFile && (
                <label
                  htmlFor="pi-document-upload"
                  className="file-dropzone"
                >
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
          )}

          {/* ------------------------------------------------
              Optional dataset upload
          ------------------------------------------------- */}

          <div className="auth-field dataset-field">

            <label className="auth-label">
              Dataset{" "}
              <span className="optional-label">
                (optional)
              </span>
            </label>

            <p className="dataset-description">
              Upload an Excel dataset that can be used as
              supporting information for your PI plan.
            </p>

            <input
              ref={datasetInputRef}
              type="file"
              accept=".xlsx"
              onChange={handleDatasetChange}
              className="file-input-hidden"
              id="pi-dataset-upload"
            />

            {!selectedDataset && (
              <label
                htmlFor="pi-dataset-upload"
                className="file-dropzone dataset-dropzone"
              >
                <span className="file-dropzone-title">
                  Click to choose an Excel dataset
                </span>

                <span className="file-dropzone-subtitle">
                  .xlsx only · max{" "}
                  {formatFileSize(DATASET_MAX_FILE_SIZE_BYTES)}
                </span>
              </label>
            )}

            {selectedDataset && (
              <div className="file-chip">

                <span className="file-chip-name">
                  {selectedDataset.name}
                </span>

                <span className="file-chip-size">
                  {formatFileSize(selectedDataset.size)}
                </span>

                <button
                  type="button"
                  className="file-chip-remove"
                  onClick={handleRemoveDataset}
                  aria-label="Remove dataset"
                >
                  ×
                </button>

              </div>
            )}

            {datasetError && (
              <div className="auth-message">
                {datasetError}
              </div>
            )}

          </div>

          <label className="clarification-toggle">
            <input
              type="checkbox"
              checked={clarificationsEnabled}
              onChange={(e) => setClarificationsEnabled(e.target.checked)}
            />
            <span>
              <strong>Ask clarification questions first</strong>
              <small>We’ll ask up to 4 questions before creating your PI plan.</small>
            </span>
          </label>

          {/* ------------------------------------------------
              Submit
          ------------------------------------------------- */}

          <button
            className="auth-button"
            type="submit"
          >
            Create PI Plan
          </button>

          {message && (
            <div className="auth-message">
              {message}
            </div>
          )}

          <button
            className="auth-secondary-button"
            type="button"
            onClick={() => navigate("/start")}
          >
            Back
          </button>

        </form>

        <div className="auth-footer">
          Your PI plan will open in the canvas editor
        </div>

      </div>

    </div>
  );
}

export default UserInput;
