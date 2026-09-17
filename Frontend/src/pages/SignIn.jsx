import { useNavigate } from "react-router-dom";
import "./Auth.css";

function SignIn() {
  const navigate = useNavigate();

  const handleSignIn = (e) => {
    e.preventDefault();

    // TODO: Add real authentication here

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
            Explore Foreman using the synthetic hackathon dataset. This demo does not authenticate users.
          </p>
        </div>

        <form className="auth-form" onSubmit={handleSignIn}>
          <button className="auth-button" type="submit">Open demo workspace</button>
        </form>

        <div className="auth-footer">
          Foreman Knowledge API · v1.0
        </div>

      </div>
    </div>
  );
}

export default SignIn;
