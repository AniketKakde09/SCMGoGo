import { useNavigate } from "react-router-dom";
import "./Auth.css";

function Start() {
  const navigate = useNavigate();

  const handleWriteInput = () => {
    // Make sure a stale blank-canvas flag doesn't linger from
    // a previous visit and skip the workflow generation later.
    // Also clear any saved-progress / session state — this is a
    // new plan, not a continuation of a previous one.
    localStorage.removeItem("canvasMode");
    localStorage.removeItem("hasSavedProgress");
    localStorage.removeItem("scrumSessionId");

    navigate("/input");
  };

  const handleBlankCanvas = () => {
    // Make sure no stale description is picked up by the canvas,
    // and flag that this session should open empty. Also clear
    // any saved-progress / session state — this is a new plan.
    localStorage.removeItem("userInput");
    localStorage.removeItem("hasSavedProgress");
    localStorage.removeItem("scrumSessionId");
    localStorage.setItem("canvasMode", "blank");

    navigate("/canvas");
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
            Get Started
          </div>

          <h1 className="auth-title">
            How would you like to start?
          </h1>

          <p className="auth-subtitle">
            Describe your PI plan and let us generate the canvas for you,
            or start from scratch and build it yourself.
          </p>

        </div>

        <div className="start-options">

          <button
            type="button"
            className="start-option"
            onClick={handleWriteInput}
          >
            <span className="start-option-icon">✍️</span>

            <span className="start-option-text">
              <strong>Write a prompt</strong>
              <small>
                Tell us about your PI, Epics, and planning details —
                we'll build the canvas for you.
              </small>
            </span>

            <span className="start-option-arrow">→</span>
          </button>

          <button
            type="button"
            className="start-option"
            onClick={handleBlankCanvas}
          >
            <span className="start-option-icon">🧩</span>

            <span className="start-option-text">
              <strong>Start with a blank canvas</strong>
              <small>
                Skip the prompt and build your PI plan manually,
                node by node.
              </small>
            </span>

            <span className="start-option-arrow">→</span>
          </button>

        </div>

        <div className="auth-footer">
          ScrumMasterGoGo version 1.0
        </div>

      </div>
    </div>
  );
}

export default Start;
