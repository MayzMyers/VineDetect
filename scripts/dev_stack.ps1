param(
  [ValidateSet("start", "restart", "run", "stop", "status", "tail")]
  [string]$Action = "status",
  [int]$ApiPort = 8000,
  [int]$WebPort = 3000,
  [int]$RecognizePort = 4001,
  [switch]$CleanPorts,
  [int]$WaitSeconds = 45
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$RepoRoot = (Resolve-Path "$PSScriptRoot\..").Path
$ApiDir = Join-Path $RepoRoot "vinedetect_api"
$WebDir = Join-Path $RepoRoot "vinedetect_web"
$RecognizeDir = Join-Path $RepoRoot "recognize-service"
$LogRoot = Join-Path $RepoRoot ".dev_logs"
$CurrentLogDir = Join-Path $LogRoot "current"
$StatePath = Join-Path $CurrentLogDir "state.json"
$ApiOut = Join-Path $CurrentLogDir "api.out.log"
$ApiErr = Join-Path $CurrentLogDir "api.err.log"
$WebOut = Join-Path $CurrentLogDir "web.out.log"
$WebErr = Join-Path $CurrentLogDir "web.err.log"
$RecognizeOut = Join-Path $CurrentLogDir "recognize.out.log"
$RecognizeErr = Join-Path $CurrentLogDir "recognize.err.log"
$StackLog = Join-Path $CurrentLogDir "stack.log"
$ActivityLogDir = Join-Path $LogRoot "activity"
$ActivitySessionId = $null
$ActivityLogPath = $null

function New-LogDir {
  New-Item -ItemType Directory -Force -Path $CurrentLogDir | Out-Null
  New-Item -ItemType Directory -Force -Path $ActivityLogDir | Out-Null
}

function Write-StackLog {
  param([string]$Message)
  New-LogDir
  $Line = "$(Get-Date -Format o) $Message"
  Write-Host $Line
  Add-Content -LiteralPath $StackLog -Value $Line
}

function Clear-LogFile {
  param([string]$Path)

  try {
    "" | Set-Content -LiteralPath $Path -ErrorAction Stop
  } catch {
    Write-Host "log_clear_skipped path=$Path error=$($_.Exception.Message)"
  }
}

function Get-PortPids {
  param([int]$Port)
  $Lines = netstat -ano | Select-String ":$Port"
  $Pids = @()
  foreach ($Line in $Lines) {
    $Text = $Line.ToString().Trim()
    if ($Text -match "LISTENING\s+(\d+)$") {
      $Pids += [int]$Matches[1]
    }
  }
  return $Pids | Sort-Object -Unique
}

function Stop-PidList {
  param([int[]]$Pids, [string]$Reason)
  foreach ($ProcessId in $Pids) {
    if ($ProcessId -le 0) { continue }
    try {
      Write-StackLog "stopping pid=$ProcessId reason=$Reason"
      Stop-Process -Id $ProcessId -Force -ErrorAction Stop
    } catch {
      Write-StackLog "stop_failed pid=$ProcessId error=$($_.Exception.Message)"
    }
  }
}

function Get-ProjectDevPids {
  try {
    $Processes = Get-CimInstance Win32_Process -ErrorAction Stop |
      Where-Object {
        $_.CommandLine -and
        $_.CommandLine.Contains($WebDir) -and
        ($_.CommandLine -match "next|npm|node")
      }
  } catch {
    Write-StackLog "project_dev_pid_lookup_skipped error=$($_.Exception.Message)"
    return @()
  }

  return $Processes |
    Select-Object -ExpandProperty ProcessId |
    Sort-Object -Unique
}

function Stop-Stack {
  if (Test-Path $StatePath) {
    $State = Get-Content -LiteralPath $StatePath | ConvertFrom-Json
    Stop-PidList -Pids @($State.apiPid, $State.webPid, $State.recognizePid) -Reason "state_file"
    if ($State.apiPort) {
      Stop-PidList -Pids @(Get-PortPids -Port ([int]$State.apiPort)) -Reason "state_api_port_$($State.apiPort)"
    }
    if ($State.webPort) {
      Stop-PidList -Pids @(Get-PortPids -Port ([int]$State.webPort)) -Reason "state_web_port_$($State.webPort)"
    }
    if ($State.recognizePort) {
      Stop-PidList -Pids @(Get-PortPids -Port ([int]$State.recognizePort)) -Reason "state_recognize_port_$($State.recognizePort)"
    }
  }

  if ($CleanPorts) {
    Stop-PidList -Pids @(Get-PortPids -Port $ApiPort) -Reason "api_port_$ApiPort"
    Stop-PidList -Pids @(Get-PortPids -Port $WebPort) -Reason "web_port_$WebPort"
    Stop-PidList -Pids @(Get-PortPids -Port $RecognizePort) -Reason "recognize_port_$RecognizePort"
    Stop-PidList -Pids @(Get-ProjectDevPids) -Reason "next_project_dev"
  }
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
    if ($Result.Ok) { return $Result }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $Deadline)
  return $Result
}

function Get-WinesSummary {
  param($Response)
  if (-not $Response.Ok) {
    return "status=$($Response.StatusCode) ok=False body=$($Response.Content)"
  }

  try {
    $Json = $Response.Content | ConvertFrom-Json
    $Items = @($Json.items | Select-Object -First 3 | ForEach-Object { "$($_.id):$($_.slug)" })
    return "status=$($Response.StatusCode) ok=True total=$($Json.total) first=$($Items -join ',')"
  } catch {
    return "status=$($Response.StatusCode) ok=True body=$($Response.Content.Substring(0, [Math]::Min(240, $Response.Content.Length)))"
  }
}

function Get-CatalogSummary {
  param($Response)
  if (-not $Response.Ok) {
    return "status=$($Response.StatusCode) ok=False body=$($Response.Content)"
  }

  try {
    $Json = $Response.Content | ConvertFrom-Json
    $Items = @($Json.items | Select-Object -First 3 | ForEach-Object { "$($_.source):$($_.external_id)" })
    return "status=$($Response.StatusCode) ok=True count=$($Json.count) first=$($Items -join ',')"
  } catch {
    return "status=$($Response.StatusCode) ok=True body=$($Response.Content.Substring(0, [Math]::Min(240, $Response.Content.Length)))"
  }
}

function Test-Database {
  $Probe = @"
import os
from dotenv import load_dotenv
import psycopg

load_dotenv(r"$ApiDir\.env")
url = os.environ["DATABASE_URL"]
with psycopg.connect(url, connect_timeout=5) as conn:
    db, user = conn.execute("select current_database(), current_user").fetchone()
    wines = conn.execute("select count(*) from wines").fetchone()[0]
    migrations = conn.execute("select count(*) from schema_migrations").fetchone()[0]
print(f"db={db} user={user} wines={wines} migrations={migrations}")
"@
  $Probe | & (Join-Path $ApiDir ".venv\Scripts\python.exe") -
}

function Get-SampleAssetPath {
  $Probe = @"
import os
from dotenv import load_dotenv
import psycopg

load_dotenv(r"$ApiDir\.env")
url = os.environ["DATABASE_URL"]
with psycopg.connect(url, connect_timeout=5) as conn:
    row = conn.execute("""
        SELECT image_local_path
        FROM roskachestvo.products
        WHERE image_local_path IS NOT NULL
          AND image_local_path <> ''
        LIMIT 1
    """).fetchone()
print(row[0] if row else "")
"@
  $Probe | & (Join-Path $ApiDir ".venv\Scripts\python.exe") -
}

function Get-AssetUrl {
  param([string]$LocalPath, [int]$Port)
  $NormalizedPath = $LocalPath.Replace("\", "/")
  if ($NormalizedPath.StartsWith("data/")) {
    return "http://127.0.0.1:$Port/assets/data/$($NormalizedPath.Substring(5))"
  }
  if ($NormalizedPath.StartsWith("storage/")) {
    return "http://127.0.0.1:$Port/assets/storage/$($NormalizedPath.Substring(8))"
  }
  if ($NormalizedPath.StartsWith("roskachestvo/")) {
    return "http://127.0.0.1:$Port/assets/storage/$NormalizedPath"
  }
  return $null
}

function Get-NpmPath {
  $NpmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($NpmCommand) {
    return $NpmCommand.Source
  }
  return "C:\Program Files\nodejs\npm.cmd"
}

function Convert-ToPsSingleQuoted {
  param([string]$Value)
  return "'" + $Value.Replace("'", "''") + "'"
}

function New-EnvCommand {
  param(
    [hashtable]$Environment,
    [string]$Executable,
    [string[]]$Arguments
  )

  $Parts = @()
  foreach ($Key in $Environment.Keys) {
    $Parts += "`$env:$Key = $(Convert-ToPsSingleQuoted ([string]$Environment[$Key]))"
  }
  $ArgumentText = ($Arguments | ForEach-Object { Convert-ToPsSingleQuoted $_ }) -join ", "
  $Parts += "& $(Convert-ToPsSingleQuoted $Executable) @($ArgumentText)"
  return $Parts -join "; "
}

function Start-Stack {
  New-LogDir
  $script:ActivitySessionId = "$(Get-Date -Format 'yyyyMMdd_HHmmss')-$PID"
  $script:ActivityLogPath = Join-Path $ActivityLogDir "ui-activity-$($script:ActivitySessionId).jsonl"
  Clear-LogFile -Path $ApiOut
  Clear-LogFile -Path $ApiErr
  Clear-LogFile -Path $WebOut
  Clear-LogFile -Path $WebErr
  Clear-LogFile -Path $RecognizeOut
  Clear-LogFile -Path $RecognizeErr
  Clear-LogFile -Path $StackLog

  Write-StackLog "database_check_start"
  $DbResult = Test-Database
  Write-StackLog "database_check $DbResult"

  Write-StackLog "starting_api port=$ApiPort"
  $ApiProcess = Start-Process `
    -FilePath (Join-Path $ApiDir ".venv\Scripts\python.exe") `
    -ArgumentList @("-m", "uvicorn", "app.api.application:app", "--host", "127.0.0.1", "--port", "$ApiPort") `
    -WorkingDirectory $ApiDir `
    -RedirectStandardOutput $ApiOut `
    -RedirectStandardError $ApiErr `
    -PassThru

  $Health = Wait-Http -Url "http://127.0.0.1:$ApiPort/health" -TimeoutSeconds $WaitSeconds
  Write-StackLog "api_health status=$($Health.StatusCode) ok=$($Health.Ok) body=$($Health.Content)"

  $Wines = Test-Http -Url "http://127.0.0.1:$ApiPort/api/v1/wines?limit=3&offset=0"
  Write-StackLog "api_wines $(Get-WinesSummary -Response $Wines)"

  $Catalog = Test-Http -Url "http://127.0.0.1:$ApiPort/api/v1/catalog?source=all&limit=3&offset=0"
  Write-StackLog "api_catalog $(Get-CatalogSummary -Response $Catalog)"

  $Npm = Get-NpmPath

  Write-StackLog "starting_recognize port=$RecognizePort"
  $RecognizeCommand = New-EnvCommand `
    -Environment @{
      "DATABASE_URL" = "postgresql://postgres:admin@localhost:5432/wines"
      "PORT" = "$RecognizePort"
      "INTERNAL_API_KEY" = "development-secret"
      "ASSET_ROOT" = "..\asset-store"
      "WORKER_ENABLED" = "true"
      "WORKER_POLL_INTERVAL_MS" = "1000"
      "WORKER_CONCURRENCY" = "2"
    } `
    -Executable $Npm `
    -Arguments @("run", "dev")
  $RecognizeProcess = Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $RecognizeCommand) `
    -WorkingDirectory $RecognizeDir `
    -RedirectStandardOutput $RecognizeOut `
    -RedirectStandardError $RecognizeErr `
    -PassThru

  $RecognizeHealth = Wait-Http -Url "http://127.0.0.1:$RecognizePort/health" -TimeoutSeconds $WaitSeconds
  Write-StackLog "recognize_health status=$($RecognizeHealth.StatusCode) ok=$($RecognizeHealth.Ok) body=$($RecognizeHealth.Content)"

  Write-StackLog "starting_web port=$WebPort"
  $WebCommand = New-EnvCommand `
    -Environment @{
      "NEXT_PUBLIC_API_BASE_URL" = "http://127.0.0.1:$ApiPort"
      "RECOGNIZE_SERVICE_URL" = "http://127.0.0.1:$RecognizePort"
      "RECOGNIZE_INTERNAL_API_KEY" = "development-secret"
      "DEV_ACTIVITY_LOG_ENABLED" = "true"
      "DEV_ACTIVITY_LOG_DIR" = $ActivityLogDir
      "DEV_ACTIVITY_SESSION_ID" = $script:ActivitySessionId
      "NEXT_PUBLIC_ACTIVITY_LOG_ENABLED" = "true"
    } `
    -Executable $Npm `
    -Arguments @("run", "dev", "--", "--hostname", "127.0.0.1", "--port", "$WebPort")
  $WebProcess = Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $WebCommand) `
    -WorkingDirectory $WebDir `
    -RedirectStandardOutput $WebOut `
    -RedirectStandardError $WebErr `
    -PassThru

  $Admin = Wait-Http -Url "http://127.0.0.1:$WebPort/admin" -TimeoutSeconds $WaitSeconds
  Write-StackLog "web_admin status=$($Admin.StatusCode) ok=$($Admin.Ok) body=$($Admin.Content.Substring(0, [Math]::Min(160, $Admin.Content.Length)))"

  $SampleAssetPath = Get-SampleAssetPath
  $SampleAssetUrl = "http://127.0.0.1:$WebPort/api/admin/assets/$($SampleAssetPath.Replace('\', '/'))"
  if ($SampleAssetPath) {
    $Asset = Test-Http -Url $SampleAssetUrl
    Write-StackLog "web_asset status=$($Asset.StatusCode) ok=$($Asset.Ok) path=$SampleAssetPath"
  }

  $ApiListenPid = @(Get-PortPids -Port $ApiPort | Select-Object -First 1)[0]
  $WebListenPid = @(Get-PortPids -Port $WebPort | Select-Object -First 1)[0]
  $RecognizeListenPid = @(Get-PortPids -Port $RecognizePort | Select-Object -First 1)[0]
  if (-not $ApiListenPid) { $ApiListenPid = $ApiProcess.Id }
  if (-not $WebListenPid) { $WebListenPid = $WebProcess.Id }
  if (-not $RecognizeListenPid) { $RecognizeListenPid = $RecognizeProcess.Id }

  [PSCustomObject]@{
    startedAt = (Get-Date).ToString("o")
    apiPid = $ApiListenPid
    webPid = $WebListenPid
    recognizePid = $RecognizeListenPid
    apiPort = $ApiPort
    webPort = $WebPort
    recognizePort = $RecognizePort
    apiUrl = "http://127.0.0.1:$ApiPort"
    recognizeUrl = "http://127.0.0.1:$RecognizePort"
    adminUrl = "http://127.0.0.1:$WebPort/admin"
    logDir = $CurrentLogDir
    activitySessionId = $script:ActivitySessionId
    activityLog = $script:ActivityLogPath
  } | ConvertTo-Json | Set-Content -LiteralPath $StatePath

  Write-StackLog "stack_ready admin=http://127.0.0.1:$WebPort/admin api=http://127.0.0.1:$ApiPort recognize=http://127.0.0.1:$RecognizePort logs=$CurrentLogDir activity_log=$($script:ActivityLogPath)"
}

function Show-Status {
  Write-Host "ports:"
  netstat -ano | Select-String ":$WebPort|:$ApiPort|:$RecognizePort|:5432"
  Write-Host ""
  Write-Host "database:"
  try { Test-Database } catch { Write-Host "database_error $($_.Exception.Message)" }
  Write-Host ""
  Write-Host "api:"
  $Health = Test-Http -Url "http://127.0.0.1:$ApiPort/health"
  Write-Host "health status=$($Health.StatusCode) ok=$($Health.Ok) body=$($Health.Content)"
  $Wines = Test-Http -Url "http://127.0.0.1:$ApiPort/api/v1/wines?limit=3&offset=0"
  Write-Host "wines $(Get-WinesSummary -Response $Wines)"
  $Catalog = Test-Http -Url "http://127.0.0.1:$ApiPort/api/v1/catalog?source=all&limit=3&offset=0"
  Write-Host "catalog $(Get-CatalogSummary -Response $Catalog)"
  $SampleAssetPath = Get-SampleAssetPath
  if ($SampleAssetPath) {
    $SampleAssetUrl = "http://127.0.0.1:$WebPort/api/admin/assets/$($SampleAssetPath.Replace('\', '/'))"
    $Asset = Test-Http -Url $SampleAssetUrl
    Write-Host "asset status=$($Asset.StatusCode) ok=$($Asset.Ok) path=$SampleAssetPath"
  }
  Write-Host ""
  Write-Host "recognize:"
  $RecognizeHealth = Test-Http -Url "http://127.0.0.1:$RecognizePort/health"
  Write-Host "health status=$($RecognizeHealth.StatusCode) ok=$($RecognizeHealth.Ok) body=$($RecognizeHealth.Content)"
  Write-Host ""
  Write-Host "web:"
  $Admin = Test-Http -Url "http://127.0.0.1:$WebPort/admin"
  Write-Host "admin status=$($Admin.StatusCode) ok=$($Admin.Ok)"
  Write-Host ""
  if (Test-Path $StatePath) {
    Write-Host "state:"
    Get-Content -LiteralPath $StatePath
  }
  Write-Host "logs=$CurrentLogDir"
}

function Show-Tail {
  if (-not (Test-Path $CurrentLogDir)) {
    Write-Host "No logs yet."
    return
  }
  Write-Host "== stack.log =="
  if (Test-Path $StackLog) { Get-Content -LiteralPath $StackLog -Tail 80 }
  Write-Host "== api.err.log =="
  if (Test-Path $ApiErr) { Get-Content -LiteralPath $ApiErr -Tail 80 }
  Write-Host "== web.err.log =="
  if (Test-Path $WebErr) { Get-Content -LiteralPath $WebErr -Tail 80 }
  Write-Host "== recognize.err.log =="
  if (Test-Path $RecognizeErr) { Get-Content -LiteralPath $RecognizeErr -Tail 80 }
  Write-Host "== recognize.out.log =="
  if (Test-Path $RecognizeOut) { Get-Content -LiteralPath $RecognizeOut -Tail 80 }
  Write-Host "== web.out.log =="
  if (Test-Path $WebOut) { Get-Content -LiteralPath $WebOut -Tail 80 }
  if (Test-Path $StatePath) {
    $State = Get-Content -LiteralPath $StatePath | ConvertFrom-Json
    if ($State.activityLog -and (Test-Path $State.activityLog)) {
      Write-Host "== activity.log =="
      Get-Content -LiteralPath $State.activityLog -Tail 120
    }
  }
}

function Watch-Stack {
  Write-Host ""
  Write-Host "Stack is running. Press Ctrl+C in this terminal to stop API and web."
  Write-Host "Admin: http://127.0.0.1:$WebPort/admin"
  Write-Host "API:   http://127.0.0.1:$ApiPort"
  Write-Host "Recognize: http://127.0.0.1:$RecognizePort"
  Write-Host "Logs:  $CurrentLogDir"
  Write-Host "UI activity: $ActivityLogPath"
  Write-Host ""

  $LastApiErr = 0
  $LastWebErr = 0
  $LastWebOut = 0
  $LastRecognizeErr = 0
  $LastRecognizeOut = 0

  try {
    while ($true) {
      if (Test-Path $ApiErr) {
        $Lines = @(Get-Content -LiteralPath $ApiErr)
        if ($Lines.Count -gt $LastApiErr) {
          $Lines[$LastApiErr..($Lines.Count - 1)] | ForEach-Object { Write-Host "[api] $_" }
          $LastApiErr = $Lines.Count
        }
      }

      if (Test-Path $WebErr) {
        $Lines = @(Get-Content -LiteralPath $WebErr)
        if ($Lines.Count -gt $LastWebErr) {
          $Lines[$LastWebErr..($Lines.Count - 1)] | ForEach-Object { Write-Host "[web:err] $_" }
          $LastWebErr = $Lines.Count
        }
      }

      if (Test-Path $WebOut) {
        $Lines = @(Get-Content -LiteralPath $WebOut)
        if ($Lines.Count -gt $LastWebOut) {
          $Lines[$LastWebOut..($Lines.Count - 1)] | ForEach-Object { Write-Host "[web] $_" }
          $LastWebOut = $Lines.Count
        }
      }

      if (Test-Path $RecognizeErr) {
        $Lines = @(Get-Content -LiteralPath $RecognizeErr)
        if ($Lines.Count -gt $LastRecognizeErr) {
          $Lines[$LastRecognizeErr..($Lines.Count - 1)] | ForEach-Object { Write-Host "[recognize:err] $_" }
          $LastRecognizeErr = $Lines.Count
        }
      }

      if (Test-Path $RecognizeOut) {
        $Lines = @(Get-Content -LiteralPath $RecognizeOut)
        if ($Lines.Count -gt $LastRecognizeOut) {
          $Lines[$LastRecognizeOut..($Lines.Count - 1)] | ForEach-Object { Write-Host "[recognize] $_" }
          $LastRecognizeOut = $Lines.Count
        }
      }

      Start-Sleep -Seconds 2
    }
  } finally {
    Stop-Stack
    Write-StackLog "stack_stopped"
  }
}

if ($Action -eq "stop") {
  Stop-Stack
  Write-StackLog "stack_stopped"
} elseif ($Action -eq "restart") {
  Stop-Stack
  Start-Sleep -Seconds 1
  Start-Stack
  Show-Status
} elseif ($Action -eq "run") {
  $CleanPorts = $true
  Stop-Stack
  Start-Sleep -Seconds 1
  Start-Stack
  Show-Status
  Watch-Stack
} elseif ($Action -eq "start") {
  Start-Stack
  Show-Status
} elseif ($Action -eq "tail") {
  Show-Tail
} else {
  Show-Status
}
