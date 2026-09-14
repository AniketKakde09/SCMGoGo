import { useState } from "react";

const API_BASE_URL = "http://localhost:8000";

// -----------------------------------------------------------
// Renders the epic-placement decisions produced by
// backend/agents/backlog_agent.py (see epic.placement / epic_decisions
// in the /api/process response).
//
// Deliberately NOT a retry loop: each decision gets exactly one optional
// prompt for extra context. Submitting a hint (or explicitly skipping)
// marks it "asked" server-side and the panel won't ask again — the person
// can always resolve it manually later, this is just a single nudge to
// see if a quick hint clears things up.
// -----------------------------------------------------------

function DecisionCard({ decision, sessionId, onResolved }) {
  const [hint, setHint] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState("");

  const respond = async (submittedHint) => {
    if (submitting) return;
    setSubmitting(true);
    setLocalError("");

    try {
      const response = await fetch(`${API_BASE_URL}/api/epic-decisions/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          decision_id: decision.decision_id,
          hint: submittedHint || null,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.detail || "Could not submit that.");
      }

      onResolved(result.decision, result.epic);
    } catch (err) {
      console.error("Epic decision response failed:", err);
      setLocalError(err.message || "Something went wrong.");
      setSubmitting(false);
    }
  };

  if (decision.answered) {
    // Resolved (or explicitly skipped) — show the outcome, not a form.
    const outcomeLabel =
      {
        reuse_epic: "Reused an existing epic.",
        sad_linked: "Linked to an existing SAD section.",
        still_unresolved: "Still unresolved — left for manual review.",
        skipped: "Skipped — left for manual review.",
      }[decision.resolution] || "Resolved.";

    return (
      <div className="epic-decision-card epic-decision-card-done">
        <div className="epic-decision-title">{decision.epic_title}</div>
        <div className="epic-decision-outcome">✓ {outcomeLabel}</div>
      </div>
    );
  }

  return (
    <div className="epic-decision-card">
      <div className="epic-decision-title">{decision.epic_title}</div>
      <p className="epic-decision-question">{decision.question}</p>

      <input
        type="text"
        value={hint}
        onChange={(e) => setHint(e.target.value)}
        placeholder="Anything that would help place this? (optional)"
        className="epic-decision-input"
        disabled={submitting}
      />

      {localError && <div className="epic-decision-error">{localError}</div>}

      <div className="epic-decision-actions">
        <button
          type="button"
          className="epic-decision-btn epic-decision-btn-primary"
          disabled={submitting || !hint.trim()}
          onClick={() => respond(hint.trim())}
        >
          Submit
        </button>
        <button
          type="button"
          className="epic-decision-btn"
          disabled={submitting}
          onClick={() => respond("")}
        >
          Skip
        </button>
      </div>
    </div>
  );
}

export default function EpicDecisionsPanel({ epics, decisions, sessionId, onDecisionUpdate }) {
  const safeEpics = Array.isArray(epics) ? epics : [];
  const safeDecisions = Array.isArray(decisions) ? decisions : [];

  // Every real epic (skip SIMPLE-requirement placeholders, which have no
  // title/description to match against) gets a row here — not just the
  // ambiguous ones. Static rows use the plain-English `note` the backend
  // already generated (see agents/backlog_agent.py _resolve_epic_placement);
  // rows with an open decision render the interactive ask-once card instead.
  const rows = safeEpics
    .map((epic, epicIndex) => ({ epic, epicIndex }))
    .filter(({ epic }) => !epic.placeholder && epic.placement);

  if (rows.length === 0) {
    return null;
  }

  const outstanding = safeDecisions.filter((d) => !d.answered).length;

  return (
    <div className="epic-decisions-panel">
      <div className="epic-decisions-header">
        Epic &amp; SAD findings
        {outstanding > 0 && (
          <span className="epic-decisions-count">{outstanding}</span>
        )}
      </div>
      <div className="epic-decisions-list">
        {rows.map(({ epic, epicIndex }) => {
          const decision = safeDecisions.find((d) => d.epic_index === epicIndex);

          if (decision) {
            return (
              <DecisionCard
                key={decision.decision_id}
                decision={decision}
                sessionId={sessionId}
                onResolved={(updatedDecision, updatedEpic) =>
                  onDecisionUpdate(updatedDecision, updatedEpic)
                }
              />
            );
          }

          const status = epic.placement?.status;
          const icon =
            status === "reuse_epic" ? "🔗" : status === "new" ? "🆕" : "•";

          return (
            <div key={epicIndex} className="epic-decision-card epic-decision-card-done">
              <div className="epic-decision-title">{epic.title}</div>
              <div className="epic-decision-outcome">
                {icon} {epic.placement?.note}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
