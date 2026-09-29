param(
  [string]$DatabaseName = "wines",
  [string]$HostName = "localhost",
  [int]$Port = 5432,
  [string]$UserName = "postgres",
  [string]$Password = "admin",
  [switch]$Force
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

function Find-PostgresTool {
  param([string]$Name)

  $Command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($Command) { return $Command.Source }

  $Candidates = @(
    "C:\Program Files\PostgreSQL\17\bin\$Name",
    "C:\Program Files\PostgreSQL\16\bin\$Name",
    "C:\Program Files\PostgreSQL\15\bin\$Name",
    "C:\Program Files\PostgreSQL\17\pgAdmin 4\runtime\$Name"
  )

  foreach ($Candidate in $Candidates) {
    if (Test-Path -LiteralPath $Candidate) { return $Candidate }
  }

  throw "Cannot find $Name. Add PostgreSQL bin to PATH or install PostgreSQL client tools."
}

function Invoke-Psql {
  param([string]$Sql)

  & $Psql `
    -h $HostName `
    -p $Port `
    -U $UserName `
    -d $DatabaseName `
    -v "ON_ERROR_STOP=1" `
    -tA `
    -c $Sql

  if ($LASTEXITCODE -ne 0) {
    throw "psql failed with exit code $LASTEXITCODE"
  }
}

$Psql = Find-PostgresTool "psql.exe"
$env:PGPASSWORD = $Password

$Where = @"
job_type IS NOT NULL
   OR mode IN ('GENERATE_ALIASES', 'GENERATE_CV_META', 'GENERATE_ALL_META', 'REGENERATE_ALL_META')
"@

$Count = (Invoke-Psql "SELECT COUNT(*) FROM meta.generation_jobs WHERE $Where;").Trim()
Write-Host "Recognition jobs found: $Count"

if (-not $Force) {
  Write-Host "Dry run only. Re-run with -Force to delete recognition jobs."
  exit 0
}

Invoke-Psql "DELETE FROM meta.generation_jobs WHERE $Where;"
Write-Host "Recognition jobs deleted."
