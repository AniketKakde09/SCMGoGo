import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { getEstimationData, submitEstimates } from "../services/api";
import "./Estimation.css";

const DEFAULT_SIZES = ["S", "M", "L", "XL"];

const SIZE_TO_POINTS = {
  S: 2,
  M: 5,
  L: 8,
  XL: 13,
};

function calculateConfidence(values) {
  const estimates = values.filter(Boolean);

  if (estimates.length === 0) {
    return 0;
  }

  const points = estimates
    .map((value) => SIZE_TO_POINTS[value])
    .filter(Boolean);

  if (points.length <= 1) {
    return 100;
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const average =
    points.reduce((sum, value) => sum + value, 0) / points.length;

  if (average === 0) {
    return 0;
  }

  const spread = (max - min) / average;

  return Math.max(0, Math.min(100, Math.round(100 - spread * 55)));
}

function getFinalSize(values) {
  const estimates = values.filter(Boolean);

  if (!estimates.length) {
    return null;
  }

  const counts = {};

  estimates.forEach((size) => {
    counts[size] = (counts[size] || 0) + 1;
  });

  return Object.entries(counts).sort((a, b) => {
    if (b[1] !== a[1]) {
      return b[1] - a[1];
    }

    return SIZE_TO_POINTS[b[0]] - SIZE_TO_POINTS[a[0]];
  })[0][0];
}

function ConfidenceBar({ value }) {
  const filled = Math.round(value / 10);
  const empty = 10 - filled;

  return (
    <div className="est-confidence">
      <span className="est-confidence-bar" aria-hidden="true">
        {"█".repeat(filled)}
        {"░".repeat(empty)}
      </span>

      <span className="est-confidence-value">{value}%</span>
    </div>
  );
}

function EstimateSelect({ value, onChange }) {
  return (
    <select
      className={`est-size-select ${value ? `size-${value.toLowerCase()}` : ""}`}
      value={value || ""}
      onChange={(event) => onChange(event.target.value || null)}
      aria-label="Team member estimate"
    >
      <option value="">—</option>

      {DEFAULT_SIZES.map((size) => (
        <option key={size} value={size}>
          {size}
        </option>
      ))}
    </select>
  );
}

export default function Estimation() {
  const location = useLocation();
  const datasetId =
    location.state?.datasetId || localStorage.getItem("foremanDatasetId") || "";

  const [teams, setTeams] = useState([]);
  const [selectedTeamId, setSelectedTeamId] = useState("");
  const [data, setData] = useState(null);
  const [estimates, setEstimates] = useState({});
  const [loading, setLoading] = useState(Boolean(datasetId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(
    datasetId ? "" : "No dataset selected. Upload or choose a dataset first.",
  );
  const [filter, setFilter] = useState("");

  // Step 1: load the team list for this dataset (no team_id yet).
  useEffect(() => {
    let mounted = true;

    if (!datasetId) {
      return () => {
        mounted = false;
      };
    }

    async function loadTeams() {
      try {
        setLoading(true);
        setError("");

        const response = await getEstimationData(datasetId);
        const teamList = response?.teams || [];

        if (!mounted) {
          return;
        }

        setTeams(teamList);

        if (teamList.length) {
          setSelectedTeamId((current) => current || teamList[0].id);
        } else {
          setData(null);
          setLoading(false);
          setError("No teams found in this dataset.");
        }
      } catch (err) {
        if (mounted) {
          setError(err.message || "Unable to load estimation data.");
          setLoading(false);
        }
      }
    }

    loadTeams();

    return () => {
      mounted = false;
    };
  }, [datasetId]);

  // Step 2: once a team is selected, load its members + tickets.
  useEffect(() => {
    let mounted = true;

    if (!datasetId || !selectedTeamId) {
      return () => {
        mounted = false;
      };
    }

    async function loadTeamWorkspace() {
      try {
        setLoading(true);
        setError("");

        const response = await getEstimationData(datasetId, selectedTeamId);

        if (mounted) {
          setData(response);
          setEstimates({});
        }
      } catch (err) {
        if (mounted) {
          setError(err.message || "Unable to load team estimation data.");
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    loadTeamWorkspace();

    return () => {
      mounted = false;
    };
  }, [datasetId, selectedTeamId]);

  const teamMembers = data?.team_members || [];
  const tickets = data?.tickets || [];

  const filteredTickets = useMemo(() => {
    if (!filter.trim()) {
      return tickets;
    }

    const query = filter.toLowerCase();

    return tickets.filter((ticket) =>
      [
        ticket.id,
        ticket.key,
        ticket.title,
        ticket.summary,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query)),
    );
  }, [tickets, filter]);

  function updateEstimate(ticketId, memberId, value) {
    setEstimates((current) => ({
      ...current,
      [ticketId]: {
        ...(current[ticketId] || {}),
        [memberId]: value,
      },
    }));
  }

  function getTicketEstimates(ticketId) {
    return teamMembers.map((member) => ({
      memberId: member.id,
      value: estimates[ticketId]?.[member.id] || null,
    }));
  }

  function getTicketSummary(ticketId) {
    const values = getTicketEstimates(ticketId).map(
      (estimate) => estimate.value,
    );

    const finalSize = getFinalSize(values);
    const confidence = calculateConfidence(values);

    return {
      finalSize,
      finalPoints: finalSize ? SIZE_TO_POINTS[finalSize] : null,
      confidence,
    };
  }

  async function handleSubmit() {
    try {
      setSaving(true);
      setError("");

      const payload = {
        team_id: data?.team?.id,
        session_id: data?.session_id,
        estimates: tickets.map((ticket) => ({
          ticket_id: ticket.id,
          members: teamMembers.map((member) => ({
            member_id: member.id,
            estimate: estimates[ticket.id]?.[member.id] || null,
          })),
          final_size: getTicketSummary(ticket.id).finalSize,
          final_story_points: getTicketSummary(ticket.id).finalPoints,
          confidence: getTicketSummary(ticket.id).confidence,
        })),
      };

      await submitEstimates(datasetId, payload);
    } catch (err) {
      setError(err.message || "Unable to save estimates.");
    } finally {
      setSaving(false);
    }
  }

  const totalTickets = tickets.length;

  const estimatedTickets = tickets.filter((ticket) =>
    teamMembers.some((member) => estimates[ticket.id]?.[member.id]),
  ).length;

  if (loading) {
    return (
      <section className="est-page">
        <div className="est-loading">
          <div className="est-loading-spinner" />
          <p>Loading estimation workspace...</p>
        </div>
      </section>
    );
  }

  if (error && !data) {
    return (
      <section className="est-page">
        <div className="est-error">
          <strong>Unable to load estimation workspace</strong>
          <p>{error}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="est-page">
      <div className="est-toolbar">
        <div>
          <div className="est-eyebrow">TEAM ESTIMATION</div>

          <h2>
            {data?.team?.name || "Team"} estimation
          </h2>

          <p>
            Estimate independently using T-shirt sizing and review the
            resulting team consensus.
          </p>
        </div>

        <div className="est-toolbar-actions">
          <select
            className="est-team-select"
            value={selectedTeamId}
            onChange={(event) => setSelectedTeamId(event.target.value)}
            disabled={!teams.length}
          >
            {teams.length ? (
              teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))
            ) : (
              <option value="">Select team</option>
            )}
          </select>

          <button
            type="button"
            className="est-submit-button"
            disabled={saving}
            onClick={handleSubmit}
          >
            {saving ? "Saving..." : "Submit estimates"}
          </button>
        </div>
      </div>

      <div className="est-summary">
        <div className="est-summary-card">
          <span>Tickets</span>
          <strong>{totalTickets}</strong>
        </div>

        <div className="est-summary-card">
          <span>Estimated</span>
          <strong>
            {estimatedTickets}
            <small> / {totalTickets}</small>
          </strong>
        </div>

        <div className="est-summary-card">
          <span>Team members</span>
          <strong>{teamMembers.length}</strong>
        </div>

        <div className="est-summary-card est-legend-card">
          <span>Scale</span>
          <strong>S · M · L · XL</strong>
        </div>
      </div>

      {error && (
        <div className="est-inline-error">
          {error}
        </div>
      )}

      <div className="est-table-card">
        <div className="est-table-header">
          <div>
            <h3>Ticket estimation</h3>
            <span>
              {filteredTickets.length} tickets shown
            </span>
          </div>

          <input
            className="est-search"
            type="search"
            placeholder="Search tickets..."
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>

        <div className="est-table-wrapper">
          <table className="est-table">
            <thead>
              <tr>
                <th className="est-sticky-col est-number-col">#</th>

                <th className="est-sticky-col est-ticket-col">
                  Ticket
                </th>

                <th className="est-sticky-col est-id-col">
                  Ticket ID
                </th>

                {teamMembers.map((member) => (
                  <th key={member.id} className="est-member-col">
                    <div className="est-member-header">
                      <span className="est-member-avatar">
                        {member.name?.charAt(0)?.toUpperCase() || "?"}
                      </span>

                      <span>{member.name}</span>
                    </div>
                  </th>
                ))}

                <th className="est-final-col">
                  Final SP
                </th>

                <th className="est-confidence-col">
                  Team confidence
                </th>
              </tr>
            </thead>

            <tbody>
              {filteredTickets.map((ticket, index) => {
                const summary = getTicketSummary(ticket.id);

                return (
                  <tr key={ticket.id}>
                    <td className="est-sticky-col est-number-col">
                      {index + 1}
                    </td>

                    <td className="est-sticky-col est-ticket-col">
                      <div className="est-ticket-title">
                        {ticket.title || ticket.summary}
                      </div>

                      {ticket.description && (
                        <div className="est-ticket-description">
                          {ticket.description}
                        </div>
                      )}
                    </td>

                    <td className="est-sticky-col est-id-col">
                      <span className="est-ticket-id">
                        {ticket.key || ticket.id}
                      </span>
                    </td>

                    {teamMembers.map((member) => (
                      <td key={member.id} className="est-member-cell">
                        <EstimateSelect
                          value={
                            estimates[ticket.id]?.[member.id] || null
                          }
                          onChange={(value) =>
                            updateEstimate(
                              ticket.id,
                              member.id,
                              value,
                            )
                          }
                        />
                      </td>
                    ))}

                    <td className="est-final-cell">
                      {summary.finalPoints ? (
                        <div className="est-final-value">
                          <strong>{summary.finalPoints}</strong>

                          <span>
                            {summary.finalSize}
                          </span>
                        </div>
                      ) : (
                        <span className="est-empty-value">
                          —
                        </span>
                      )}
                    </td>

                    <td className="est-confidence-cell">
                      <ConfidenceBar value={summary.confidence} />
                    </td>
                  </tr>
                );
              })}

              {!filteredTickets.length && (
                <tr>
                  <td
                    colSpan={3 + teamMembers.length + 2}
                    className="est-empty-row"
                  >
                    No tickets found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="est-table-footer">
          <span>
            Estimates are saved locally until submitted.
          </span>

          <span>
            S = 2 · M = 5 · L = 8 · XL = 13
          </span>
        </div>
      </div>
    </section>
  );
}
