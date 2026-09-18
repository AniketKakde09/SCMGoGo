import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import ForemanIcon from "../components/ForemanIcon";
import {
  createCapacityScenario, getCapacityMembers, getCapacityScenarios,
  saveCapacityMember, updateCapacityScenario,
} from "../services/capacityStudioApi";
import {
  capacityTotals, grossHours, hydrateMember, leaveKey, loadLocalLeaves, numeric,
  plannedHours, scenarioHours, shortDay, slugId, sprintDays, sprintTemplate,
  storeLocalLeaves,
} from "../utils/capacityModel";
import "./CapacityStudio.css";

const clone = value => JSON.parse(JSON.stringify(value));
const fmt = (value, places = 1) => Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: places });
const displayError = error => error instanceof Error ? error.message : String(error);

function makeMember(teamId, reference) {
  const source = reference?.sprints || [];
  const templates = [0, 1].map(i => {
    const s = source[i];
    return s ? { ...s, leave_days: 0, leave_dates: [], support_hours: 0, planned_points: null, working_days: sprintDays(s.start, s.end).length }
      : sprintTemplate(i, i === 1 ? source[0] : null);
  });
  return { member_id: "", display_name: "", team_id: teamId || "", sprints: templates };
}
function editMember(member) {
  const sprints = clone(member.sprints || []);
  if (sprints.length === 1) {
    const next = sprintTemplate(1, sprints[0]);
    next.sprint_id = sprints[0].sprint_id === "sprint-2" ? "sprint-3" : `${sprints[0].sprint_id}-next`;
    sprints.push(next);
  }
  return { ...clone(member), sprints };
}

function Metric({ icon, label, value, unit, hint, tone = "blue" }) {
  return <article className={`cs-metric cs-metric-${tone}`}>
    <div className="cs-metric-title"><span className="cs-metric-icon"><ForemanIcon name={icon} size={17}/></span><span>{label}</span></div>
    <div className="cs-metric-value">{value}<small>{unit}</small></div>
    <p>{hint}</p>
  </article>;
}

export default function CapacityStudio() {
  const navigate = useNavigate();
  const datasetId = localStorage.getItem("foremanDatasetId") || "";
  const [members, setMembers] = useState([]);
  const [scenarios, setScenarios] = useState([]);
  const [loading, setLoading] = useState(Boolean(datasetId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [team, setTeam] = useState("");
  const [sprintIndex, setSprintIndex] = useState(0);
  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState(null);
  const [editingId, setEditingId] = useState("");
  const [dirty, setDirty] = useState(false);
  const [selectedDate, setSelectedDate] = useState("");
  const [panel, setPanel] = useState("member");
  const [mobilePanel, setMobilePanel] = useState("map");
  const [scenarioId, setScenarioId] = useState("");
  const [scenarioName, setScenarioName] = useState("New what-if scenario");
  const [scenarioNotes, setScenarioNotes] = useState("");
  const [adjustments, setAdjustments] = useState({});
  const [scenarioDirty, setScenarioDirty] = useState(false);

  const refresh = useCallback(async (leaveMap = loadLocalLeaves(datasetId)) => {
    const [peopleResponse, scenarioResponse] = await Promise.all([
      getCapacityMembers(datasetId), getCapacityScenarios(datasetId),
    ]);
    setMembers((peopleResponse.members || []).map(person => hydrateMember(person, leaveMap)));
    setScenarios(scenarioResponse.scenarios || []);
  }, [datasetId]);

  useEffect(() => {
    if (!datasetId) return;
    let live = true;
    Promise.all([getCapacityMembers(datasetId), getCapacityScenarios(datasetId)])
      .then(([peopleResponse, scenarioResponse]) => {
        if (!live) return;
        const localLeaves = loadLocalLeaves(datasetId);
        setMembers((peopleResponse.members || []).map(person => hydrateMember(person, localLeaves)));
        setScenarios(scenarioResponse.scenarios || []);
      })
      .catch(e => { if (live) setError(displayError(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [datasetId]);
  useEffect(() => {
    if (!dirty && !scenarioDirty) return undefined;
    const warn = event => { event.preventDefault(); event.returnValue = ""; };
    const routeWarn = event => {
      if (!window.confirm("Your capacity or what-if changes are not saved. Leave this screen?")) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    window.addEventListener("foreman:before-navigate", routeWarn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      window.removeEventListener("foreman:before-navigate", routeWarn);
    };
  }, [dirty, scenarioDirty]);

  const teams = useMemo(() => [...new Set(members.map(m => m.team_id))].sort(), [members]);
  const activeTeam = team || teams[0] || "";
  const people = useMemo(() => members.filter(m => m.team_id === activeTeam), [members, activeTeam]);
  const visiblePeople = useMemo(() => people.filter(m => m.display_name.toLowerCase().includes(filter.toLowerCase())), [people, filter]);
  const reference = people.find(m => m.sprints?.[sprintIndex])?.sprints[sprintIndex] || sprintTemplate(sprintIndex);
  const dates = useMemo(() => sprintDays(reference.start, reference.end), [reference.start, reference.end]);
  const totals = useMemo(() => capacityTotals(people, sprintIndex), [people, sprintIndex]);
  const scenarioTotal = useMemo(() => scenarioHours(people, sprintIndex, adjustments), [people, sprintIndex, adjustments]);
  const current = draft?.sprints?.[sprintIndex] || null;
  const editDates = current ? sprintDays(current.start, current.end) : [];
  const knownLeave = current?.leave_dates?.length || 0;
  const unlocatedLeave = Math.max(0, Number(current?.leave_days || 0) - knownLeave);
  const hasScenario = Boolean(scenarioId || Object.keys(adjustments).length);
  const mixedCalendars = people.some(m => {
    const s = m.sprints?.[sprintIndex];
    return s && (s.start !== reference.start || s.end !== reference.end || s.sprint_id !== reference.sprint_id);
  });
  const scenarioDelta = scenarioTotal - totals.hours;

  const confirmDiscard = () => !dirty || window.confirm("You have unsaved capacity edits. Discard them?");
  const confirmScenarioDiscard = () => !scenarioDirty || window.confirm("Discard unsaved what-if changes?");
  const selectMember = (member, day = "") => {
    if (editingId === member.member_id && draft) {
      setSelectedDate(day);
      setPanel("member");
      setMobilePanel("editor");
      return;
    }
    if (!confirmDiscard()) return;
    setDraft(editMember(member));
    setEditingId(member.member_id);
    setDirty(false);
    setSelectedDate(day);
    setPanel("member");
    setMobilePanel("editor");
    setError("");
  };
  const addMember = () => {
    if (!confirmDiscard()) return;
    setDraft(makeMember(activeTeam, people[0]));
    setEditingId("");
    setDirty(false);
    setSelectedDate("");
    setPanel("member");
    setMobilePanel("editor");
    setError("");
  };
  const updateMember = changes => { setDraft(previous => ({ ...previous, ...changes })); setDirty(true); };
  const updateSprint = (field, value) => {
    setDraft(previous => ({ ...previous, sprints: previous.sprints.map((s, index) =>
      index === sprintIndex ? { ...s, [field]: value } : s), }));
    setDirty(true);
  };
  const changeDate = (field, value) => {
    setDraft(previous => ({ ...previous, sprints: previous.sprints.map((s, index) => {
      if (index !== sprintIndex) return s;
      const next = { ...s, [field]: value };
      const days = sprintDays(next.start, next.end);
      next.working_days = days.length;
      next.leave_dates = (s.leave_dates || []).filter(day => days.includes(day));
      if (s.leave_dates?.length) next.leave_days = next.leave_dates.length;
      return next;
    }) }));
    setDirty(true);
  };
  const toggleLeave = day => {
    if (!current || !editDates.includes(day)) return;
    if (unlocatedLeave > 0 && !window.confirm(`This submission has ${fmt(current.leave_days)} leave day(s) without saved dates. Selecting specific dates will replace that total. Continue?`)) return;
    const next = (current.leave_dates || []).includes(day)
      ? current.leave_dates.filter(item => item !== day)
      : [...(current.leave_dates || []), day].sort();
    setDraft(previous => ({ ...previous, sprints: previous.sprints.map((s, i) => i === sprintIndex
      ? { ...s, leave_dates: next, leave_days: next.length } : s) }));
    setSelectedDate(day);
    setDirty(true);
  };
  const copyWorkSettings = () => {
    if (!draft || sprintIndex !== 1 || !draft.sprints[0]) return;
    const source = draft.sprints[0];
    setDraft(previous => ({ ...previous, sprints: previous.sprints.map((s, i) => i === 1 ? {
      ...s, hours_per_day: source.hours_per_day, focus_percent: source.focus_percent,
      support_hours: source.support_hours,
    } : s) }));
    setDirty(true);
    setNotice("Copied work settings only. Sprint dates, leave and planning points are unchanged.");
  };
  const resetLeave = () => {
    if (!current || (!current.leave_days && !current.leave_dates?.length)) return;
    if (!window.confirm("Remove all planned leave for this sprint from your unsaved draft?")) return;
    setDraft(previous => ({ ...previous, sprints: previous.sprints.map((s, i) => i === sprintIndex
      ? { ...s, leave_days: 0, leave_dates: [] } : s) }));
    setDirty(true);
  };
  const saveMember = async event => {
    event.preventDefault();
    setError(""); setNotice("");
    if (!draft || busy) return;
    const name = draft.display_name.trim();
    const teamId = draft.team_id.trim();
    const memberId = editingId || draft.member_id.trim() || slugId(name);
    if (!name || !teamId || !memberId) { setError("Enter a member name, member ID and team ID."); return; }
    if (!editingId && members.some(m => m.member_id.toLowerCase() === memberId.toLowerCase())) {
      setError("That member ID already exists. Choose another ID or edit the existing member."); return;
    }
    const sprints = draft.sprints.map(s => {
      const validDays = sprintDays(s.start, s.end);
      const leave_dates = [...new Set(s.leave_dates || [])].filter(day => validDays.includes(day)).sort();
      const leave_days = leave_dates.length ? leave_dates.length : Number(s.leave_days);
      return { ...s, sprint_id: s.sprint_id.trim(), sprint_name: s.sprint_name.trim(), working_days: validDays.length,
        leave_days, leave_dates, planned_points: s.planned_points === "" ? null : s.planned_points };
    });
    if (sprints.some(s => !s.sprint_id || !s.sprint_name || !s.working_days || s.start > s.end)) {
      setError("Check sprint names, IDs and dates. Sprint length must be 31 calendar days or less, with working days."); return;
    }
    if (new Set(sprints.map(s => s.sprint_id)).size !== sprints.length) { setError("Each sprint needs a different ID."); return; }
    if (sprints.some(s => !Number.isFinite(s.leave_days) || s.leave_days < 0 || s.leave_days > s.working_days || s.hours_per_day <= 0 || s.hours_per_day > 24 || s.focus_percent < 0 || s.focus_percent > 100 || s.support_hours < 0 || s.support_hours > 744 || (s.planned_points !== null && (s.planned_points < 0 || s.planned_points > 10000)))) {
      setError("Check leave, hours, focus percentage, support time and optional points for BOTH sprints."); return;
    }
    if (sprints.some(s => s.support_hours > (s.working_days - s.leave_days) * s.hours_per_day * s.focus_percent / 100)) {
      setError("Support time cannot exceed remaining focus hours. Please review both sprints."); return;
    }
    setBusy(true);
    try {
      // Pydantic SprintAvailability does not support leave_dates: retain exact dates locally, never claim server sync.
      const serverSprints = sprints.map(s => ({
        sprint_id: s.sprint_id, sprint_name: s.sprint_name, start: s.start, end: s.end,
        working_days: s.working_days, leave_days: s.leave_days, hours_per_day: s.hours_per_day,
        focus_percent: s.focus_percent, support_hours: s.support_hours, planned_points: s.planned_points,
      }));
      const saved = await saveCapacityMember(datasetId, { member_id: memberId, display_name: name, team_id: teamId, sprints: serverSprints });
      const leaves = loadLocalLeaves(datasetId);
      sprints.forEach(s => {
        const key = leaveKey(memberId, s.sprint_id);
        if (s.leave_dates.length) leaves[key] = s.leave_dates;
        else delete leaves[key];
      });
      try { storeLocalLeaves(datasetId, leaves); }
      catch { setNotice("Capacity saved, but this browser could not retain exact leave dates."); }
      await refresh(leaves);
      setDraft(editMember(hydrateMember(saved, leaves)));
      setEditingId(memberId);
      setTeam(teamId);
      setDirty(false);
      setNotice(previous => previous || "Capacity saved for both sprints. Exact leave dates stay in this browser; leave totals are saved on the server.");
    } catch (e) { setError(displayError(e)); }
    finally { setBusy(false); }
  };
  const chooseTeam = value => {
    if (!confirmDiscard() || !confirmScenarioDiscard()) return;
    setTeam(value); setDraft(null); setEditingId(""); setDirty(false); setFilter("");
    setScenarioId(""); setScenarioName("New what-if scenario"); setScenarioNotes(""); setAdjustments({}); setScenarioDirty(false);
    setMobilePanel("map");
  };
  const chooseScenario = id => {
    if (!confirmScenarioDiscard()) return;
    const scenario = scenarios.find(s => s.scenario_id === id);
    setScenarioId(id);
    setScenarioName(scenario?.name || "New what-if scenario");
    setScenarioNotes(scenario?.notes || "");
    setAdjustments(clone(scenario?.adjustments || {}));
    setScenarioDirty(false);
    setPanel("scenario");
  };
  const updateAdjustment = (member, sprint, value) => {
    const key = `${member.member_id}:${sprint.sprint_id}:hours`;
    setAdjustments(previous => {
      const next = { ...previous };
      if (value === "" || Number(value) === 0) delete next[key];
      else next[key] = Number(value);
      return next;
    });
    setScenarioDirty(true);
  };
  const saveScenario = async () => {
    setError(""); setNotice("");
    if (busy) return;
    if (!activeTeam || !scenarioName.trim() || !people.length) { setError("Select a team with submitted members and enter a scenario name."); return; }
    const validKeys = new Set(people.flatMap(m => m.sprints.map(s => `${m.member_id}:${s.sprint_id}:hours`)));
    const clean = {};
    for (const [key, value] of Object.entries(adjustments)) {
      if (!validKeys.has(key)) continue;
      if (!Number.isFinite(Number(value)) || Math.abs(Number(value)) > 10000) { setError("Scenario adjustments must be finite numbers within ±10,000 hours."); return; }
      if (Number(value)) clean[key] = Number(value);
    }
    if (people.some(m => m.sprints.some(s => plannedHours(s) + numeric(clean[`${m.member_id}:${s.sprint_id}:hours`]) < 0))) {
      setError("A scenario cannot reduce an individual's planned work capacity below zero."); return;
    }
    const sprintIds = [...new Set(people.flatMap(m => m.sprints.map(s => s.sprint_id)))];
    if (sprintIds.length > 2) { setError("Team members have different sprint IDs. Align IDs across the team before creating a two-sprint scenario."); return; }
    const payload = { name: scenarioName.trim(), team_id: activeTeam, sprint_ids: sprintIds,
      notes: scenarioNotes, adjustments: clean };
    setBusy(true);
    try {
      const saved = scenarioId ? await updateCapacityScenario(datasetId, scenarioId, payload) : await createCapacityScenario(datasetId, payload);
      await refresh();
      setScenarioId(saved.scenario_id);
      setScenarioDirty(false);
      setNotice("Draft scenario saved. Member submissions, Jira and approved sprints are unchanged.");
    } catch (e) { setError(displayError(e)); }
    finally { setBusy(false); }
  };
  const refreshScreen = async () => {
    if (!confirmDiscard() || !confirmScenarioDiscard()) return;
    setLoading(true); setError(""); setDraft(null); setEditingId(""); setDirty(false); setScenarioDirty(false);
    try { await refresh(); setNotice("Capacity and scenarios refreshed from the server."); }
    catch (e) { setError(displayError(e)); }
    finally { setLoading(false); }
  };

  if (!datasetId) return <section className="cs-connect"><div className="cs-connect-icon"><ForemanIcon name="database" size={27}/></div><span className="cs-eyebrow">CAPACITY STUDIO</span><h2>Start with your knowledge base</h2><p>Capacity and what-if scenarios are attached to a dataset. Connect one to begin planning.</p><button type="button" className="cs-primary" onClick={() => navigate("/upload")}>Connect a dataset <ForemanIcon name="arrowUpRight" size={17}/></button></section>;

  return <div className="cs-studio">
    <header className="cs-hero"><div className="cs-hero-copy"><span className="cs-eyebrow"><ForemanIcon name="sparkle" size={13}/> PEOPLE INTELLIGENCE / LIVE WORKSPACE</span><h2>Capacity, without the guesswork<span>.</span></h2><p>Shape two sprints around real availability. Explore alternatives without touching the approved plan.</p></div><div className="cs-hero-actions"><span className="cs-safe-pill"><ForemanIcon name="shield" size={14}/> Draft-only scenarios</span><button type="button" className="cs-primary" onClick={addMember}><ForemanIcon name="plus" size={17}/> Add member</button></div><div className="cs-hero-art" aria-hidden="true"><span/><span/><span/><span/><span/><span/><span/><span/><span/></div></header>
    {(error || notice) && <div className={`cs-message ${error ? "cs-error" : "cs-success"}`} role={error ? "alert" : "status"}><ForemanIcon name={error ? "warning" : "check"} size={16}/><span>{error || notice}</span><button type="button" onClick={() => { setError(""); setNotice(""); }} aria-label="Dismiss notification"><ForemanIcon name="close" size={16}/></button></div>}
    <div className="cs-toolbar"><div className="cs-segment" role="group" aria-label="Sprint selection">{[0,1].map(i => <button key={i} type="button" className={sprintIndex === i ? "active" : ""} onClick={() => { setSprintIndex(i); setSelectedDate(""); }}><span className="cs-sprint-number">0{i+1}</span> Sprint {i+1}</button>)}</div><label className="cs-team-picker"><span>TEAM</span><select value={activeTeam} onChange={event => chooseTeam(event.target.value)}><option value="">{teams.length ? "Select a team" : "No teams added"}</option>{teams.map(t => <option key={t} value={t}>{t}</option>)}</select><ForemanIcon name="chevronDown" size={14}/></label><label className="cs-search"><ForemanIcon name="search" size={16}/><input aria-label="Search team members" placeholder="Search team members" value={filter} onChange={event => setFilter(event.target.value)}/></label><button className="cs-icon-button" type="button" title="Refresh capacity" aria-label="Refresh capacity" disabled={loading || busy} onClick={refreshScreen}><ForemanIcon name="refresh" size={17}/></button></div>
    <div className="cs-metrics"><Metric icon="clock" label="Saved focus capacity" value={fmt(totals.hours)} unit="hours" hint="After leave, focus & support"/><Metric icon="chart" label="Reported planning points" value={totals.pointEntries ? fmt(totals.points) : "—"} unit={totals.pointEntries ? "pts" : ""} hint={`${totals.pointEntries}/${totals.submissions} members entered points · separate from hours`} tone="violet"/><Metric icon="users" label="Team submissions" value={fmt(totals.submissions,0)} unit="members" hint={`${fmt(totals.leaveDays)} total leave days reported`} tone="mint"/><Metric icon="sliders" label="Scenario preview" value={fmt(hasScenario ? scenarioTotal : totals.hours)} unit="hours" hint={hasScenario ? `${scenarioDelta >= 0 ? "+" : ""}${fmt(scenarioDelta)} h vs saved baseline` : "Select or create a what-if plan"} tone="amber"/></div>
    <div className="cs-mobile-view" role="group" aria-label="Capacity view"><button type="button" className={mobilePanel === "map" ? "active" : ""} onClick={() => setMobilePanel("map")}><ForemanIcon name="calendar" size={15}/> Availability map</button><button type="button" className={mobilePanel === "editor" ? "active" : ""} onClick={() => setMobilePanel("editor")}><ForemanIcon name="edit" size={15}/> Editor & scenarios</button></div>
    <div className={`cs-body cs-mobile-${mobilePanel}`}>
      <section className="cs-panel cs-map"><div className="cs-panel-heading"><div><span className="cs-eyebrow">TEAM × WORKING DAYS</span><h3>Availability map</h3><p>Choose a square to review or change that person's day.</p></div><span className="cs-date-range"><ForemanIcon name="calendar" size={14}/>{reference.start} – {reference.end}</span></div>
        <div className="cs-map-scroll"><div className="cs-map-grid" style={{ "--cs-days": Math.max(1, dates.length) }}><div className="cs-map-sticky cs-col-heading">TEAM MEMBER</div>{dates.map(day => <div key={day} className="cs-map-sticky cs-day-heading"><strong>{new Date(`${day}T12:00:00`).toLocaleDateString(undefined,{weekday:"short"})}</strong><small>{day.slice(8)}</small></div>)}
          {visiblePeople.map(person => { const m = editingId === person.member_id && draft ? draft : person; const s = m.sprints?.[sprintIndex]; const leave = s?.leave_dates || []; const unknownLeave = s?.leave_days > leave.length; return <div className="cs-map-row" key={person.member_id}><button type="button" className={`cs-person ${editingId === person.member_id ? "selected" : ""}`} title={`Edit ${person.display_name}`} onClick={() => selectMember(person)}><span className="cs-avatar">{person.display_name.trim().split(/\s+/).slice(0,2).map(part => part[0]).join("").toUpperCase()}</span><span className="cs-person-copy"><strong>{person.display_name}</strong><small>{s ? `${fmt(plannedHours(s))} focus h` : "No submission"}</small></span>{editingId === person.member_id && dirty && <span className="cs-unsaved-dot" title="Unsaved edits"/>}</button>{dates.map(day => {const outside = !s || day < s.start || day > s.end; const marked = leave.includes(day); const kind = outside ? "unknown" : marked ? "leave" : unknownLeave ? "partial" : "available"; const label = `${person.display_name} · ${day} · ${outside ? "No submission" : marked ? "Leave" : unknownLeave ? "Some leave dates not entered" : "Estimated available"}`;return <button type="button" key={day} className={`cs-day-cell ${kind} ${editingId === person.member_id && selectedDate === day ? "selected" : ""}`} aria-label={label} title={label} onClick={() => selectMember(person, day)}><span className="cs-cell-dot"/></button>;})}</div>; })}
        </div></div>
        {loading ? <div className="cs-map-empty"><ForemanIcon name="refresh" size={22}/> Loading capacity…</div> : !visiblePeople.length ? <div className="cs-map-empty"><ForemanIcon name="users" size={24}/><strong>{people.length ? "No matching members" : "Build your team's first capacity map"}</strong><span>{people.length ? "Try a different search." : "Add a member, set their sprint availability and save."}</span><button type="button" className="cs-secondary" onClick={addMember}>Add member <ForemanIcon name="plus" size={14}/></button></div> : null}
        <footer className="cs-map-footer">{mixedCalendars && <p className="cs-map-warning"><ForemanIcon name="warning" size={13}/> Team members use different sprint IDs or date ranges; review alignment before comparing totals or saving scenarios.</p>}<div className="cs-legend"><span><i className="available"/> Available estimate</span><span><i className="leave"/> Leave</span><span><i className="partial"/> Dates missing</span><span><i className="unknown"/> Not submitted</span></div><p>Day colors show availability estimates, not verified timesheets. Exact dates remain in this browser; leave totals are stored on the server.</p></footer>
      </section>
      <aside className="cs-panel cs-side"><div className="cs-panel-tabs" role="group" aria-label="Capacity editor mode"><button type="button" className={panel === "member" ? "active" : ""} onClick={() => setPanel("member")}><ForemanIcon name="users" size={16}/> Member</button><button type="button" className={panel === "scenario" ? "active" : ""} onClick={() => setPanel("scenario")}><ForemanIcon name="sliders" size={16}/> What-if lab</button></div>
      {panel === "member" ? !draft ? <div className="cs-side-empty"><div className="cs-side-empty-art"><ForemanIcon name="users" size={27}/></div><h3>Put people at the center.</h3><p>Select a teammate from the heatmap to edit their capacity, or add someone new.</p><button type="button" className="cs-primary" onClick={addMember}><ForemanIcon name="plus" size={15}/> Add member</button></div> :
        <form className="cs-editor" onSubmit={saveMember}>
          <div className="cs-editor-heading"><div><span className="cs-eyebrow">MEMBER AVAILABILITY</span><h3>{editingId ? `Edit ${draft.display_name}` : "Add a teammate"}</h3></div><span className={`cs-editor-state ${dirty ? "pending" : "saved"}`}>{dirty ? "Unsaved edits" : editingId ? "Saved" : "New"}</span></div>
          <div className="cs-form-grid"><label>Member name<input required maxLength={150} placeholder="e.g. Alex Morgan" value={draft.display_name} onChange={e => updateMember({display_name:e.target.value})}/></label><label>Team ID<input required maxLength={120} placeholder="e.g. platform" value={draft.team_id} onChange={e => updateMember({team_id:e.target.value})}/></label></div>
          {!editingId && <label className="cs-field">Member ID <small>Optional · generated from name if blank</small><input maxLength={120} placeholder={slugId(draft.display_name) || "alex-morgan"} value={draft.member_id} onChange={e => updateMember({member_id:e.target.value})}/></label>}
          <div className="cs-divider"/><div className="cs-editor-sprint"><div><span className="cs-eyebrow">SPRINT CONFIGURATION</span><strong>Sprint {sprintIndex+1}</strong></div>{sprintIndex === 1 ? <button type="button" className="cs-text-button" onClick={copyWorkSettings}><ForemanIcon name="copy" size={13}/> Copy Sprint 1 work settings</button> : <small>Both sprints save together</small>}</div>
          <div className="cs-form-grid"><label>Sprint name<input required maxLength={150} value={current?.sprint_name || ""} onChange={e => updateSprint("sprint_name",e.target.value)}/></label><label>Sprint ID<input required maxLength={100} value={current?.sprint_id || ""} onChange={e => updateSprint("sprint_id",e.target.value)}/></label><label>Start date<input required type="date" value={current?.start || ""} onChange={e => changeDate("start",e.target.value)}/></label><label>End date<input required type="date" value={current?.end || ""} onChange={e => changeDate("end",e.target.value)}/></label></div>
          <div className="cs-capacity-knobs"><div className="cs-knob-heading"><ForemanIcon name="clock" size={16}/><strong>Time & availability</strong><span>{editDates.length} weekdays</span></div><div className="cs-form-grid"><label>Hours / workday<input type="number" required min="0.5" max="24" step="0.5" value={current?.hours_per_day ?? 8} onChange={e => updateSprint("hours_per_day",numeric(e.target.value))}/></label><label>Support / on-call hours<input type="number" required min="0" max="744" step="0.5" value={current?.support_hours ?? 0} onChange={e => updateSprint("support_hours",numeric(e.target.value))}/></label></div><label className="cs-focus-label"><span>Focus time <strong>{current?.focus_percent ?? 70}%</strong></span><input type="range" min="0" max="100" step="5" value={current?.focus_percent ?? 70} onChange={e => updateSprint("focus_percent",Number(e.target.value))}/><small>Time available for planned delivery work, after recurring interruptions.</small></label></div>
          <div className="cs-leave-heading"><div><ForemanIcon name="calendar" size={16}/><strong>Leave & availability</strong></div><span>{fmt(current?.leave_days,0)} day(s)</span></div><div className="cs-date-grid">{editDates.map(day => <button type="button" key={day} className={`${current?.leave_dates?.includes(day) ? "leave" : ""} ${selectedDate === day ? "chosen" : ""}`} aria-pressed={Boolean(current?.leave_dates?.includes(day))} onClick={() => toggleLeave(day)} title={`Toggle leave for ${day}`}><small>{new Date(`${day}T12:00:00`).toLocaleDateString(undefined,{weekday:"short"})}</small><strong>{day.slice(8)}</strong></button>)}</div>
          {!editDates.length && <p className="cs-inline-warning"><ForemanIcon name="warning" size={14}/> Choose a valid sprint date range (31 calendar days max).</p>}
          {unlocatedLeave > 0 && <p className="cs-inline-warning"><ForemanIcon name="info" size={14}/> {fmt(unlocatedLeave)} leave day(s) were saved without dates. Choose dates only if you intend to replace that total.</p>}
          <div className="cs-leave-actions"><button type="button" className="cs-text-button" disabled={!current?.leave_days} onClick={resetLeave}>Clear leave</button><span>Exact leave dates are stored only in this browser.</span></div>
          <div className="cs-divider"/><label className="cs-field">Planned story points <small>Optional · independent of hours</small><input type="number" min="0" max="10000" step="0.5" placeholder="No points estimate" value={current?.planned_points ?? ""} onChange={e => updateSprint("planned_points",e.target.value === "" ? null : numeric(e.target.value))}/></label>
          {current?.planned_points != null && Number(current.planned_points) > 0 && plannedHours(current) === 0 && <p className="cs-inline-warning"><ForemanIcon name="warning" size={14}/> Points are reported but planned-work hours are zero. Check leave, focus and support time.</p>}<div className="cs-preview"><div><span>Estimated planned-work capacity</span><strong>{fmt(plannedHours(current))} <small>hours</small></strong></div><div className="cs-preview-bar"><span style={{width:`${grossHours(current) ? Math.min(100,plannedHours(current)/grossHours(current)*100) : 0}%`}}/></div><p>{fmt(Math.max(0,(current?.working_days||0)-(current?.leave_days||0)))} days × {fmt(current?.hours_per_day)} hours × {fmt(current?.focus_percent,0)}% focus − {fmt(current?.support_hours)} support hours</p></div>
          <button type="submit" className="cs-primary cs-submit" disabled={busy || !dirty && Boolean(editingId)}><ForemanIcon name="check" size={16}/>{busy ? "Saving…" : editingId ? dirty ? "Save both sprints" : "All changes saved" : "Create member & save"}</button><p className="cs-trust-message"><ForemanIcon name="info" size={13}/> Member identity is not authenticated by the current backend. Use with trusted team members only.</p>
        </form> : <div className="cs-editor cs-scenario-editor">
          <div className="cs-editor-heading"><div><span className="cs-eyebrow">SANDBOX / NO LIVE CHANGES</span><h3>What-if lab</h3></div><span className={`cs-editor-state ${scenarioDirty ? "pending" : "saved"}`}>{scenarioDirty ? "Unsaved" : "Draft"}</span></div><p className="cs-scenario-lead">Explore availability changes. Your team’s saved capacity, Jira issues and committed sprints remain unchanged.</p>
          <label className="cs-field">Saved scenario<select value={scenarioId} onChange={e => chooseScenario(e.target.value)}><option value="">+ Create new scenario</option>{scenarios.filter(s => s.team_id === activeTeam).map(s => <option key={s.scenario_id} value={s.scenario_id}>{s.name}</option>)}</select></label>
          <label className="cs-field">Scenario name<input maxLength={150} required value={scenarioName} onChange={e => { setScenarioName(e.target.value); setScenarioDirty(true); }} placeholder="e.g. One person on leave"/></label><label className="cs-field">What changed? <small>Optional context</small><textarea rows={2} maxLength={2000} value={scenarioNotes} onChange={e => { setScenarioNotes(e.target.value); setScenarioDirty(true); }} placeholder="Describe your assumptions…"/></label>
          <div className="cs-scenario-subhead"><strong>Adjust Sprint {sprintIndex+1} capacity</strong><span>± available hours</span></div><div className="cs-adjust-list">{people.map(m => {const s=m.sprints[sprintIndex];if (!s) return null;const key=`${m.member_id}:${s.sprint_id}:hours`; const value=adjustments[key] ?? "";return <label className="cs-adjust" key={key}><span className="cs-avatar">{m.display_name.trim().slice(0,2).toUpperCase()}</span><span className="cs-adjust-person"><strong>{m.display_name}</strong><small>{fmt(plannedHours(s))} h baseline</small></span><input aria-label={`${m.display_name} sprint ${sprintIndex+1} hour adjustment`} type="number" step="0.5" min={-plannedHours(s)} max="10000" placeholder="± 0" value={value} onChange={e => updateAdjustment(m,s,e.target.value)}/></label>;})}{!people.length && <p className="cs-inline-warning">Add members before building scenarios.</p>}</div>
          {Object.keys(adjustments).length > 0 && <button type="button" className="cs-text-button cs-reset-scenario" onClick={() => {setAdjustments({});setScenarioDirty(true);}}>Reset all hour adjustments</button>}<div className="cs-scenario-summary"><span>BEFORE → WHAT-IF</span><strong>{fmt(totals.hours)} h <ForemanIcon name="chevronRight" size={17}/> {fmt(scenarioTotal)} h</strong><div className="cs-scenario-bars"><span style={{width:`${Math.min(100,totals.hours/Math.max(1,totals.hours,scenarioTotal)*100)}%`}}/><i style={{width:`${Math.min(100,scenarioTotal/Math.max(1,totals.hours,scenarioTotal)*100)}%`}}/></div><small>{scenarioDelta >= 0 ? "+" : ""}{fmt(scenarioDelta)} h change · arithmetic preview only, not a delivery feasibility forecast.</small></div>
          {people.some(m=>{const s=m.sprints[sprintIndex];return s && plannedHours(s)+numeric(adjustments[`${m.member_id}:${s.sprint_id}:hours`])>grossHours(s);})&&<p className="cs-inline-warning"><ForemanIcon name="warning" size={14}/> Some what-if capacity exceeds available gross hours. Check your assumptions.</p>}
          <button type="button" className="cs-primary cs-submit" disabled={busy || !people.length || (Boolean(scenarioId) && !scenarioDirty)} onClick={saveScenario}><ForemanIcon name="check" size={16}/>{busy ? "Saving…" : scenarioId ? scenarioDirty ? "Update draft scenario" : "Draft saved" : "Save draft scenario"}</button><p className="cs-trust-message"><ForemanIcon name="lock" size={13}/> Simulation only. No sprint reassignment or Jira publishing.</p>
        </div>}
      </aside>
    </div>
  </div>;
}
