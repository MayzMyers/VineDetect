[CmdletBinding()]
param(
    [string]$OutputPath = "",
    [switch]$SchemaOnly
)

$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $repositoryRoot "compose.yaml"
$composeDevFile = Join-Path $repositoryRoot "compose.dev.yaml"
$environmentFile = Join-Path $repositoryRoot ".env"

function Read-DotEnvValue {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$DefaultValue
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return $DefaultValue
    }

    $prefix = "$Name="
    $line = Get-Content -LiteralPath $Path |
        Where-Object { $_.StartsWith($prefix, [System.StringComparison]::Ordinal) } |
        Select-Object -Last 1
    if (-not $line) {
        return $DefaultValue
    }

    $value = $line.Substring($prefix.Length).Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
    }
    if ($value) { return $value }
    return $DefaultValue
}

$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) {
    throw "Docker CLI is not available in PATH. Run this script in the PowerShell session where 'docker compose' works."
}

$databaseName = Read-DotEnvValue -Path $environmentFile -Name "POSTGRES_DB" -DefaultValue "wines"
$databaseUser = Read-DotEnvValue -Path $environmentFile -Name "POSTGRES_USER" -DefaultValue "postgres"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$kind = if ($SchemaOnly) { "schema" } else { "full" }
$fileName = "vinedetect-$databaseName-$kind-$timestamp.sql"

if (-not $OutputPath) {
    $OutputPath = Join-Path $repositoryRoot (Join-Path "exports" $fileName)
}
$absoluteOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $absoluteOutputPath
if (-not (Test-Path -LiteralPath $outputDirectory)) {
    New-Item -ItemType Directory -Path $outputDirectory | Out-Null
}
if (Test-Path -LiteralPath $absoluteOutputPath) {
    throw "Refusing to overwrite an existing dump: $absoluteOutputPath"
}

$containerFile = "vinedetect-$databaseName-$kind-$timestamp.sql"
$containerPath = "/tmp/$containerFile"
$composeArguments = @("compose", "-f", $composeFile, "-f", $composeDevFile)
$dumpArguments = @(
    "exec", "-T", "postgres",
    "pg_dump",
    "--username", $databaseUser,
    "--dbname", $databaseName,
    "--format=plain",
    "--encoding=UTF8",
    "--no-owner",
    "--no-privileges",
    "--file=$containerPath"
)
if ($SchemaOnly) {
    $dumpArguments += "--schema-only"
}

$containerFileCreated = $false
try {
    & $docker.Source @composeArguments @dumpArguments
    if ($LASTEXITCODE -ne 0) {
        throw "pg_dump failed with exit code $LASTEXITCODE"
    }
    $containerFileCreated = $true

    & $docker.Source @composeArguments "cp" "postgres:$containerPath" $absoluteOutputPath
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose cp failed with exit code $LASTEXITCODE"
    }
}
finally {
    if ($containerFileCreated) {
        & $docker.Source @composeArguments "exec" "-T" "postgres" "rm" "-f" "--" $containerPath | Out-Null
    }
}

$dumpFile = Get-Item -LiteralPath $absoluteOutputPath
if ($dumpFile.Length -eq 0) {
    throw "The dump was created but is empty: $absoluteOutputPath"
}
$header = Get-Content -LiteralPath $absoluteOutputPath -TotalCount 5 -Encoding UTF8
if (($header -join "`n") -notmatch "PostgreSQL database dump") {
    throw "The output does not look like a PostgreSQL plain SQL dump: $absoluteOutputPath"
}
$hash = Get-FileHash -LiteralPath $absoluteOutputPath -Algorithm SHA256

[pscustomobject]@{
    Path = $dumpFile.FullName
    Database = $databaseName
    Kind = $kind
    Bytes = $dumpFile.Length
    SHA256 = $hash.Hash
}
