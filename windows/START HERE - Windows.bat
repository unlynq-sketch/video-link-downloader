@echo off
setlocal
echo Video Link Downloader
echo.
echo Step 1 of 2: installing the helper...
call "%~dp0windows\install-windows.bat"
echo.
echo Step 2 of 2: opening Chrome Extensions.
echo.
echo In Chrome:
echo 1. Turn on Developer mode.
echo 2. Click Load unpacked.
echo 3. Select this folder:
echo %~dp0extension
echo.
start "" "chrome://extensions"
explorer "%~dp0"
echo Keep this window open until you finish loading the extension.
pause
