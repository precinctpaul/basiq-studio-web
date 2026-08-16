@echo off
setlocal
cd /d "%~dp0"

REM =====================================================================
REM  Start the Basiq agent. Double-click this whenever you want to work.
REM  Leave the window open; closing it stops the agent.
REM
REM  SHARED DRIVE: point MEDIA_ROOT at the team's LucidLink folder so
REM  everyone sees the same library. Edit the line below, or set it as a
REM  system environment variable.
REM =====================================================================

REM set MEDIA_ROOT=L:\MajorityDems\Media
REM set COOKIES_FROM_BROWSER=chrome

if not exist ".venv\Scripts\python.exe" (
  echo.
  echo   The agent isn't installed yet.
  echo   Run install.bat first.
  echo.
  pause
  exit /b 1
)

if defined MEDIA_ROOT (
  echo   Shared media root: %MEDIA_ROOT%
) else (
  echo   No MEDIA_ROOT set - media will be kept in tools\media on this PC.
  echo   Edit start-agent.bat to point at the team's shared folder.
)
echo.

.venv\Scripts\python.exe basiq_agent.py

echo.
echo   The agent has stopped.
pause
