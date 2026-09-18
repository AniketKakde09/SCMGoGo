import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { getHealth } from "../services/api";
import "./WorkspaceShell.css";

const NAV = [
  { to: "/start", icon: "⌂", label: "Overview", description: "Workspace home" },
  { to: "/upload", icon: "▤", label: "Knowledge base", description: "Upload & connect" },
  { to: "/canvas", icon: "◇", label: "Delivery Canvas", description: "Explore work" },
  { to: "/sad", icon: "▤", label: "Add SAD", description: "Generate architecture backlog" },
  { to: "/playground", icon: "▧", label: "Planning studio", description: "Review & publish" },
  { to: "/capacity", icon: "▦", label: "Capacity Studio", description: "People & what-if planning" },
  { to: "/report", icon: "▥", label: "Forecast", description: "Capacity & delivery" },
];
const PAGE = {
  "/start": ["Overview", "Your delivery intelligence workspace"],
  "/upload": ["Knowledge base", "Connect the synthetic delivery dataset"],
  "/canvas": ["Delivery Canvas", "Explore your backlog and architecture"],
  "/sad": ["Add SAD", "Generate traceable work and review overlaps"],
  "/playground": ["Planning studio", "Human-owned changes and review"],
  "/capacity": ["Capacity Studio", "Team availability and safe planning scenarios"],
  "/report": ["Forecast", "Capacity, velocity and delivery outlook"],
};

export default function WorkspaceShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("foremanSidebarCollapsed") === "true");
  useEffect(() => {
    const toggle = () => setCollapsed(value => { const next = !value; localStorage.setItem("foremanSidebarCollapsed", String(next)); return next; });
    window.addEventListener("foreman:toggle-sidebar", toggle);
    return () => window.removeEventListener("foreman:toggle-sidebar", toggle);
  }, []);
  const [health, setHealth] = useState("checking");
  const [datasetName, setDatasetName] = useState(() => localStorage.getItem("foremanDatasetName") || "No dataset selected");
  useEffect(() => {
    let mounted = true;
    getHealth().then(() => { if (mounted) setHealth("connected"); }).catch(() => { if (mounted) setHealth("offline"); });
    return () => { mounted = false; };
  }, [location.pathname]);
  useEffect(() => {
    setOpen(false);
    setDatasetName(localStorage.getItem("foremanDatasetName") || "No dataset selected");
  }, [location.pathname]);
  const [title, subtitle] = PAGE[location.pathname] || PAGE["/start"];
  return (
    <div className={`fm-app-shell ${collapsed ? "fm-sidebar-collapsed" : ""}`}>
      {open && <button className="fm-mobile-scrim" aria-label="Close navigation" onClick={() => setOpen(false)} />}
      <aside className={`fm-app-sidebar ${open ? "is-open" : ""}`} aria-label="Workspace navigation">
        <button className="fm-brand" type="button" onClick={() => navigate("/start")} title="Foreman home">
          <span className="fm-brand-mark">GOGO<span></span></span>
          <span><strong></strong><small>SCRUM MASTER</small></span>
        </button>
        <button className="fm-sidebar-collapse" type="button" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={() => { setCollapsed(value => { const next = !value; localStorage.setItem("foremanSidebarCollapsed", String(next)); return next; }); }}>
          {collapsed ? "»" : "«"}<span>{collapsed ? "" : " Collapse navigation"}</span>
        </button>
        <div className="fm-nav-caption">WORKSPACE</div>
        <nav className="fm-app-nav">
          {NAV.map((item) => <NavLink key={item.to} to={item.to} title={item.label} className={({ isActive }) => `fm-nav-item ${isActive ? "is-active" : ""}`}>
            <span className="fm-nav-icon" aria-hidden="true">{item.icon}</span>
            <span className="fm-nav-copy"><strong>{item.label}</strong><small>{item.description}</small></span>
            <span className="fm-nav-chevron" aria-hidden="true">›</span>
          </NavLink>)}
        </nav>
        <div className="fm-sidebar-bottom">
          <span className="fm-nav-caption">ACTIVE KNOWLEDGE</span>
          <button type="button" className="fm-dataset-tile" onClick={() => navigate("/upload")} title={datasetName}>
            <span aria-hidden="true">▤</span><span>{datasetName}</span>
          </button>
          <small>Planning workspace · Synthetic data only</small>
        </div>
      </aside>
      <div className="fm-main-shell">
        <header className="fm-global-header">
          <button className="fm-menu-toggle" type="button" aria-label="Open navigation" onClick={() => setOpen(true)}>☰</button>
          <div className="fm-global-heading"><span className="fm-breadcrumb">WORKSPACE&nbsp; / &nbsp;{title.toUpperCase()}</span><h1>{title}</h1><p>{subtitle}</p></div>
          <div className="fm-global-actions"><span className={`fm-api-status ${health}`}><i />API {health === "connected" ? "connected" : health === "offline" ? "unavailable" : "checking"}</span><button type="button" onClick={() => navigate("/upload")}>+ Connect data</button></div>
        </header>
        <main className="fm-workspace-content"><Outlet /></main>
      </div>
    </div>
  );
}
