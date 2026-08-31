# Build new-api docker image on a remote Docker daemon (PowerShell variant).
#
# Usage:
#   .\scripts\build-remote.ps1
#   .\scripts\build-remote.ps1 -Tag v1.2.3
#   .\scripts\build-remote.ps1 -Tag v1.2.3 -Push
#   .\scripts\build-remote.ps1 -Remote tcp://host:2375 -Image weny7/new-api

[CmdletBinding()]
param(
    [string]$Remote = 'tcp://192.168.100.153:2375',
    [string]$Image  = 'wenyou7/new-api',
    [string]$Tag    = '',
    [switch]$Push
)

$ErrorActionPreference = 'Stop'

function Log($msg)  { Write-Host "[build-remote] $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "[build-remote] $msg" -ForegroundColor Red; exit 1 }

# cd to repo root regardless of where this script is invoked.
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $RepoRoot

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Fail 'docker CLI not found in PATH'
}

$tags = @("$Image`:latest")
if ($Tag) { $tags += "$Image`:$Tag" }

Log "Remote daemon : $Remote"
Log "Image tags    : $($tags -join ', ')"
Log "Context       : $RepoRoot"

if ($Remote -match '^tcp://.+:2375$') {
    Log 'WARN: using unencrypted tcp:2375 -- ensure this daemon is on a trusted network.'
}

Log 'Pinging remote daemon...'
$null = & docker -H $Remote version --format '{{.Server.Version}}'
if ($LASTEXITCODE -ne 0) { Fail "cannot reach docker daemon at $Remote" }

$buildArgs = @('-H', $Remote, 'build')
foreach ($t in $tags) { $buildArgs += @('-t', $t) }
$buildArgs += @('-f', 'Dockerfile', '.')

Log 'Starting build (context will be streamed to remote daemon)...'
& docker @buildArgs
if ($LASTEXITCODE -ne 0) { Fail 'docker build failed' }

Log 'Build finished.'
& docker -H $Remote image ls --filter "reference=$Image" --format 'table {{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Size}}\t{{.CreatedSince}}'

if ($Push) {
    foreach ($t in $tags) {
        Log "Pushing $t..."
        & docker -H $Remote push $t
        if ($LASTEXITCODE -ne 0) { Fail "docker push $t failed" }
    }
}

Log 'Done.'
