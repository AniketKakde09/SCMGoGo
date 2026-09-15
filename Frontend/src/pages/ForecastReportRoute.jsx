import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { generateForecast } from "../services/api";
import ForecastReport from "./ForecastReport";

// =========================================================
// Route container for /report
//
// Keeps data-loading out of the report component.
//
// The dataset id comes from whichever of these is available:
//   1. navigate("/report", { state: { datasetId } })
//   2. ?dataset=<id> in the URL, so a report can be linked or
//      bookmarked
//   3. localStorage "foremanDatasetId", set by the upload flow
//
// If the caller already has the forecast in hand (the canvas
// does — it fetches one on load), it can pass it straight
// through as state.report and no second request is made:
//   navigate("/report", { state: { report, datasetId } });
//
// Otherwise this calls POST /datasets/{id}/forecast itself.
// =========================================================

export default function ForecastReportRoute() {
  const navigate = useNavigate();
  const location = useLocation();

  const datasetId =
    location.state?.datasetId ||
    new URLSearchParams(location.search).get("dataset") ||
    localStorage.getItem("foremanDatasetId") ||
    "";

  const passedReport = location.state?.report || null;

  const [report, setReport] = useState(passedReport);
  const [loading, setLoading] = useState(!passedReport && Boolean(datasetId));
  const [error, setError] = useState(
    !passedReport && !datasetId
      ? "No dataset selected. Upload a workbook, then open the report from there."
      : "",
  );

  const run = useCallback(async () => {
    if (!datasetId) return;

    setLoading(true);
    setError("");

    try {
      const data = await generateForecast(datasetId);
      setReport(data);
    } catch (err) {
      setError(err.message || "The forecast request failed.");
    } finally {
      setLoading(false);
    }
  }, [datasetId]);

  useEffect(() => {
    if (!passedReport && datasetId) run();
    // Only re-runs when the dataset changes; a report handed in
    // via navigation state is used as-is.
  }, [datasetId, passedReport, run]);

  return (
    <ForecastReport
      report={report}
      loading={loading}
      error={error}
      onRetry={datasetId ? run : null}
      onBack={() => navigate(datasetId ? "/canvas" : "/upload")}
    />
  );
}
