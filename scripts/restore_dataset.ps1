param(
  [string]$ArchivePath = ".\.basedata\vinedetect_dataset_20260727_010201.tar.gz",
  [string]$DatabaseName = "wines",
  [string]$HostName = "localhost",
  [int]$Port = 5432,
  [string]$UserName = "postgres",
  [string]$Password = "admin",
  [string]$AssetRoot = ".\asset-store",
  [switch]$CleanOldArchives,
  [switch]$KeepExtracted
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$RepoRoot = (Resolve-Path "$PSScriptRoot\..").Path
$ArchiveFullPath = (Resolve-Path $ArchivePath).Path
$ExtractRoot = Join-Path $RepoRoot ".basedata\_restore_current"
$AssetFullRoot = Join-Path $RepoRoot $AssetRoot
$Psql = $null
$PgRestore = $null

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

function Invoke-Checked {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList
  )

  Write-Host "> $FilePath $($ArgumentList -join ' ')"
  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code $LASTEXITCODE"
  }
}

function Count-Table {
  param([string]$Sql)
  & $Psql -h $HostName -p $Port -U $UserName -d $DatabaseName -tA -c $Sql
}

function Count-FirstAvailableTable {
  param([string[]]$TableNames)

  foreach ($TableName in $TableNames) {
    $Exists = Count-Table "SELECT to_regclass('$TableName') IS NOT NULL;"
    if ($Exists.Trim() -eq "t") {
      return Count-Table "SELECT COUNT(*) FROM $TableName;"
    }
  }

  return "missing"
}

function Invoke-Sql {
  param([string]$Sql)
  Invoke-Checked $Psql @(
    "-h", $HostName,
    "-p", "$Port",
    "-U", $UserName,
    "-d", $DatabaseName,
    "-v", "ON_ERROR_STOP=1",
    "-c", $Sql
  )
}

$Psql = Find-PostgresTool "psql.exe"
$PgRestore = Find-PostgresTool "pg_restore.exe"
$env:PGPASSWORD = $Password

Write-Host "Dataset archive: $ArchiveFullPath"
Write-Host "Database target: $UserName@$HostName`:$Port/$DatabaseName"
Write-Host "Extract root: $ExtractRoot"
Write-Host "Asset root: $AssetFullRoot"

if ($CleanOldArchives) {
  Get-ChildItem -LiteralPath (Join-Path $RepoRoot ".basedata") -File -Filter "scanner_dataset_*.tar.gz*" |
    ForEach-Object {
      Write-Host "Removing old archive: $($_.FullName)"
      Remove-Item -LiteralPath $_.FullName -Force
    }
}

if (Test-Path -LiteralPath $ExtractRoot) {
  Write-Host "Removing previous extracted dataset..."
  Remove-Item -LiteralPath $ExtractRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $ExtractRoot | Out-Null

Write-Host "Extracting dataset..."
tar -xzf $ArchiveFullPath -C $ExtractRoot
if ($LASTEXITCODE -ne 0) {
  throw "tar failed with exit code $LASTEXITCODE"
}

$DumpPath = Join-Path $ExtractRoot "db\wines.dump"
if (-not (Test-Path -LiteralPath $DumpPath)) {
  throw "Dump not found: $DumpPath"
}

Write-Host "Stopping active dev stack if present..."
powershell -ExecutionPolicy Bypass -File (Join-Path $RepoRoot "scripts\dev_stack.ps1") -Action stop

Write-Host "Recreating database..."
Invoke-Checked $Psql @(
  "-h", $HostName,
  "-p", "$Port",
  "-U", $UserName,
  "-d", "postgres",
  "-c", "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DatabaseName' AND pid <> pg_backend_pid();"
)
Invoke-Checked $Psql @(
  "-h", $HostName,
  "-p", "$Port",
  "-U", $UserName,
  "-d", "postgres",
  "-c", "DROP DATABASE IF EXISTS $DatabaseName;"
)
Invoke-Checked $Psql @(
  "-h", $HostName,
  "-p", "$Port",
  "-U", $UserName,
  "-d", "postgres",
  "-c", "CREATE DATABASE $DatabaseName;"
)

Write-Host "Restoring database dump..."
Invoke-Checked $PgRestore @(
  "-h", $HostName,
  "-p", "$Port",
  "-U", $UserName,
  "-d", $DatabaseName,
  "--no-owner",
  "--no-privileges",
  $DumpPath
)

Write-Host "Configuring database search_path..."
Invoke-Checked $Psql @(
  "-h", $HostName,
  "-p", "$Port",
  "-U", $UserName,
  "-d", "postgres",
  "-v", "ON_ERROR_STOP=1",
  "-c", "ALTER DATABASE $DatabaseName SET search_path TO svoe_vino, public;"
)

Write-Host "Ensuring migration ledger..."
Invoke-Sql "CREATE TABLE IF NOT EXISTS public.schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());"
Get-ChildItem -LiteralPath (Join-Path $RepoRoot "vinedetect_api\migrations") -File -Filter "*.sql" |
  Sort-Object Name |
  ForEach-Object {
    $Version = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
    Invoke-Sql "INSERT INTO public.schema_migrations (version) VALUES ('$Version') ON CONFLICT (version) DO NOTHING;"
  }

Write-Host "Copying dataset files into project asset store..."
$FilesRoot = Join-Path $ExtractRoot "files"
if (Test-Path -LiteralPath $FilesRoot) {
  if (Test-Path -LiteralPath $AssetFullRoot) {
    Write-Host "Removing previous asset store..."
    Remove-Item -LiteralPath $AssetFullRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $AssetFullRoot | Out-Null
  $SvoeVinoFilesRoot = Join-Path $FilesRoot "svoe_vino"
  $RoskachestvoFilesRoot = Join-Path $FilesRoot "storage\roskachestvo"

  if (Test-Path -LiteralPath $SvoeVinoFilesRoot) {
    robocopy $SvoeVinoFilesRoot (Join-Path $AssetFullRoot "svoe-vino") /E /NFL /NDL /NJH /NJS /NP | Out-Host
    if ($LASTEXITCODE -gt 7) {
      throw "robocopy failed with exit code $LASTEXITCODE"
    }
  }

  if (Test-Path -LiteralPath $RoskachestvoFilesRoot) {
    robocopy $RoskachestvoFilesRoot (Join-Path $AssetFullRoot "roskachestvo") /E /NFL /NDL /NJH /NJS /NP | Out-Host
    if ($LASTEXITCODE -gt 7) {
      throw "robocopy failed with exit code $LASTEXITCODE"
    }
  }

  $UnexpectedRoots = Get-ChildItem -LiteralPath $FilesRoot -Directory |
    Where-Object { $_.Name -notin @("svoe_vino", "storage") }
  foreach ($UnexpectedRoot in $UnexpectedRoots) {
    Write-Host "Skipping unsupported asset root from archive: $($UnexpectedRoot.Name)"
  }
}

Write-Host "Dataset counts:"
Write-Host "  wines: $(Count-FirstAvailableTable @('public.wines', 'svoe_vino.wines'))"
Write-Host "  wine_images: $(Count-FirstAvailableTable @('public.wine_images', 'svoe_vino.wine_images'))"
Write-Host "  roskachestvo.products: $(Count-Table 'SELECT COUNT(*) FROM roskachestvo.products;')"
Write-Host "  roskachestvo image local path: $(Count-Table "SELECT COUNT(*) FROM roskachestvo.products WHERE image_local_path IS NOT NULL AND image_local_path <> '';")"
Write-Host "  schema_migrations: $(Count-Table 'SELECT COUNT(*) FROM public.schema_migrations;')"

$MissingImages = Join-Path $ExtractRoot "manifest\missing_images.tsv"
if (Test-Path -LiteralPath $MissingImages) {
  $MissingCount = (Get-Content -LiteralPath $MissingImages | Measure-Object -Line).Lines
  Write-Host "  missing image entries in archive manifest: $MissingCount"
}

if (-not $KeepExtracted) {
  Write-Host "Removing extracted staging files..."
  Remove-Item -LiteralPath $ExtractRoot -Recurse -Force
}

Write-Host "Restore complete."
