import { useNavigate } from "react-router-dom";
import "./Auth.css";

function SignIn() {
  const navigate = useNavigate();

  const handleSignIn = (e) => {
    e.preventDefault();

    // TODO: Add real authentication here

    localStorage.removeItem("foremanDatasetId");
    localStorage.removeItem("foremanDatasetName");

    navigate("/start");
  };

  return (
    <div className="auth-page">

      <div className="foreman-watermark">
        Foreman<span>Knowledge</span>
      </div>

      <div className="auth-card">

        <div className="auth-header">
          <div className="auth-logo">
            FK
          </div>

          <div className="auth-badge">
            Delivery Intelligence Platform
          </div>

          <h1 className="auth-title">
            Welcome back
          </h1>

          <p className="auth-subtitle">
            Sign in to continue to your Foreman knowledge workspace.
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
          Foreman Knowledge API · v1.0
        </div>

      </div>
    </div>
  );
}

export default SignIn;
