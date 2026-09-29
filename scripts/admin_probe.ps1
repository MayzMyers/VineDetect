param(
  [string]$RepoRoot = (Resolve-Path "$PSScriptRoot\..").Path,
  [int]$ApiPort = 8000,
  [int]$WebPort = 3000,
  [int]$WaitSeconds = 35
)

$ErrorActionPreference = "Stop"

$ApiDir = Join-Path $RepoRoot "vinedetect_api"
$WebDir = Join-Path $RepoRoot "vinedetect_web"
$LogDir = Join-Path $RepoRoot ".probe_logs"
$Stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$RunDir = Join-Path $LogDir "admin_probe_$Stamp"
New-Item -ItemType Directory -Force -Path $RunDir | Out-Null

$ProbeLog = Join-Path $RunDir "probe.log"
$ApiOut = Join-Path $RunDir "api.out.log"
$ApiErr = Join-Path $RunDir "api.err.log"
$WebOut = Join-Path $RunDir "web.out.log"
$WebErr = Join-Path $RunDir "web.err.log"

function Write-ProbeLog {
  param([string]$Message)
  $Line = "$(Get-Date -Format o) $Message"
  Write-Host $Line
  Add-Content -LiteralPath $ProbeLog -Value $Line
}

function Test-Http {
  param([string]$Url)
  try {
    $Response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 10
    return [PSCustomObject]@{
      Ok = $true
      StatusCode = [int]$Response.StatusCode
      Content = $Response.Content
    }
  } catch {
    $Status = $null
    if ($_.Exception.Response) {
      $Status = [int]$_.Exception.Response.StatusCode
    }
    return [PSCustomObject]@{
      Ok = $false
      StatusCode = $Status
      Content = $_.Exception.Message
    }
  }
}

function Wait-Http {
  param([string]$Url, [int]$TimeoutSeconds)
  $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $Result = Test-Http -Url $Url
    if ($Result.Ok) {
      return $Result
    }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $Deadline)
  return $Result
}

Write-ProbeLog "probe_start repo=$RepoRoot"
Write-ProbeLog "api_dir=$ApiDir"
Write-ProbeLog "web_dir=$WebDir"

Write-ProbeLog "database_probe_start"
$EnvPath = Join-Path $ApiDir ".env"
$DbProbe = @"
import os
from dotenv import load_dotenv
import psycopg

load_dotenv(r"$EnvPath")
url = os.environ["DATABASE_URL"]
print(f"DATABASE_URL={url}")
with psycopg.connect(url, connect_timeout=5) as conn:
    print("db", conn.execute("select current_database(), current_user").fetchone())
    print("wines", conn.execute("select count(*) from wines").fetchone()[0])
    print("migrations", conn.execute("select count(*) from schema_migrations").fetchone()[0])
"@
$DbProbe | & (Join-Path $ApiDir ".venv\Scripts\python.exe") - 2>&1 | Tee-Object -FilePath (Join-Path $RunDir "db_probe.log")

Write-ProbeLog "starting_api"
$ApiProcess = Start-Process `
  -FilePath (Join-Path $ApiDir ".venv\Scripts\python.exe") `
  -ArgumentList @("-m", "uvicorn", "app.api.application:app", "--host", "127.0.0.1", "--port", "$ApiPort") `
  -WorkingDirectory $ApiDir `
  -RedirectStandardOutput $ApiOut `
  -RedirectStandardError $ApiErr `
  -PassThru

try {
  $Health = Wait-Http -Url "http://127.0.0.1:$ApiPort/health" -TimeoutSeconds $WaitSeconds
  Write-ProbeLog "api_health status=$($Health.StatusCode) ok=$($Health.Ok) body=$($Health.Content)"

  $Wines = Test-Http -Url "http://127.0.0.1:$ApiPort/api/v1/wines?limit=3&offset=0"
  Write-ProbeLog "api_wines status=$($Wines.StatusCode) ok=$($Wines.Ok) body=$($Wines.Content)"

  $ExistingAdmin = Test-Http -Url "http://127.0.0.1:3000/admin"
  if ($ExistingAdmin.Ok) {
    Write-ProbeLog "web_admin_existing status=$($ExistingAdmin.StatusCode) ok=$($ExistingAdmin.Ok) url=http://127.0.0.1:3000/admin"
  } else {
    Write-ProbeLog "starting_web"
    $WebProcess = Start-Process `
      -FilePath "cmd.exe" `
      -ArgumentList @("/c", "npm run dev -- --hostname 127.0.0.1 --port $WebPort") `
      -WorkingDirectory $WebDir `
      -RedirectStandardOutput $WebOut `
      -RedirectStandardError $WebErr `
      -PassThru

    try {
      $Admin = Wait-Http -Url "http://127.0.0.1:$WebPort/admin" -TimeoutSeconds $WaitSeconds
      Write-ProbeLog "web_admin status=$($Admin.StatusCode) ok=$($Admin.Ok)"
      if (-not $Admin.Ok) {
        Write-ProbeLog "web_admin_error body=$($Admin.Content)"
      }
    } finally {
      Write-ProbeLog "stopping_web pid=$($WebProcess.Id)"
      Stop-Process -Id $WebProcess.Id -Force -ErrorAction SilentlyContinue
    }
  }
} finally {
  Write-ProbeLog "stopping_api pid=$($ApiProcess.Id)"
  Stop-Process -Id $ApiProcess.Id -Force -ErrorAction SilentlyContinue
  Write-ProbeLog "probe_done logs=$RunDir"
}
