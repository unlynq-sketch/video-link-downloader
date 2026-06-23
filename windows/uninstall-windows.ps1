$ErrorActionPreference = "Stop"

$appName = "Video Link Downloader Helper"
$taskName = "Video Link Downloader Helper"
$installDir = Join-Path $env:LOCALAPPDATA $appName

schtasks /End /TN $taskName *> $null
schtasks /Delete /TN $taskName /F *> $null
Remove-Item -Recurse -Force $installDir -ErrorAction SilentlyContinue

Write-Host "Removed $appName."
