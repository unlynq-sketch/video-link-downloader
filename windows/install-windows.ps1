$ErrorActionPreference = "Stop"

$appName = "Video Link Downloader Helper"
$taskName = "Video Link Downloader Helper"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Split-Path -Parent $scriptDir
$helperSource = Join-Path $projectDir "helper"
$installDir = Join-Path $env:LOCALAPPDATA $appName

function Find-Command($name) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Refresh-Path {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machinePath;$userPath"
}

function Ensure-Tool($commandName, $wingetId, $displayName) {
  $found = Find-Command $commandName
  if ($found) { return $found }

  $winget = Find-Command "winget.exe"
  if (-not $winget) {
    throw "$displayName is required. Install it, then run this installer again."
  }

  Write-Host "Installing $displayName..."
  & $winget install --id $wingetId --exact --silent --accept-package-agreements --accept-source-agreements
  Refresh-Path

  $found = Find-Command $commandName
  if (-not $found) {
    throw "$displayName was installed, but Windows has not exposed it on PATH yet. Restart PowerShell or Windows, then run this installer again."
  }
  return $found
}

if (-not (Test-Path (Join-Path $helperSource "server.mjs"))) {
  throw "Could not find the helper folder next to this installer."
}

$node = Ensure-Tool "node.exe" "OpenJS.NodeJS.LTS" "Node.js LTS"
$python = Find-Command "py.exe"
if (-not $python) {
  $python = Ensure-Tool "python.exe" "Python.Python.3.12" "Python 3.12"
}

Write-Host "Installing $appName..."
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
robocopy $helperSource $installDir /MIR /XD downloads .venv .venv-py39-backup /XF helper.log | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $installDir "downloads") | Out-Null

Push-Location $installDir
try {
  $venvPython = Join-Path $installDir ".venv\Scripts\python.exe"
  $needsVenv = $true
  if (Test-Path $venvPython) {
    & $venvPython -m yt_dlp --version *> $null
    $ytOk = $LASTEXITCODE -eq 0
    & $venvPython -c "import imageio_ffmpeg" *> $null
    $ffmpegOk = $LASTEXITCODE -eq 0
    $needsVenv = -not ($ytOk -and $ffmpegOk)
  }

  if ($needsVenv) {
    Write-Host "Preparing local downloader engine..."
    Remove-Item -Recurse -Force ".venv" -ErrorAction SilentlyContinue
    if ((Split-Path -Leaf $python) -ieq "py.exe") {
      & $python -3.12 -m venv .venv
      if ($LASTEXITCODE -ne 0) { & $python -3 -m venv .venv }
    } else {
      & $python -m venv .venv
    }
    & $venvPython -m pip install --upgrade pip
    & $venvPython -m pip install --upgrade yt-dlp imageio-ffmpeg
  }
} finally {
  Pop-Location
}

$startScript = Join-Path $installDir "start-helper.ps1"
@"
`$ErrorActionPreference = "Stop"
Set-Location "$installDir"
& "$node" server.mjs
"@ | Set-Content -Encoding UTF8 $startScript

$launcher = Join-Path $installDir "start-helper.bat"
@"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$startScript"
"@ | Set-Content -Encoding ASCII $launcher

schtasks /End /TN $taskName *> $null
schtasks /Delete /TN $taskName /F *> $null
schtasks /Create /TN $taskName /SC ONLOGON /TR "`"$launcher`"" /RL LIMITED /F | Out-Null
schtasks /Run /TN $taskName | Out-Null

Write-Host ""
Write-Host "Installed and started."
Write-Host "Helper health check:"
for ($i = 0; $i -lt 10; $i++) {
  try {
    $health = Invoke-RestMethod -Uri "http://localhost:8787/api/health" -TimeoutSec 2
    if ($health.ok) {
      Write-Host "OK"
      break
    }
  } catch {
    Start-Sleep -Seconds 1
  }
}

Write-Host ""
Write-Host "Next: open Chrome Extensions, load the extension folder, then click Video Link Downloader."
