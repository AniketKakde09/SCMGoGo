# Foreman Forecast API — Usage Guide

This version adds a **dataset-driven delivery forecast API** to the existing FastAPI application.

The application is still started exactly as before:

```bash
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

No separate FastAPI service is created.

## 1. What the forecast does

The forecast combines two stages:

1. **Velocity forecast**
   - Reads completed sprint history from the Excel dataset.
   - Calculates average and median completed story points.
   - Calculates recent velocity and historical capacity utilization.
   - Blends recent empirical velocity with `Teams.BaseVelocityPts`.
   - Produces a transparent heuristic confidence score.

2. **OR-Tools CP-SAT optimization**
   - Uses the forecast velocity as expected delivery capacity.
   - Respects sprint capacity.
   - Prioritizes higher-value/higher-priority work.
   - Prefers earlier delivery.
   - Enforces dependencies between open tickets.
   - Supports cross-team dependency sequencing by solving all teams jointly.
   - Detects dependency cycles.
   - Adjusts forecast capacity for team-specific holidays.

The API derives its inputs from the uploaded `dataset.xlsx`; the caller does **not** provide velocity, capacity, sprint count, or ticket lists.

## 2. Required Python package

Install all dependencies:

```bash
pip install -r requirements.txt
```

`requirements-api.txt` also includes the main requirements file:

```bash
pip install -r requirements-api.txt
```

OR-Tools is required for the forecast endpoint:

```bash
pip install "ortools>=9.12.0"
```

If installation fails because your Python version/platform has no compatible OR-Tools wheel, use a supported Python version and recreate the virtual environment.

## 3. Start the API

From the project root:

```bash
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

Health check:

```bash
curl http://localhost:8000/health
```

Expected:

```json
{"status":"ok"}
```

Swagger UI:

```text
http://localhost:8000/docs
```

The new endpoint appears as:

```text
POST /datasets/{dataset_id}/forecast
```

## 4. Test with a new dataset upload

### Linux/macOS/Git Bash

Upload the Excel dataset:

```bash
curl -X POST http://localhost:8000/datasets \
  -F "file=@data/Foreman_Synthetic_Dataset.xlsx"
```

The response contains a `dataset_id`:

```json
{
  "dataset_id": "<DATASET_ID>",
  "status": "ingesting",
  "message": "Dataset uploaded. Ingestion is running in the background."
}
```

Set it in your shell:

```bash
DATASET_ID="<DATASET_ID>"
```

Poll until the dataset is ready:

```bash
curl http://localhost:8000/datasets/$DATASET_ID
```

You need:

```json
"status": "ready"
```

Then run the forecast:

```bash
curl -X POST http://localhost:8000/datasets/$DATASET_ID/forecast
```

The endpoint has **no request body**.

## 5. Windows PowerShell commands

Upload:

```powershell
$response = Invoke-RestMethod -Method Post `
  -Uri "http://localhost:8000/datasets" `
  -Form @{ file = Get-Item ".\data\Foreman_Synthetic_Dataset.xlsx" }

$datasetId = $response.dataset_id
$datasetId
```

Check status:

```powershell
Invoke-RestMethod -Method Get `
  -Uri "http://localhost:8000/datasets/$datasetId"
```

Run forecast:

```powershell
$forecast = Invoke-RestMethod -Method Post `
  -Uri "http://localhost:8000/datasets/$datasetId/forecast"

$forecast | ConvertTo-Json -Depth 20
```

Alternatively, with `curl.exe`:

```powershell
curl.exe -X POST http://localhost:8000/datasets/$datasetId/forecast
```

## 6. Test an existing dataset already marked ready

If the project already contains the sample dataset workspace and its metadata says `ready`, you can call:

```bash
curl -X POST http://localhost:8000/datasets/2e4736a5982e46ebbe98e94efb645017/forecast
```

If the response is `409 Dataset is not ready`, upload/re-ingest the Excel file and wait for the status to become `ready`.

## 7. Response structure

The response is JSON and contains:

```text
forecast_version
method
summary
optimization
teams[]
```

At the top level:

- `summary.total_open_points` — total open story/task points.
- `summary.total_points_scheduled` — points placed into forecast sprints.
- `summary.total_remaining_points` — points that could not be scheduled in the generated horizon.
- `summary.scheduled_points_percent` — percentage scheduled.
- `summary.optimization_status` — OR-Tools result such as `OPTIMAL` or `FEASIBLE`.
- `summary.dependency_cycles` — detected open dependency cycles.

Each team contains:

```text
team_id
team_name
product_service
velocity_forecast
backlog
forecast
forecast_calendar
risks
```

### Velocity output

Example fields:

```json
{
  "completed_sprints_used": 2,
  "average_completed_points": 36.5,
  "median_completed_points": 36.5,
  "recent_average_points": 36.5,
  "base_velocity_points": 32.0,
  "forecast_velocity_points": 35.15,
  "trend": "increasing",
  "confidence": 0.85
}
```

`confidence` is explicitly a **heuristic**, not a statistical probability.

### Forecast sprint output

Each scheduled sprint contains:

```json
{
  "sprint_id": "SPR-04",
  "start_date": "2026-08-18",
  "end_date": "2026-08-31",
  "capacity_points": 32.0,
  "planned_points": 30.0,
  "utilization": 0.938,
  "tickets": []
}
```

## 8. Important behavior

### All teams

The endpoint always evaluates every team present in the `Teams` sheet. If a team has no directly assigned open tickets, it is still returned with its velocity/calendar information.

### Ticket ownership

The forecast derives ticket ownership in this order:

1. `AssigneeID -> TeamMembers.TeamID`
2. `SprintID -> Sprints.TeamID`
3. Dataset team/product/layer matching for otherwise unassigned work

### Dependencies

The dataset convention is:

```text
FromTicketID -> ToTicketID (depends on)
```

Meaning the `FromTicketID` work depends on the `ToTicketID` work.

When both are open and forecastable, the prerequisite must be scheduled in an earlier sprint.

Dependencies pointing to a completed ticket do not block the forecast.

Missing/out-of-scope dependency references are returned as risks rather than silently treated as satisfied.

### Dependency cycles

The API detects cycles using NetworkX and reports them in:

```text
summary.dependency_cycles
optimization.dependency_cycles
team[].risks
```

A cycle may prevent some work from being scheduled. This is intentional: the forecast should expose the delivery risk rather than silently break the dependency.

### Holidays

Team-specific holidays from the `Holidays` sheet reduce the capacity of affected forecast sprints.

## 9. Quick smoke-test sequence

Run these in order:

```bash
curl http://localhost:8000/health
```

```bash
curl -X POST http://localhost:8000/datasets \
  -F "file=@data/Foreman_Synthetic_Dataset.xlsx"
```

Poll:

```bash
curl http://localhost:8000/datasets/<DATASET_ID>
```

Then:

```bash
curl -X POST http://localhost:8000/datasets/<DATASET_ID>/forecast
```

## 10. Troubleshooting

### `ModuleNotFoundError: No module named 'ortools'`

Run:

```bash
pip install -r requirements.txt
```

or:

```bash
pip install "ortools>=9.12.0"
```

### `409 Dataset is not ready`

Check:

```bash
curl http://localhost:8000/datasets/<DATASET_ID>
```

Wait for:

```json
"status": "ready"
```

### `500 Forecast generation failed`

First check the API terminal for the complete exception. The most common causes are a malformed workbook or missing required sheets:

```text
Teams
TeamMembers
Sprints
Holidays
Backlog
Dependencies
```

### OR-Tools returns `FEASIBLE` instead of `OPTIMAL`

This is not necessarily a failure. CP-SAT can return a valid feasible solution when the optimization time limit is reached before proving optimality. The response exposes the solver status.

## 11. Recommended next step

Do not build the frontend yet.

First run the endpoint against the synthetic dataset and inspect:

1. team velocity
2. scheduled tickets
3. cross-team dependencies
4. dependency-cycle handling
5. completion sprint/date
6. remaining points
7. optimization status

Once those numbers look correct, the frontend can consume this JSON directly without changing the forecasting engine.
