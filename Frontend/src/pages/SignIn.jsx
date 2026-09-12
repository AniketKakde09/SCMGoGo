import { useNavigate } from "react-router-dom";
import "./Auth.css";

function SignIn() {
  const navigate = useNavigate();

  const handleSignIn = (e) => {
    e.preventDefault();

    // TODO: Add real authentication here

    localStorage.removeItem("userInput");
    localStorage.removeItem("canvasMode");
    localStorage.removeItem("hasSavedProgress");
    localStorage.removeItem("scrumSessionId");

    navigate("/start");
  };

  return (
    <div className="auth-page">

      <div className="scrum-watermark">
        ScrumMaster<span>GoGo</span>
      </div>

      <div className="auth-card">

        <div className="auth-header">
          <div className="auth-logo">
            PI
          </div>

          <div className="auth-badge">
            PI Planning Platform
          </div>

          <h1 className="auth-title">
            Welcome back
          </h1>

          <p className="auth-subtitle">
            Sign in to continue to your PI planning workspace.
          </p>
        </div>

        <form
          className="auth-form"
          onSubmit={handleSignIn}
        >
          <div className="auth-field">
            <label className="auth-label">
              Email address
            </label>

            <input
              className="auth-input"
              type="email"
              placeholder="you@company.com"
              required
            />
          </div>

          <div className="auth-field">
            <label className="auth-label">
              Password
            </label>

            <input
              className="auth-input"
              type="password"
              placeholder="Enter your password"
              required
            />
          </div>

          <button
            className="auth-button"
            type="submit"
          >
            Sign In
          </button>
        </form>

        <div className="auth-footer">
          ScrumMasterGoGo version 1.0
        </div>

      </div>
    </div>
  );
}

export default SignIn;
