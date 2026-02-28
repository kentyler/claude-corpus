# Corpus Server Startup Script

param(
    [int]$Port = 3002
)

Write-Host "Corpus Server" -ForegroundColor Cyan
Write-Host "=============" -ForegroundColor Cyan

# Load password from secrets.json
$secretsPath = Join-Path $PSScriptRoot "secrets.json"
if (Test-Path $secretsPath) {
    $secrets = Get-Content $secretsPath -Raw | ConvertFrom-Json
    $env:PGPASSWORD = $secrets.database.password
    Write-Host "Secrets loaded" -ForegroundColor Green
} else {
    Write-Host "No secrets.json found - LLM features will be disabled" -ForegroundColor Yellow
}

# Kill existing server on this port
Write-Host "Checking for existing server on port $Port..." -ForegroundColor Yellow
Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object {
        Write-Host "Stopping process PID: $_" -ForegroundColor Yellow
        Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
    }
Start-Sleep -Milliseconds 500

# Set port and start server
$env:PORT = $Port
Write-Host "Starting server on port $Port..." -ForegroundColor Yellow

Set-Location $PSScriptRoot\server
npm start
