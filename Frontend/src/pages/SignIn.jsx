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
        GOGO<span>Scrum Master</span>
      </div>

      <div className="auth-card">

        <div className="auth-header">
          <div className="auth-logo auth-logo-image">
            <img src="/gogo-logo.svg" alt="Scrum Master GOGO" />
          </div>

          <div className="auth-badge">
            Delivery Intelligence Platform
          </div>

          <h1 className="auth-title">
            Welcome back
          </h1>

          <p className="auth-subtitle">
            Explore GOGO using the synthetic dataset. This demo does not authenticate users.
          </p>
        </div>

        <form className="auth-form" onSubmit={handleSignIn}>
          <button className="auth-button" type="submit">Open demo workspace</button>
        </form>

        <div className="auth-footer">
          Scrum Master GOGO · Delivery Intelligence
        </div>

      </div>
    </div>
  );
}

export default SignIn;
