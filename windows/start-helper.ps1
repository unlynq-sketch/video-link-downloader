$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Split-Path -Parent $scriptDir
$helperDir = Join-Path $projectDir "helper"

Set-Location $helperDir
node server.mjs
