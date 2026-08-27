@echo off
setlocal
cd /d "%~dp0"

REM =====================================================================
REM  Start the Basiq capture worker. Double-click this on the ONE
REM  designated always-on machine. Leave the window open; closing it
REM  stops the worker -- any queued GRAB/GO LIVE jobs just wait for it to
REM  come back, nothing is lost.
REM
REM  Configure once: copy worker_config.txt.example to worker_config.txt
REM  and fill in AGENT_URL, AUTH_TOKEN, MEDIA_ROOT.
REM =====================================================================

if not exist "worker_config.txt" (
  echo.
  echo   worker_config.txt is missing.
  echo   Copy worker_config.txt.example to worker_config.txt and fill it in.
  echo.
  timeout /t 10
  exit /b 1
)

for /f "usebackq eol=# tokens=1,* delims==" %%a in ("worker_config.txt") do (
  if not "%%a"=="" set "%%a=%%b"
)

if not defined AGENT_URL (
  echo   AGENT_URL is missing from worker_config.txt.
  timeout /t 10
  exit /b 1
)
if not defined AUTH_TOKEN (
  echo   AUTH_TOKEN is missing from worker_config.txt.
  timeout /t 10
  exit /b 1
)
if not defined MEDIA_ROOT (
  echo   MEDIA_ROOT is missing from worker_config.txt.
  timeout /t 10
  exit /b 1
)
if not defined SUPABASE_URL (
  echo   SUPABASE_URL is missing from worker_config.txt.
  echo   Without it, finished grabs/captures download fine but silently
  echo   never appear in the library -- see worker_config.txt.example.
  timeout /t 10
  exit /b 1
)
if not defined SUPABASE_SERVICE_ROLE_KEY (
  echo   SUPABASE_SERVICE_ROLE_KEY is missing from worker_config.txt.
  echo   Without it, finished grabs/captures download fine but silently
  echo   never appear in the library -- see worker_config.txt.example.
  timeout /t 10
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo.
  echo   The agent isn't installed yet. Run Basiq-Setup.bat first --
  echo   the worker reuses the same Python environment as the agent.
  echo.
  timeout /t 10
  exit /b 1
)

echo   Worker: %COMPUTERNAME%
echo   Agent:  %AGENT_URL%
echo   Media:  %MEDIA_ROOT%
echo.

.venv\Scripts\python.exe basiq_worker.py

echo.
echo   The worker has stopped.
REM Two things had to be fixed here for Task Scheduler's RestartOnFailure
REM to actually work, both confirmed by live-killing the process and timing
REM the recovery (2026-08-27):
REM   1. A plain `pause` left cmd.exe alive forever waiting for a keypress
REM      that never comes unattended -- Task Scheduler saw the task as
REM      still "running" and never considered it failed. Fixed with a 10s
REM      timeout instead: still readable if a human's watching, but always
REM      lets the process actually exit.
REM   2. Falling off the end of a batch file exits 0 (success) regardless
REM      of why python.exe stopped -- RestartOnFailure only fires on a
REM      non-zero exit. This script has no "stop gracefully, don't restart"
REM      case (the only way to stop it is closing the window or it dying),
REM      so every exit is unconditionally treated as a failure worth
REM      restarting.
timeout /t 10
exit /b 1
