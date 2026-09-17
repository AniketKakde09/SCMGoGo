# PowerShell test script for local docker stack (repo root)
# Runs basic smoke tests for backend and frontend

Write-Host "Checking backend health..."
try {
  $h = Invoke-RestMethod -Uri 'http://localhost:8000/health' -TimeoutSec 5
  Write-Host "Backend /health:" (ConvertTo-Json $h -Compress)
} catch {
  Write-Host "Backend /health failed:" $_.Exception.Message
}

Write-Host "Checking backend security status..."
try {
  $s = Invoke-RestMethod -Uri 'http://localhost:8000/security/status' -TimeoutSec 5
  Write-Host "Backend /security/status:" (ConvertTo-Json $s -Compress)
} catch {
  Write-Host "Backend /security/status failed:" $_.Exception.Message
}

Write-Host "Checking frontend root..."
try {
  $f = Invoke-WebRequest -Uri 'http://localhost:8080' -TimeoutSec 5
  Write-Host "Frontend returned status:" $f.StatusCode
} catch {
  Write-Host "Frontend root failed:" $_.Exception.Message
}

Write-Host "Checking frontend issues API (GET /api/issues)..."
try {
  $i = Invoke-RestMethod -Uri 'http://localhost:8080/api/issues' -TimeoutSec 5
  Write-Host "Frontend /api/issues returned:" (ConvertTo-Json $i -Compress)
} catch {
  Write-Host "Frontend /api/issues failed:" $_.Exception.Message
}

Write-Host "Done."