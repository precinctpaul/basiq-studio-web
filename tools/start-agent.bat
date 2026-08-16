@echo off
setlocal
cd /d "%~dp0"

REM =====================================================================
REM  Start the Basiq agent. Double-click this (or the Desktop shortcut
REM  Basiq-Setup.bat creates) whenever you want to work. Leave the window
REM  open; closing it stops the agent.
REM
REM  SHARED DRIVE: read from media_root.txt, written once by
REM  Basiq-Setup.bat. No manual editing needed - rerun Basiq-Setup.bat to
REM  change it. Falls back to a manual override below if you set one.
REM =====================================================================

REM set COOKIES_FROM_BROWSER=chrome

if exist "media_root.txt" (
  set /p MEDIA_ROOT=<media_root.txt
)

if not exist ".venv\Scripts\python.exe" (
  echo.
  echo   The agent isn't installed yet.
  echo   Run Basiq-Setup.bat first.
  echo.
  pause
  exit /b 1
)

REM ---- Free up port 8000 -------------------------------------------------
REM Windows sometimes leaves the previous agent running as an orphan when
REM this window is closed with the X button instead of Ctrl+C - it then
REM keeps answering the website with stale info (wrong folder, etc). Clear
REM it before every start so this window is always the one in charge.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8000" ^| findstr "LISTENING"') do (
  taskkill /PID %%p /F >nul 2>nul
)

if defined MEDIA_ROOT (
  echo   Shared media root: %MEDIA_ROOT%
) else (
  echo   No shared folder set - media will be kept in tools\media on this PC.
  echo   Run Basiq-Setup.bat to point at the team's shared folder.
)
echo.

.venv\Scripts\python.exe basiq_agent.py

echo.
echo   The agent has stopped.
pause
