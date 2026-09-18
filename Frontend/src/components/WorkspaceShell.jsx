import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { getHealth } from "../services/api";
import ForemanIcon from "./ForemanIcon";
import "./WorkspaceShell.css";

const NAV = [
  { to: "/start", icon: "home", label: "Overview", description: "Delivery command center" },
  { to: "/upload", icon: "database", label: "Knowledge base", description: "Your source of truth" },
  { to: "/canvas", icon: "network", label: "Delivery Canvas", description: "See connected work" },
  { to: "/sad", icon: "file", label: "S-AD intake", description: "Turn architecture into work" },
  { to: "/playground", icon: "layers", label: "Planning studio", description: "Review & publish safely" },
  { to: "/capacity", icon: "calendar", label: "Capacity Studio", description: "Availability & scenarios", isNew: true },
  { to: "/estimation", icon: "gauge", label: "Estimation", description: "Size the backlog" },
  { to: "/report", icon: "chart", label: "Forecast", description: "Delivery outlook" },
];
const canNavigate = () => window.dispatchEvent(new Event("foreman:before-navigate", { cancelable: true }));
const PAGE = {
  "/start": ["Overview", "Your intelligent delivery workspace"],
  "/upload": ["Knowledge base", "Connect and manage delivery knowledge"],
  "/canvas": ["Delivery Canvas", "Explore your backlog and architecture"],
  "/sad": ["S-AD intake", "Generate traceable work and review overlaps"],
  "/playground": ["Planning studio", "Human-owned changes and safe review"],
  "/capacity": ["Capacity Studio", "People, availability and what-if planning"],
  "/estimation": ["Estimation", "Collaborative team ticket estimation"],
  "/report": ["Forecast", "Capacity, velocity and delivery outlook"],
};

export default function WorkspaceShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("foremanSidebarCollapsed") === "true");
  const [health, setHealth] = useState("checking");
  const [datasetName, setDatasetName] = useState(() => localStorage.getItem("foremanDatasetName") || "No dataset connected");

  useEffect(() => {
    const toggle = () => setCollapsed(previous => {
      const next = !previous;
      localStorage.setItem("foremanSidebarCollapsed", String(next));
      return next;
    });
    window.addEventListener("foreman:toggle-sidebar", toggle);
    return () => window.removeEventListener("foreman:toggle-sidebar", toggle);
  }, []);
  useEffect(() => {
    let active = true;
    setHealth("checking");
    getHealth().then(() => { if (active) setHealth("connected"); }).catch(() => { if (active) setHealth("offline"); });
    return () => { active = false; };
  }, [location.pathname]);
  useEffect(() => {
    setMobileOpen(false);
    setDatasetName(localStorage.getItem("foremanDatasetName") || "No dataset connected");
  }, [location.pathname]);

  const [title, subtitle] = PAGE[location.pathname] || PAGE["/start"];
  const toggleCollapsed = () => setCollapsed(previous => {
    const next = !previous;
    localStorage.setItem("foremanSidebarCollapsed", String(next));
    return next;
  });

  return <div className={`fm-app-shell ${collapsed ? "fm-sidebar-collapsed" : ""}`}>
    {mobileOpen && <button className="fm-mobile-scrim" type="button" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
    <aside className={`fm-app-sidebar ${mobileOpen ? "is-open" : ""}`} aria-label="Workspace navigation">
      <button className="fm-brand" type="button" onClick={() => { if (canNavigate()) navigate("/start"); }} title="Gogo home">
        <span className="fm-brand-mark" aria-hidden="true"><img src="/gogo-logo.svg" alt="" /></span>
        <span className="fm-brand-text"><strong>GOGO</strong><small>Scrum Master</small></span>
      </button>
      <div className="fm-nav-caption">YOUR WORKSPACE</div>
      <nav className="fm-app-nav">
        {NAV.map(item => <NavLink key={item.to} to={item.to} title={item.label} onClick={event => { if (!canNavigate()) event.preventDefault(); }} className={({ isActive }) => `fm-nav-item ${isActive ? "is-active" : ""}`}>
          <span className="fm-nav-icon"><ForemanIcon name={item.icon} size={18} /></span>
          <span className="fm-nav-copy"><strong>{item.label}</strong><small>{item.description}</small></span>
          {item.isNew && <span className="fm-nav-new">NEW</span>}
        </NavLink>)}
      </nav>
      <div className="fm-sidebar-bottom">
        <span className="fm-nav-caption">CONNECTED KNOWLEDGE</span>
        <button type="button" className="fm-dataset-tile" onClick={() => { if (canNavigate()) navigate("/upload"); }} title={datasetName}>
          <ForemanIcon name="database" size={17}/><span>{datasetName}</span><ForemanIcon name="arrowUpRight" size={14}/>
        </button>
        <span className="fm-trust-note"><ForemanIcon name="shield" size={13}/> Human-owned decisions</span>
      </div>
      <button className="fm-sidebar-collapse" type="button" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={toggleCollapsed}>
        <ForemanIcon name={collapsed ? "chevronRight" : "chevronLeft"} size={15}/><span>{collapsed ? "Expand" : "Collapse"}</span>
      </button>
    </aside>
    <div className="fm-main-shell">
      <header className="fm-global-header">
        <button className="fm-menu-toggle" type="button" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><ForemanIcon name="menu" size={20}/></button>
        <div className="fm-global-heading"><span className="fm-breadcrumb">WORKSPACE <ForemanIcon name="chevronRight" size={12}/> {title.toUpperCase()}</span><h1>{title}</h1><p>{subtitle}</p></div>
        <div className="fm-global-actions"><span className={`fm-api-status ${health}`} title={`API ${health}`}><i/>{health === "connected" ? "Systems online" : health === "offline" ? "API unavailable" : "Connecting"}</span><button type="button" onClick={() => { if (canNavigate()) navigate("/upload"); }}><ForemanIcon name="plus" size={15}/> Connect data</button></div>
      </header>
      <main className="fm-workspace-content"><Outlet/></main>
    </div>
  </div>;
}
