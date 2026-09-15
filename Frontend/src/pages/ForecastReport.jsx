import { useEffect, useMemo, useState } from "react";
import "./ForecastReport.css";

// =========================================================
// Forecast report
//
// Renders the POST /datasets/{id}/forecast payload and lets a
// reader actually work with it:
//
//   - filter by team, ticket text, priority and status
//   - show only over-capacity sprints, or only sprints that
//     still contain matching tickets
//   - sort any ticket table by id, points, priority or status
//   - expand / collapse teams and individual sprints
//   - click a ticket to open a detail drawer that resolves its
//     dependency parent, cycle membership and sprint dates
//   - jump straight to a team, and download the raw JSON
//
// Every control is click-driven. There are no hover effects and
// no animation anywhere, per the brief — affordances are carried
// by chevrons, pressed states and cursor changes instead.
// =========================================================

const EM_DASH = "\u2014";

const PRIORITIES = ["High", "Medium", "Low"];
const STATUSES = ["To Do", "In Progress", "Done"];
const PRIORITY_RANK = { High: 0, Medium: 1, Low: 2 };
const STATUS_RANK = { "In Progress": 0, "To Do": 1, Done: 2 };

const PRIORITY_TONE = { High: "risk", Medium: "warn", Low: "neutral" };
const STATUS_TONE = { "In Progress": "info", "To Do": "neutral", Done: "ok" };

// ---------------------------------------------------------
// Formatting
// ---------------------------------------------------------

function num(value, digits = 0) {
  if (value == null || Number.isNaN(value)) return EM_DASH;
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function percent(value, digits = 0) {
  if (value == null || Number.isNaN(value)) return EM_DASH;
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

function date(value) {
  if (!value) return EM_DASH;
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function dateRange(start, end) {
  return `${date(start)} ${EM_DASH} ${date(end)}`;
}

function titleCase(value) {
  if (!value) return EM_DASH;
  return String(value)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------
// Primitives
// ---------------------------------------------------------

function Badge({ tone = "neutral", dot = false, children }) {
  return (
    <span className={`fr-badge fr-badge-${tone}`}>
      {dot && <span className="fr-badge-dot" />}
      {children}
    </span>
  );
}

function Stat({ label, value, note, mono = true, small = false }) {
  return (
    <div>
      <div className="fr-stat-label">{label}</div>
      <div
        className={["fr-stat-value", small ? "fr-stat-small" : "", mono ? "fr-mono" : ""]
          .filter(Boolean)
          .join(" ")}
      >
        {value}
      </div>
      {note && <div className="fr-stat-note">{note}</div>}
    </div>
  );
}

// Fill is capped at 100% width, so an over-committed sprint still
// reads correctly; colour, not length, flags the overrun.
function Meter({ ratio, legend }) {
  const value = Number(ratio) || 0;
  const safe = Math.max(0, Math.min(value, 1));
  const tone = value > 1 ? "fr-meter-over" : value < 0.7 ? "fr-meter-low" : "";
  return (
    <div>
      <div className="fr-meter">
        <div className={`fr-meter-fill ${tone}`} style={{ width: `${safe * 100}%` }} />
      </div>
      {legend && (
        <div className="fr-meter-row">
          <span className="fr-meter-legend">{legend}</span>
          <span className="fr-meter-legend fr-mono">{percent(value, 1)}</span>
        </div>
      )}
    </div>
  );
}

function Toggle({ pressed, onClick, children, title }) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={pressed}
      className={`fr-toggle ${pressed ? "fr-toggle-on" : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Chevron({ open }) {
  return (
    <span className="fr-chevron" aria-hidden="true">
      {open ? "\u25be" : "\u25b8"}
    </span>
  );
}

function CycleChain({ cycle }) {
  return (
    <span className="fr-cycle">
      {cycle.map((ticket, index) => (
        <span key={`${ticket}-${index}`} className="fr-cycle">
          <span className="fr-mono">{ticket}</span>
          <span className="fr-cycle-arrow">&rarr;</span>
        </span>
      ))}
      <span className="fr-mono">{cycle[0]}</span>
    </span>
  );
}

// ---------------------------------------------------------
// Sorting
// ---------------------------------------------------------

const SORTERS = {
  ticket_id: (t) => t.ticket_id,
  title: (t) => (t.title || "").toLowerCase(),
  story_points: (t) => Number(t.story_points) || 0,
  priority: (t) => PRIORITY_RANK[t.priority] ?? 99,
  status: (t) => STATUS_RANK[t.status] ?? 99,
  dependency_parent: (t) => t.dependency_parent || "",
};

function sortTickets(tickets, sort) {
  if (!sort.key) return tickets;
  const pick = SORTERS[sort.key];
  const copy = [...tickets];
  copy.sort((a, b) => {
    const left = pick(a);
    const right = pick(b);
    if (left === right) return a.ticket_id.localeCompare(b.ticket_id);
    const order = left > right ? 1 : -1;
    return sort.direction === "desc" ? -order : order;
  });
  return copy;
}

function SortHeader({ label, sortKey, sort, onSort, numeric = false }) {
  const active = sort.key === sortKey;
  return (
    <th className={numeric ? "fr-num" : undefined}>
      <button
        type="button"
        className={`fr-sort ${active ? "fr-sort-on" : ""}`}
        onClick={() => onSort(sortKey)}
        aria-label={`Sort by ${label}`}
      >
        {label}
        <span className="fr-sort-mark" aria-hidden="true">
          {active ? (sort.direction === "desc" ? "\u2193" : "\u2191") : "\u2195"}
        </span>
      </button>
    </th>
  );
}

// ---------------------------------------------------------
// Controls
// ---------------------------------------------------------

function Controls({
  teams,
  filters,
  setFilters,
  sort,
  onResetSort,
  matchCount,
  totalCount,
  onExpandAll,
  onCollapseAll,
  onDownload,
}) {
  const togglePriority = (value) =>
    setFilters((f) => ({
      ...f,
      priorities: f.priorities.includes(value)
        ? f.priorities.filter((p) => p !== value)
        : [...f.priorities, value],
    }));

  const toggleStatus = (value) =>
    setFilters((f) => ({
      ...f,
      statuses: f.statuses.includes(value)
        ? f.statuses.filter((s) => s !== value)
        : [...f.statuses, value],
    }));

  const dirty =
    filters.query ||
    filters.teamId !== "all" ||
    filters.priorities.length > 0 ||
    filters.statuses.length > 0 ||
    filters.overCapacityOnly ||
    filters.matchingSprintsOnly ||
    sort.key;

  return (
    <div className="fr-controls">
      <div className="fr-controls-row">
        <div className="fr-field fr-field-grow">
          <label className="fr-field-label" htmlFor="fr-search">
            Find a ticket
          </label>
          <div className="fr-input-wrap">
            <input
              id="fr-search"
              type="search"
              className="fr-input"
              placeholder="Ticket id, title or parent"
              value={filters.query}
              onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
            />
            {filters.query && (
              <button
                type="button"
                className="fr-input-clear"
                aria-label="Clear search"
                onClick={() => setFilters((f) => ({ ...f, query: "" }))}
              >
                &times;
              </button>
            )}
          </div>
        </div>

        <div className="fr-field">
          <label className="fr-field-label" htmlFor="fr-team">
            Team
          </label>
          <select
            id="fr-team"
            className="fr-select"
            value={filters.teamId}
            onChange={(e) => setFilters((f) => ({ ...f, teamId: e.target.value }))}
          >
            <option value="all">All teams ({teams.length})</option>
            {teams.map((team) => (
              <option key={team.team_id} value={team.team_id}>
                {team.team_name}
              </option>
            ))}
          </select>
        </div>

        <div className="fr-field">
          <span className="fr-field-label">Priority</span>
          <div className="fr-toggle-group">
            {PRIORITIES.map((value) => (
              <Toggle
                key={value}
                pressed={filters.priorities.includes(value)}
                onClick={() => togglePriority(value)}
              >
                {value}
              </Toggle>
            ))}
          </div>
        </div>

        <div className="fr-field">
          <span className="fr-field-label">Status</span>
          <div className="fr-toggle-group">
            {STATUSES.map((value) => (
              <Toggle
                key={value}
                pressed={filters.statuses.includes(value)}
                onClick={() => toggleStatus(value)}
              >
                {value}
              </Toggle>
            ))}
          </div>
        </div>
      </div>

      <div className="fr-controls-row fr-controls-row-tight">
        <div className="fr-toggle-group">
          <Toggle
            pressed={filters.overCapacityOnly}
            onClick={() =>
              setFilters((f) => ({ ...f, overCapacityOnly: !f.overCapacityOnly }))
            }
            title="Show only sprints planned above their capacity"
          >
            Over capacity only
          </Toggle>
          <Toggle
            pressed={filters.matchingSprintsOnly}
            onClick={() =>
              setFilters((f) => ({ ...f, matchingSprintsOnly: !f.matchingSprintsOnly }))
            }
            title="Hide sprints with no tickets left after filtering"
          >
            Hide empty sprints
          </Toggle>
        </div>

        <div className="fr-controls-spacer">
          <span className="fr-count">
            <strong className="fr-mono">{num(matchCount)}</strong> of{" "}
            <span className="fr-mono">{num(totalCount)}</span> tickets shown
          </span>
        </div>

        <div className="fr-toggle-group">
          <button type="button" className="fr-button fr-button-small" onClick={onExpandAll}>
            Expand all
          </button>
          <button type="button" className="fr-button fr-button-small" onClick={onCollapseAll}>
            Collapse all
          </button>
          <button type="button" className="fr-button fr-button-small" onClick={onDownload}>
            Download JSON
          </button>
          {dirty && (
            <button
              type="button"
              className="fr-button fr-button-small"
              onClick={() => {
                setFilters({
                  query: "",
                  teamId: "all",
                  priorities: [],
                  statuses: [],
                  overCapacityOnly: false,
                  matchingSprintsOnly: false,
                });
                onResetSort();
              }}
            >
              Reset
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------
// Sections
// ---------------------------------------------------------

function Header({ report, onBack, onRerun }) {
  const summary = report.summary || {};
  const method = report.method || {};
  return (
    <header className="fr-header">
      <div>
        <h1 className="fr-title">Delivery forecast</h1>
        <p className="fr-subtitle">
          Every open ticket across {num(summary.teams)} teams, scheduled into sprints by a
          constraint solver that respects team velocity, sprint capacity and dependency
          order.
        </p>
        <div className="fr-meta">
          <div className="fr-meta-item">
            <span className="fr-meta-key">Dataset</span>
            <span className="fr-meta-value fr-mono">{report.dataset_id || EM_DASH}</span>
          </div>
          <div className="fr-meta-item">
            <span className="fr-meta-key">Forecast version</span>
            <span className="fr-meta-value fr-mono">
              {report.forecast_version || EM_DASH}
            </span>
          </div>
          <div className="fr-meta-item">
            <span className="fr-meta-key">Source</span>
            <span className="fr-meta-value">{method.inputs || EM_DASH}</span>
          </div>
        </div>
      </div>

      <div className="fr-header-side">
        <Badge tone={summary.optimization_status === "OPTIMAL" ? "ok" : "warn"} dot>
          Solver {titleCase(summary.optimization_status)}
        </Badge>
        <div className="fr-state-actions">
          {onRerun && (
            <button type="button" className="fr-button" onClick={onRerun}>
              Re-run
            </button>
          )}
          {onBack && (
            <button type="button" className="fr-button" onClick={onBack}>
              Back
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

function Headline({ report, onJump }) {
  const s = report.summary || {};
  const optimization = report.optimization || {};
  const ratio = s.total_open_points ? s.total_points_scheduled / s.total_open_points : 0;
  const cycles = (s.dependency_cycles || []).length;

  return (
    <section className="fr-headline">
      <div className="fr-headline-figure">
        <div className="fr-headline-number fr-mono">{num(s.scheduled_points_percent, 1)}%</div>
        <div className="fr-headline-caption">
          of open work is placed in a sprint. {num(s.total_remaining_points)} points across{" "}
          {num(optimization.remaining_tickets)} tickets could not be fitted into the
          horizon.
        </div>
        <Meter ratio={ratio} />
      </div>

      <div className="fr-headline-split">
        <Stat label="Teams" value={num(s.teams)} />
        <Stat label="Open tickets" value={num(s.open_tickets)} />
        <Stat label="Open points" value={num(s.total_open_points)} />
        <Stat label="Scheduled points" value={num(s.total_points_scheduled)} />
        <Stat label="Unscheduled points" value={num(s.total_remaining_points)} />
        <div>
          <div className="fr-stat-label">Dependency cycles</div>
          <button
            type="button"
            className="fr-stat-link fr-mono"
            onClick={() => onJump("fr-optimization")}
          >
            {num(cycles)}
          </button>
          <div className="fr-stat-note">
            {cycles ? "Open the solver section" : "None found"}
          </div>
        </div>
      </div>
    </section>
  );
}

function OptimizationPanel({ optimization, onSelectTicket }) {
  if (!optimization) return null;
  const cycles = optimization.dependency_cycles || [];
  const outOfScope = optimization.out_of_scope_dependencies || [];

  return (
    <section className="fr-panel" id="fr-optimization">
      <div className="fr-panel-head">
        <div>
          <h2 className="fr-panel-title">Scheduling run</h2>
          <p className="fr-panel-hint">
            A feasible solution satisfies every constraint but is not proven to be the best
            one available. The objective value is only comparable between runs on the same
            dataset.
          </p>
        </div>
        <Badge tone={optimization.status === "OPTIMAL" ? "ok" : "warn"} dot>
          {titleCase(optimization.status)}
        </Badge>
      </div>

      <div className="fr-metric-grid fr-metric-grid-spaced">
        <Stat label="Tickets considered" value={num(optimization.tickets_optimized)} />
        <Stat label="Tickets scheduled" value={num(optimization.tickets_scheduled)} />
        <Stat label="Tickets left over" value={num(optimization.remaining_tickets)} />
        <Stat label="Points left over" value={num(optimization.remaining_points)} />
        <Stat
          label="Dependencies enforced"
          value={num(optimization.internal_dependencies_enforced)}
        />
        <Stat label="Objective value" value={num(optimization.objective_value)} />
      </div>

      <div className="fr-two-col">
        <div>
          <h3 className="fr-section-title">Dependency cycles ({cycles.length})</h3>
          {cycles.length === 0 ? (
            <p className="fr-inline-note">No cycles found.</p>
          ) : (
            <ul className="fr-list">
              {cycles.map((cycle, index) => (
                <li key={index} className="fr-risk fr-risk-high">
                  <div>
                    <div className="fr-risk-type">Cycle {index + 1}</div>
                    <div className="fr-risk-sev">{cycle.length} tickets</div>
                  </div>
                  <div>
                    <CycleChain cycle={cycle} />
                    <p className="fr-inline-note">
                      These tickets block each other, so no valid order exists. Remove one
                      link before trusting the dates below.
                    </p>
                    <div className="fr-chip-row">
                      {cycle.map((ticketId) => (
                        <button
                          key={ticketId}
                          type="button"
                          className="fr-chip-button fr-mono"
                          onClick={() => onSelectTicket(ticketId)}
                        >
                          Inspect {ticketId}
                        </button>
                      ))}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="fr-section-title">
            Dependencies outside scope ({outOfScope.length})
          </h3>
          {outOfScope.length === 0 ? (
            <p className="fr-inline-note">All dependencies resolved inside the forecast.</p>
          ) : (
            <div className="fr-table-wrap">
              <table className="fr-table fr-table-compact">
                <thead>
                  <tr>
                    <th>Ticket</th>
                    <th>Waits on</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {outOfScope.map((dep, index) => (
                    <tr key={`${dep.from}-${dep.to}-${index}`}>
                      <td>
                        <button
                          type="button"
                          className="fr-link-button fr-mono"
                          onClick={() => onSelectTicket(dep.from)}
                        >
                          {dep.from}
                        </button>
                      </td>
                      <td className="fr-mono">{dep.to}</td>
                      <td className="fr-dim">{dep.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function MethodPanel({ method }) {
  if (!method) return null;
  return (
    <section className="fr-panel">
      <div className="fr-panel-head">
        <div>
          <h2 className="fr-panel-title">How this was calculated</h2>
          <p className="fr-panel-hint">{method.confidence_note}</p>
        </div>
      </div>
      <dl className="fr-defs">
        <div>
          <dt>Velocity model</dt>
          <dd>{method.velocity || EM_DASH}</dd>
        </div>
        <div>
          <dt>Scheduler</dt>
          <dd>{method.optimization || EM_DASH}</dd>
        </div>
        <div>
          <dt>Scope</dt>
          <dd>{method.scope || EM_DASH}</dd>
        </div>
        <div>
          <dt>Inputs</dt>
          <dd>{method.inputs || EM_DASH}</dd>
        </div>
      </dl>
    </section>
  );
}

function RiskList({ risks }) {
  if (!risks || risks.length === 0) {
    return <p className="fr-inline-note">No risks raised for this team.</p>;
  }
  return (
    <ul className="fr-list">
      {risks.map((risk, index) => (
        <li
          key={`${risk.type}-${index}`}
          className={`fr-risk fr-risk-${String(risk.severity || "").toLowerCase()}`}
        >
          <div>
            <div className="fr-risk-type">{titleCase(risk.type)}</div>
            <div className="fr-risk-sev">{titleCase(risk.severity)}</div>
          </div>
          <div className="fr-risk-message">{risk.message}</div>
        </li>
      ))}
    </ul>
  );
}

function VelocityBlock({ velocity }) {
  if (!velocity) return null;
  const history = velocity.completed_points || [];
  return (
    <div>
      <h3 className="fr-section-title">Velocity model</h3>
      <div className="fr-metric-grid">
        <Stat
          label="Forecast velocity"
          value={num(velocity.forecast_velocity_points, 2)}
          note="points per sprint"
        />
        <Stat label="Base velocity" value={num(velocity.base_velocity_points)} />
        <Stat label="Average completed" value={num(velocity.average_completed_points, 1)} />
        <Stat label="Median completed" value={num(velocity.median_completed_points, 1)} />
        <Stat label="Recent average" value={num(velocity.recent_average_points, 1)} />
        <Stat label="Sprints of history" value={num(velocity.completed_sprints_used)} />
        <Stat
          label="Capacity used historically"
          value={percent(velocity.historical_capacity_utilization, 1)}
        />
        <Stat
          label="Variability"
          value={
            velocity.coefficient_of_variation == null
              ? EM_DASH
              : num(velocity.coefficient_of_variation, 2)
          }
          note={
            velocity.coefficient_of_variation == null
              ? "not enough data"
              : "coefficient of variation"
          }
        />
        <Stat label="Trend" value={titleCase(velocity.trend)} mono={false} small />
        <Stat label="Confidence" value={percent(velocity.confidence)} />
      </div>
      <p className="fr-inline-note">
        Completed points per sprint:{" "}
        <span className="fr-mono">
          {history.length ? history.join(", ") : "no completed sprints recorded"}
        </span>
      </p>
    </div>
  );
}

function BacklogBlock({ backlog }) {
  if (!backlog) return null;
  const ratio = backlog.open_points ? backlog.scheduled_points / backlog.open_points : 0;
  return (
    <div>
      <h3 className="fr-section-title">Backlog</h3>
      <div className="fr-metric-grid fr-metric-grid-spaced">
        <Stat label="Open tickets" value={num(backlog.open_tickets)} />
        <Stat label="Open points" value={num(backlog.open_points)} />
        <Stat label="Scheduled" value={num(backlog.scheduled_points)} />
        <Stat
          label="Not scheduled"
          value={num(backlog.remaining_points)}
          note={backlog.remaining_points ? "beyond the horizon" : "all work placed"}
        />
      </div>
      <Meter ratio={ratio} legend="Share of open points scheduled" />
    </div>
  );
}

function TicketTable({ tickets, sort, onSort, onSelectTicket, selectedId, flags }) {
  const rows = sortTickets(tickets, sort);
  return (
    <div className="fr-table-wrap fr-table-wrap-flush">
      <table className="fr-table">
        <thead>
          <tr>
            <SortHeader label="Ticket" sortKey="ticket_id" sort={sort} onSort={onSort} />
            <SortHeader label="Title" sortKey="title" sort={sort} onSort={onSort} />
            <SortHeader
              label="Points"
              sortKey="story_points"
              sort={sort}
              onSort={onSort}
              numeric
            />
            <SortHeader label="Priority" sortKey="priority" sort={sort} onSort={onSort} />
            <SortHeader label="Status" sortKey="status" sort={sort} onSort={onSort} />
            <SortHeader
              label="Parent"
              sortKey="dependency_parent"
              sort={sort}
              onSort={onSort}
            />
          </tr>
        </thead>
        <tbody>
          {rows.map((ticket) => {
            const flag = flags(ticket.ticket_id);
            return (
              <tr
                key={ticket.ticket_id}
                className={selectedId === ticket.ticket_id ? "fr-row-selected" : undefined}
              >
                <td>
                  <button
                    type="button"
                    className="fr-link-button fr-mono"
                    onClick={() => onSelectTicket(ticket.ticket_id)}
                  >
                    {ticket.ticket_id}
                  </button>
                </td>
                <td>
                  {ticket.title}
                  {flag.inCycle && (
                    <>
                      {" "}
                      <Badge tone="risk">In cycle</Badge>
                    </>
                  )}
                  {flag.outOfScope && (
                    <>
                      {" "}
                      <Badge tone="warn">External dependency</Badge>
                    </>
                  )}
                </td>
                <td className="fr-num fr-mono">{num(ticket.story_points)}</td>
                <td>
                  <Badge tone={PRIORITY_TONE[ticket.priority] || "neutral"}>
                    {ticket.priority}
                  </Badge>
                </td>
                <td>
                  <Badge tone={STATUS_TONE[ticket.status] || "neutral"}>{ticket.status}</Badge>
                </td>
                <td className="fr-mono fr-dim">{ticket.dependency_parent || EM_DASH}</td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="fr-dim">
                No tickets match the current filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function SprintRow({
  sprint,
  open,
  onToggle,
  sort,
  onSort,
  onSelectTicket,
  selectedId,
  flags,
  hiddenCount,
}) {
  return (
    <article className={`fr-sprint ${open ? "fr-sprint-open" : ""}`}>
      <div className="fr-sprint-head">
        <button
          type="button"
          className="fr-sprint-toggle"
          aria-expanded={open}
          onClick={onToggle}
        >
          <Chevron open={open} />
          <span>
            <span className="fr-sprint-id fr-mono">{sprint.sprint_id}</span>
            <span className="fr-sprint-dates fr-mono">
              {dateRange(sprint.start_date, sprint.end_date)}
            </span>
          </span>
        </button>

        <Meter
          ratio={sprint.utilization}
          legend={`${num(sprint.planned_points)} of ${num(sprint.capacity_points, 1)} pts`}
        />

        <div className="fr-sprint-figures">
          <span className="fr-mono">{sprint.tickets.length} tickets</span>
          {hiddenCount > 0 && (
            <span className="fr-dim fr-mono">({hiddenCount} filtered out)</span>
          )}
          {sprint.utilization > 1 && <Badge tone="warn">Over capacity</Badge>}
        </div>
      </div>

      {open && (
        <TicketTable
          tickets={sprint.tickets}
          sort={sort}
          onSort={onSort}
          onSelectTicket={onSelectTicket}
          selectedId={selectedId}
          flags={flags}
        />
      )}
    </article>
  );
}

function CalendarTable({ calendar }) {
  if (!calendar || calendar.length === 0) return null;
  return (
    <div className="fr-table-wrap">
      <table className="fr-table">
        <thead>
          <tr>
            <th>Sprint</th>
            <th>Dates</th>
            <th className="fr-num">Planned capacity</th>
            <th className="fr-num">Forecast capacity</th>
            <th className="fr-num">Holiday factor</th>
            <th>Holidays</th>
            <th>Origin</th>
          </tr>
        </thead>
        <tbody>
          {calendar.map((entry) => (
            <tr key={entry.sprint_id}>
              <td className="fr-mono">{entry.sprint_id}</td>
              <td className="fr-mono fr-dim">{dateRange(entry.start_date, entry.end_date)}</td>
              <td className="fr-num fr-mono">
                {entry.planned_capacity_points == null
                  ? EM_DASH
                  : num(entry.planned_capacity_points)}
              </td>
              <td className="fr-num fr-mono">{num(entry.forecast_capacity_points, 1)}</td>
              <td className="fr-num fr-mono">{num(entry.holiday_adjustment_factor, 2)}</td>
              <td>
                {(entry.holiday_names || []).length ? (
                  entry.holiday_names.join(", ")
                ) : (
                  <span className="fr-dim">None</span>
                )}
              </td>
              <td>
                <Badge tone={entry.generated ? "violet" : "neutral"}>
                  {entry.generated ? "Generated" : "From plan"}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TeamPanel({
  team,
  sprints,
  hiddenBySprint,
  view,
  setView,
  sort,
  onSort,
  onSelectTicket,
  selectedId,
  flags,
}) {
  const forecast = team.forecast || {};
  const completed = Boolean(forecast.completion_date);
  const open = view.open;
  const matched = sprints.reduce((total, sprint) => total + sprint.tickets.length, 0);

  return (
    <section className="fr-team" id={`team-${team.team_id}`}>
      <div className="fr-team-head">
        <button
          type="button"
          className="fr-team-toggle"
          aria-expanded={open}
          onClick={() => setView({ ...view, open: !open })}
        >
          <Chevron open={open} />
          <span>
            <span className="fr-team-name">{team.team_name}</span>
            <span className="fr-team-sub">
              <span className="fr-mono">{team.team_id}</span> &middot; {team.product_service}
            </span>
          </span>
        </button>

        <div className="fr-team-badges">
          <Badge tone="neutral">
            <span className="fr-mono">{num(matched)}</span> tickets shown
          </Badge>
          <Badge tone={completed ? "ok" : "warn"} dot>
            {completed
              ? `Backlog clear ${date(forecast.completion_date)}`
              : "No completion date in horizon"}
          </Badge>
          <Badge tone={(team.backlog || {}).remaining_points ? "warn" : "ok"}>
            {num((team.backlog || {}).remaining_points)} pts unscheduled
          </Badge>
        </div>
      </div>

      {open && (
        <div className="fr-team-body">
          <div className="fr-tabs" role="tablist" aria-label={`${team.team_name} sections`}>
            {[
              { id: "plan", label: `Sprint plan (${sprints.length})` },
              { id: "velocity", label: "Velocity & backlog" },
              { id: "risks", label: `Risks (${(team.risks || []).length})` },
              {
                id: "calendar",
                label: `Calendar (${(team.forecast_calendar || []).length})`,
              },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={view.tab === tab.id}
                className={`fr-tab ${view.tab === tab.id ? "fr-tab-on" : ""}`}
                onClick={() => setView({ ...view, tab: tab.id })}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {view.tab === "plan" && (
            <div className="fr-sprints">
              {sprints.length === 0 && (
                <p className="fr-inline-note">
                  No sprints match the current filters for this team.
                </p>
              )}
              {sprints.map((sprint) => (
                <SprintRow
                  key={sprint.sprint_id}
                  sprint={sprint}
                  open={!view.collapsedSprints.includes(sprint.sprint_id)}
                  onToggle={() =>
                    setView({
                      ...view,
                      collapsedSprints: view.collapsedSprints.includes(sprint.sprint_id)
                        ? view.collapsedSprints.filter((id) => id !== sprint.sprint_id)
                        : [...view.collapsedSprints, sprint.sprint_id],
                    })
                  }
                  sort={sort}
                  onSort={onSort}
                  onSelectTicket={onSelectTicket}
                  selectedId={selectedId}
                  flags={flags}
                  hiddenCount={hiddenBySprint[sprint.sprint_id] || 0}
                />
              ))}
            </div>
          )}

          {view.tab === "velocity" && (
            <div className="fr-two-col">
              <VelocityBlock velocity={team.velocity_forecast} />
              <BacklogBlock backlog={team.backlog} />
            </div>
          )}

          {view.tab === "risks" && <RiskList risks={team.risks} />}

          {view.tab === "calendar" && <CalendarTable calendar={team.forecast_calendar} />}
        </div>
      )}
    </section>
  );
}

function TicketDrawer({ entry, onClose, onSelectTicket }) {
  if (!entry) return null;
  const { ticket, team, sprint, inCycle, cycle, outOfScope, siblings } = entry;

  return (
    <aside className="fr-drawer" role="dialog" aria-label={`Ticket ${ticket.ticket_id}`}>
      <div className="fr-drawer-head">
        <div>
          <div className="fr-drawer-id fr-mono">{ticket.ticket_id}</div>
          <div className="fr-drawer-title">{ticket.title}</div>
        </div>
        <button type="button" className="fr-drawer-close" onClick={onClose} aria-label="Close">
          &times;
        </button>
      </div>

      <div className="fr-drawer-body">
        <div className="fr-drawer-badges">
          <Badge tone={PRIORITY_TONE[ticket.priority] || "neutral"}>{ticket.priority}</Badge>
          <Badge tone={STATUS_TONE[ticket.status] || "neutral"}>{ticket.status}</Badge>
          <Badge tone="neutral">
            <span className="fr-mono">{num(ticket.story_points)}</span> pts
          </Badge>
        </div>

        <dl className="fr-drawer-defs">
          <div>
            <dt>Team</dt>
            <dd>
              {team.team_name} <span className="fr-dim fr-mono">{team.team_id}</span>
            </dd>
          </div>
          <div>
            <dt>Product</dt>
            <dd>{team.product_service}</dd>
          </div>
          <div>
            <dt>Sprint</dt>
            <dd className="fr-mono">{sprint.sprint_id}</dd>
          </div>
          <div>
            <dt>Window</dt>
            <dd className="fr-mono">{dateRange(sprint.start_date, sprint.end_date)}</dd>
          </div>
          <div>
            <dt>Sprint load</dt>
            <dd className="fr-mono">
              {num(sprint.planned_points)} / {num(sprint.capacity_points, 1)} pts{" "}
              <span className="fr-dim">({percent(sprint.utilization, 1)})</span>
            </dd>
          </div>
          <div>
            <dt>Parent</dt>
            <dd className="fr-mono">{ticket.dependency_parent || EM_DASH}</dd>
          </div>
        </dl>

        {inCycle && (
          <div className="fr-drawer-block fr-drawer-block-risk">
            <div className="fr-risk-type">Part of a dependency cycle</div>
            <CycleChain cycle={cycle} />
            <p className="fr-inline-note">
              The dates on this ticket are not trustworthy until one link is removed.
            </p>
          </div>
        )}

        {outOfScope && (
          <div className="fr-drawer-block fr-drawer-block-warn">
            <div className="fr-risk-type">
              Waits on <span className="fr-mono">{outOfScope.to}</span>
            </div>
            <p className="fr-inline-note">{outOfScope.reason}</p>
          </div>
        )}

        <div>
          <h3 className="fr-section-title">Same sprint ({siblings.length})</h3>
          <div className="fr-chip-row">
            {siblings.map((sibling) => (
              <button
                key={sibling.ticket_id}
                type="button"
                className="fr-chip-button fr-mono"
                onClick={() => onSelectTicket(sibling.ticket_id)}
              >
                {sibling.ticket_id} &middot; {sibling.story_points}p
              </button>
            ))}
            {siblings.length === 0 && <span className="fr-dim">Only ticket in the sprint.</span>}
          </div>
        </div>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------
// Page
// ---------------------------------------------------------

const EMPTY_FILTERS = {
  query: "",
  teamId: "all",
  priorities: [],
  statuses: [],
  overCapacityOnly: false,
  matchingSprintsOnly: false,
};

export default function ForecastReport({
  report,
  loading = false,
  error = "",
  onBack,
  onRetry,
}) {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [sort, setSort] = useState({ key: null, direction: "asc" });
  const [views, setViews] = useState({});
  const [selectedId, setSelectedId] = useState(null);

  const teams = useMemo(() => (report && report.teams) || [], [report]);

  // Seed one view state per team the first time a report arrives.
  useEffect(() => {
    if (!teams.length) return;
    setViews((current) => {
      const next = { ...current };
      teams.forEach((team, index) => {
        if (!next[team.team_id]) {
          next[team.team_id] = {
            open: index === 0,
            tab: "plan",
            collapsedSprints: [],
          };
        }
      });
      return next;
    });
  }, [teams]);

  // Close the drawer on Escape.
  useEffect(() => {
    if (!selectedId) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

  // Flat index of every scheduled ticket, used by the drawer and
  // by the cycle / out-of-scope lookups.
  const index = useMemo(() => {
    const map = new Map();
    teams.forEach((team) => {
      ((team.forecast || {}).sprints || []).forEach((sprint) => {
        (sprint.tickets || []).forEach((ticket) => {
          map.set(ticket.ticket_id, { ticket, team, sprint });
        });
      });
    });
    return map;
  }, [teams]);

  const cycleLookup = useMemo(() => {
    const map = new Map();
    ((report && report.optimization && report.optimization.dependency_cycles) || []).forEach(
      (cycle) => cycle.forEach((id) => map.set(id, cycle)),
    );
    return map;
  }, [report]);

  const outOfScopeLookup = useMemo(() => {
    const map = new Map();
    (
      (report && report.optimization && report.optimization.out_of_scope_dependencies) ||
      []
    ).forEach((dep) => map.set(dep.from, dep));
    return map;
  }, [report]);

  const flags = useMemo(
    () => (ticketId) => ({
      inCycle: cycleLookup.has(ticketId),
      outOfScope: outOfScopeLookup.has(ticketId),
    }),
    [cycleLookup, outOfScopeLookup],
  );

  // Apply the filters to a copy of the team/sprint/ticket tree.
  const filtered = useMemo(() => {
    const query = filters.query.trim().toLowerCase();

    const matches = (ticket) => {
      if (filters.priorities.length && !filters.priorities.includes(ticket.priority)) {
        return false;
      }
      if (filters.statuses.length && !filters.statuses.includes(ticket.status)) {
        return false;
      }
      if (query) {
        const haystack = [ticket.ticket_id, ticket.title, ticket.dependency_parent]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    };

    let total = 0;
    let shown = 0;
    const hiddenBySprint = {};

    const byTeam = teams
      .filter((team) => filters.teamId === "all" || team.team_id === filters.teamId)
      .map((team) => {
        const sprints = ((team.forecast || {}).sprints || [])
          .filter((sprint) => !filters.overCapacityOnly || sprint.utilization > 1)
          .map((sprint) => {
            const all = sprint.tickets || [];
            const kept = all.filter(matches);
            hiddenBySprint[sprint.sprint_id] = all.length - kept.length;
            return { ...sprint, tickets: kept };
          })
          .filter((sprint) => !filters.matchingSprintsOnly || sprint.tickets.length > 0);

        return { team, sprints };
      });

    teams.forEach((team) => {
      ((team.forecast || {}).sprints || []).forEach((sprint) => {
        (sprint.tickets || []).forEach((ticket) => {
          total += 1;
          if (
            (filters.teamId === "all" || team.team_id === filters.teamId) &&
            matches(ticket)
          ) {
            shown += 1;
          }
        });
      });
    });

    return { byTeam, hiddenBySprint, total, shown };
  }, [teams, filters]);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    const hit = index.get(selectedId);
    if (!hit) return null;
    return {
      ...hit,
      inCycle: cycleLookup.has(selectedId),
      cycle: cycleLookup.get(selectedId) || [],
      outOfScope: outOfScopeLookup.get(selectedId) || null,
      siblings: (hit.sprint.tickets || []).filter((t) => t.ticket_id !== selectedId),
    };
  }, [selectedId, index, cycleLookup, outOfScopeLookup]);

  const handleSort = (key) =>
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: key === "story_points" ? "desc" : "asc" },
    );

  const setTeamView = (teamId, next) =>
    setViews((current) => ({ ...current, [teamId]: next }));

  const expandAll = () =>
    setViews((current) => {
      const next = {};
      teams.forEach((team) => {
        next[team.team_id] = {
          ...(current[team.team_id] || { tab: "plan" }),
          open: true,
          collapsedSprints: [],
        };
      });
      return next;
    });

  const collapseAll = () =>
    setViews((current) => {
      const next = {};
      teams.forEach((team) => {
        next[team.team_id] = {
          ...(current[team.team_id] || { tab: "plan" }),
          open: false,
          collapsedSprints: [],
        };
      });
      return next;
    });

  const jumpTo = (elementId) => {
    const node = document.getElementById(elementId);
    if (node) node.scrollIntoView({ block: "start" });
  };

  const openTeam = (teamId) => {
    setViews((current) => ({
      ...current,
      [teamId]: { ...(current[teamId] || { tab: "plan", collapsedSprints: [] }), open: true },
    }));
    jumpTo(`team-${teamId}`);
  };

  const selectTicket = (ticketId) => {
    const hit = index.get(ticketId);
    if (hit) {
      setViews((current) => ({
        ...current,
        [hit.team.team_id]: {
          ...(current[hit.team.team_id] || { collapsedSprints: [] }),
          open: true,
          tab: "plan",
          collapsedSprints: (current[hit.team.team_id]?.collapsedSprints || []).filter(
            (id) => id !== hit.sprint.sprint_id,
          ),
        },
      }));
    }
    setSelectedId(ticketId);
  };

  const download = () => {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `forecast-${report.dataset_id || "report"}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="fr-page">
        <div className="fr-state">
          <h2>Running the forecast</h2>
          <p>
            The solver is scheduling every open ticket against team velocity and dependency
            order. This usually takes a few seconds.
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="fr-page">
        <div className="fr-state">
          <h2>The forecast didn&rsquo;t run</h2>
          <p>{error}</p>
          <div className="fr-state-actions">
            {onRetry && (
              <button type="button" className="fr-button fr-button-primary" onClick={onRetry}>
                Try again
              </button>
            )}
            {onBack && (
              <button type="button" className="fr-button" onClick={onBack}>
                Back
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="fr-page">
        <div className="fr-state">
          <h2>No forecast to show</h2>
          <p>Ingest a dataset first, then run a forecast to see the report here.</p>
          {onBack && (
            <button type="button" className="fr-button fr-button-primary" onClick={onBack}>
              Choose a dataset
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`fr-page ${selected ? "fr-page-with-drawer" : ""}`}>
      <div className="fr-shell">
        <Header report={report} onBack={onBack} onRerun={onRetry} />
        <Headline report={report} onJump={jumpTo} />

        <nav className="fr-jump" aria-label="Jump to team">
          <span className="fr-jump-label">Jump to</span>
          {teams.map((team) => (
            <button
              key={team.team_id}
              type="button"
              className="fr-chip-button"
              onClick={() => openTeam(team.team_id)}
            >
              {team.team_name}
            </button>
          ))}
        </nav>

        <Controls
          teams={teams}
          filters={filters}
          setFilters={setFilters}
          sort={sort}
          onResetSort={() => setSort({ key: null, direction: "asc" })}
          matchCount={filtered.shown}
          totalCount={filtered.total}
          onExpandAll={expandAll}
          onCollapseAll={collapseAll}
          onDownload={download}
        />

        <OptimizationPanel
          optimization={report.optimization}
          onSelectTicket={selectTicket}
        />

        {filtered.byTeam.map(({ team, sprints }) => (
          <TeamPanel
            key={team.team_id}
            team={team}
            sprints={sprints}
            hiddenBySprint={filtered.hiddenBySprint}
            view={views[team.team_id] || { open: false, tab: "plan", collapsedSprints: [] }}
            setView={(next) => setTeamView(team.team_id, next)}
            sort={sort}
            onSort={handleSort}
            onSelectTicket={selectTicket}
            selectedId={selectedId}
            flags={flags}
          />
        ))}

        {filtered.byTeam.length === 0 && (
          <p className="fr-inline-note">No teams match the current filters.</p>
        )}

        <MethodPanel method={report.method} />
      </div>

      <TicketDrawer
        entry={selected}
        onClose={() => setSelectedId(null)}
        onSelectTicket={selectTicket}
      />
    </div>
  );
}
