[CmdletBinding()]
param(
    [ValidateSet("Start", "Capture", "Stop")]
    [string]$Action = "Start",
    [ValidateSet("roskachestvo", "svoe_vino")]
    [string]$Source,
    [string]$SourceItemId,
    [string]$AnnotationTrackId,
    [string]$JobId,
    [string]$RunDirectory,
    [string]$WebBaseUrl = "http://127.0.0.1:3000",
    [pscredential]$Credential
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$composeFiles = @(
    "-f", (Join-Path $repositoryRoot "compose.yaml"),
    "-f", (Join-Path $repositoryRoot "compose.dev.yaml")
)
$services = @("recognize", "llm-controller", "annotation-controller", "api", "web", "postgres")

function Resolve-DockerCli {
    $command = Get-Command docker -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $candidate = Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\resources\bin\docker.exe"
    if (Test-Path -LiteralPath $candidate) { return $candidate }
    throw "Docker CLI was not found. Start Docker Desktop and add its resources/bin directory to PATH."
}

function Assert-CardKey {
    param([string]$CardSource, [string]$ItemId, [string]$TrackId)
    if ($CardSource -notin @("roskachestvo", "svoe_vino")) { throw "Source is required." }
    if (-not $ItemId -or $ItemId -notmatch '^[A-Za-z0-9_.:-]+$') { throw "SourceItemId contains unsupported characters or is empty." }
    if ($TrackId -and $TrackId -notmatch '^[0-9a-fA-F-]{36}$') { throw "AnnotationTrackId must be a UUID." }
}

function Write-Utf8File {
    param([string]$Path, [string]$Content)
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

function Write-JsonFile {
    param([string]$Path, [object]$Value)
    Write-Utf8File -Path $Path -Content ($Value | ConvertTo-Json -Depth 100)
}

function Read-State {
    param([string]$Directory)
    if (-not $Directory) { throw "RunDirectory is required for $Action." }
    $resolved = [System.IO.Path]::GetFullPath($Directory)
    $statePath = Join-Path $resolved "run-state.json"
    if (-not (Test-Path -LiteralPath $statePath)) { throw "Run state was not found: $statePath" }
    return @{ Directory = $resolved; Path = $statePath; State = (Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json) }
}

function Save-State {
    param([string]$Path, [object]$State)
    Write-JsonFile -Path $Path -Value $State
}

function Invoke-Docker {
    param([string[]]$Arguments)
    $output = & $script:docker @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Docker command failed: $($output -join [Environment]::NewLine)" }
    return $output
}

function Capture-Database {
    param([string]$Directory, [string]$CardSource, [string]$ItemId, [string]$TrackId, [string]$CaptureJobId)
    $trackFilter = if ($TrackId) { "AND s.annotation_track_id = '$TrackId'::uuid" } else { "" }
    $jobFilter = if ($CaptureJobId -and $CaptureJobId -match '^[0-9a-fA-F-]{36}$') {
        "OR j.id = '$CaptureJobId'::uuid OR j.parent_job_id = '$CaptureJobId'::uuid"
    } else { "" }
    $sql = @"
SELECT jsonb_pretty(jsonb_build_object(
  'capturedAt', now(),
  'card', jsonb_build_object('source', '$CardSource', 'sourceItemId', '$ItemId', 'annotationTrackId', $(if ($TrackId) { "'$TrackId'" } else { "NULL" })),
  'jobs', COALESCE((SELECT jsonb_agg(to_jsonb(j) ORDER BY j.created_at) FROM meta.generation_jobs j WHERE (j.source = '$CardSource' AND j.source_item_id = '$ItemId') $jobFilter), '[]'::jsonb),
  'annotationVersions', COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.revision) FROM meta.annotation_versions v WHERE v.source = '$CardSource' AND v.source_item_id = '$ItemId'), '[]'::jsonb),
  'annotationVersionPointers', COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM meta.annotation_version_pointers p WHERE p.source = '$CardSource' AND p.source_item_id = '$ItemId'), '[]'::jsonb),
  'tracks', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.ordinal) FROM meta.annotation_tracks t WHERE t.source = '$CardSource' AND t.source_item_id = '$ItemId'), '[]'::jsonb),
  'trackStates', COALESCE((SELECT jsonb_agg(to_jsonb(ts)) FROM meta.annotation_track_states ts JOIN meta.annotation_tracks t ON t.id = ts.annotation_track_id WHERE t.source = '$CardSource' AND t.source_item_id = '$ItemId'), '[]'::jsonb),
  'llmSessions', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.started_at) FROM meta.llm_sessions s WHERE s.source = '$CardSource' AND s.source_item_id = '$ItemId' $trackFilter), '[]'::jsonb),
  'llmStageRuns', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.started_at) FROM meta.llm_stage_runs r JOIN meta.llm_sessions s ON s.id = r.session_id WHERE s.source = '$CardSource' AND s.source_item_id = '$ItemId' $trackFilter), '[]'::jsonb),
  'correctionPlans', COALESCE((SELECT jsonb_agg(to_jsonb(cp) ORDER BY cp.created_at) FROM meta.annotation_correction_plans cp WHERE cp.source = '$CardSource' AND cp.source_item_id = '$ItemId' $(if ($TrackId) { "AND cp.annotation_track_id = '$TrackId'::uuid" } else { "" })), '[]'::jsonb),
  'stageExecutions', COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.started_at) FROM meta.wizard_stage_execution_records e WHERE e.source = '$CardSource' AND e.source_item_id = '$ItemId'), '[]'::jsonb),
  'metadata', COALESCE((SELECT to_jsonb(i) FROM meta.items i WHERE i.source = '$CardSource' AND i.source_item_id = '$ItemId'), '{}'::jsonb)
));
"@
    $result = Invoke-Docker -Arguments (@("compose") + $composeFiles + @("exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "wines", "-v", "ON_ERROR_STOP=1", "-At", "-c", $sql))
    Write-Utf8File -Path (Join-Path $Directory "database.json") -Content ($result -join [Environment]::NewLine)
}

function Get-AccessToken {
    if ($env:VINEDETECT_ACCESS_TOKEN) { return $env:VINEDETECT_ACCESS_TOKEN }
    if (-not $Credential) { return $null }
    $body = @{
        username = $Credential.UserName
        password = $Credential.GetNetworkCredential().Password
    }
    $response = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8000/api/v1/auth/token" -ContentType "application/x-www-form-urlencoded" -Body $body
    return [string]$response.access_token
}

function Capture-HttpJson {
    param([string]$Uri, [string]$Path, [string]$Token)
    try {
        $response = Invoke-WebRequest -Method Get -Uri $Uri -Headers @{ Authorization = "Bearer $Token" } -UseBasicParsing -TimeoutSec 30
        $parsed = $response.Content | ConvertFrom-Json
        Write-JsonFile -Path $Path -Value $parsed
        return $true
    } catch {
        $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { $null }
        Write-JsonFile -Path "$Path.error.json" -Value @{ uri = $Uri; status = $status; error = $_.Exception.Message; capturedAt = (Get-Date).ToString("o") }
        return $false
    }
}

function Capture-Api {
    param([string]$Directory, [string]$CardSource, [string]$ItemId, [string]$TrackId, [string]$CaptureJobId)
    $token = Get-AccessToken
    if (-not $token) {
        Write-Utf8File -Path (Join-Path $Directory "api-skipped.txt") -Content "Set VINEDETECT_ACCESS_TOKEN or pass -Credential to capture authenticated admin API responses."
        return
    }
    $base = $WebBaseUrl.TrimEnd('/')
    $encodedSource = [uri]::EscapeDataString($CardSource)
    $encodedItem = [uri]::EscapeDataString($ItemId)
    Capture-HttpJson -Uri "$base/api/admin/recognition/metadata/$encodedSource/$encodedItem" -Path (Join-Path $Directory "metadata.json") -Token $token | Out-Null
    Capture-HttpJson -Uri "$base/api/admin/recognition/items/$encodedSource/$encodedItem/annotations" -Path (Join-Path $Directory "annotation-graph.json") -Token $token | Out-Null
    Capture-HttpJson -Uri "$base/api/admin/recognition/items/$encodedSource/$encodedItem/annotation-versions" -Path (Join-Path $Directory "annotation-versions.json") -Token $token | Out-Null
    Capture-HttpJson -Uri "$base/api/admin/recognition/metadata/$encodedSource/$encodedItem/annotation-tracks" -Path (Join-Path $Directory "annotation-tracks.json") -Token $token | Out-Null
    if ($CaptureJobId) {
        Capture-HttpJson -Uri "$base/api/admin/recognition/jobs/$([uri]::EscapeDataString($CaptureJobId))" -Path (Join-Path $Directory "job.json") -Token $token | Out-Null
        Capture-HttpJson -Uri "$base/api/admin/recognition/jobs/$([uri]::EscapeDataString($CaptureJobId))/items?limit=500&offset=0" -Path (Join-Path $Directory "job-items.json") -Token $token | Out-Null
    }
    if ($TrackId) {
        Capture-HttpJson -Uri "$base/api/admin/recognition/items/$encodedSource/$encodedItem/annotations/$([uri]::EscapeDataString($TrackId))/controllers/llm/sessions/current" -Path (Join-Path $Directory "llm-session-current.json") -Token $token | Out-Null
    }
}

function Capture-Snapshot {
    param([string]$Root, [string]$Name, [object]$State, [string]$CaptureJobId)
    $snapshotDirectory = Join-Path $Root $Name
    New-Item -ItemType Directory -Path $snapshotDirectory -Force | Out-Null
    Capture-Database -Directory $snapshotDirectory -CardSource $State.source -ItemId $State.sourceItemId -TrackId $State.annotationTrackId -CaptureJobId $CaptureJobId
    Capture-Api -Directory $snapshotDirectory -CardSource $State.source -ItemId $State.sourceItemId -TrackId $State.annotationTrackId -CaptureJobId $CaptureJobId
    Write-JsonFile -Path (Join-Path $snapshotDirectory "capture.json") -Value @{ name = $Name; capturedAt = (Get-Date).ToString("o"); jobId = $CaptureJobId }
}

function Write-ReviewDocument {
    param([string]$Root, [object]$State)
    $jobText = if ($State.jobId) { [string]$State.jobId } else { "not recorded" }
    $content = @"
# Full LLM pipeline review

- Started: $($State.startedAt)
- Finished: $(Get-Date -Format o)
- Card: $($State.source)/$($State.sourceItemId)
- Annotation track: $($State.annotationTrackId)
- Job: $jobText

## Artifacts

- before/database.json and after/database.json - DB-owned state.
- before|capture-*|after/*.json - admin API read models.
- logs/compose.out.log - timestamped service output.
- logs/compose.err.log - log collector diagnostics.
- runtime/compose-ps-*.json - container state.

## Review checklist

- [ ] Job reached the expected terminal status.
- [ ] Every interrupted stage is failed, cancelled or human_required; none remains running.
- [ ] AutoOutput, LLM decision and applied ReviewedOutput are distinguishable.
- [ ] Candidate IDs in LLM decisions exist in the corresponding observation.
- [ ] Correction plans are validated and either fully applied or carry explicit failures.
- [ ] Provider HTTP errors contain status/request evidence and are visible in UI.
- [ ] Package/Label/OCR/CV stage order and prerequisites are preserved.
- [ ] The selected annotation version owns this job/track and no unrelated version changed.
- [ ] Summary/default publication happened only after the intended review boundary.
- [ ] Secrets, authorization headers and provider keys are absent from artifacts.

## Verdict

Status: pending-review

Notes:

_Add reviewer notes here._
"@
    Write-Utf8File -Path (Join-Path $Root "REVIEW.md") -Content $content
}

$script:docker = Resolve-DockerCli

if ($Action -eq "Start") {
    Assert-CardKey -CardSource $Source -ItemId $SourceItemId -TrackId $AnnotationTrackId
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    if (-not $RunDirectory) {
        $safeItem = $SourceItemId -replace '[^A-Za-z0-9_.-]', '_'
        $RunDirectory = Join-Path $repositoryRoot ".dev_logs\llm-pipeline\$stamp-$Source-$safeItem"
    }
    $RunDirectory = [System.IO.Path]::GetFullPath($RunDirectory)
    if (Test-Path -LiteralPath $RunDirectory) { throw "Run directory already exists: $RunDirectory" }
    New-Item -ItemType Directory -Path (Join-Path $RunDirectory "logs") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $RunDirectory "runtime") -Force | Out-Null

    $startedAt = (Get-Date).ToUniversalTime().ToString("o")
    $psOutput = Invoke-Docker -Arguments (@("compose") + $composeFiles + @("ps", "--format", "json"))
    Write-Utf8File -Path (Join-Path $RunDirectory "runtime\compose-ps-start.json") -Content ($psOutput -join [Environment]::NewLine)

    $logOut = Join-Path $RunDirectory "logs\compose.out.log"
    $logErr = Join-Path $RunDirectory "logs\compose.err.log"
    $logArguments = @("compose") + $composeFiles + @("logs", "--follow", "--no-color", "--timestamps", "--since", $startedAt) + $services
    $collector = Start-Process -FilePath $script:docker -ArgumentList $logArguments -WorkingDirectory $repositoryRoot -RedirectStandardOutput $logOut -RedirectStandardError $logErr -WindowStyle Hidden -PassThru
    $state = [ordered]@{
        schemaVersion = 1; source = $Source; sourceItemId = $SourceItemId; annotationTrackId = $AnnotationTrackId
        jobId = $JobId; startedAt = $startedAt; collectorPid = $collector.Id; status = "capturing"
        webBaseUrl = $WebBaseUrl; runDirectory = $RunDirectory
    }
    $statePath = Join-Path $RunDirectory "run-state.json"
    Save-State -Path $statePath -State $state
    Capture-Snapshot -Root $RunDirectory -Name "before" -State $state -CaptureJobId $JobId
    Write-ReviewDocument -Root $RunDirectory -State $state
    Write-Host "LLM test environment is capturing."
    Write-Host "Run directory: $RunDirectory"
    Write-Host "Collector PID: $($collector.Id)"
    Write-Host "After starting the UI job, run:"
    Write-Host ".\scripts\llm-pipeline-test-env.ps1 -Action Capture -RunDirectory '$RunDirectory' -JobId '<job UUID>'"
    exit 0
}

$loaded = Read-State -Directory $RunDirectory
$state = $loaded.State
Assert-CardKey -CardSource $state.source -ItemId $state.sourceItemId -TrackId $state.annotationTrackId
if ($AnnotationTrackId) {
    Assert-CardKey -CardSource $state.source -ItemId $state.sourceItemId -TrackId $AnnotationTrackId
    $state.annotationTrackId = $AnnotationTrackId
}
if ($JobId) { $state.jobId = $JobId }
if ($AnnotationTrackId -or $JobId) { Save-State -Path $loaded.Path -State $state }
$effectiveJobId = if ($JobId) { $JobId } else { [string]$state.jobId }

if ($Action -eq "Capture") {
    $name = "capture-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Capture-Snapshot -Root $loaded.Directory -Name $name -State $state -CaptureJobId $effectiveJobId
    Write-Host "Captured: $(Join-Path $loaded.Directory $name)"
    exit 0
}

Capture-Snapshot -Root $loaded.Directory -Name "after" -State $state -CaptureJobId $effectiveJobId
$process = Get-Process -Id ([int]$state.collectorPid) -ErrorAction SilentlyContinue
if ($process) { Stop-Process -Id $process.Id -Force }
$psOutput = Invoke-Docker -Arguments (@("compose") + $composeFiles + @("ps", "--format", "json"))
Write-Utf8File -Path (Join-Path $loaded.Directory "runtime\compose-ps-stop.json") -Content ($psOutput -join [Environment]::NewLine)
$state.status = "stopped"
$state | Add-Member -NotePropertyName finishedAt -NotePropertyValue ((Get-Date).ToUniversalTime().ToString("o")) -Force
Save-State -Path $loaded.Path -State $state
Write-ReviewDocument -Root $loaded.Directory -State $state
Write-Host "Capture stopped. Review package: $($loaded.Directory)"
