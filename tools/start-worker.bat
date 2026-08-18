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
  pause
  exit /b 1
)

for /f "usebackq eol=# tokens=1,* delims==" %%a in ("worker_config.txt") do (
  if not "%%a"=="" set "%%a=%%b"
)

if not defined AGENT_URL (
  echo   AGENT_URL is missing from worker_config.txt.
  pause
  exit /b 1
)
if not defined AUTH_TOKEN (
  echo   AUTH_TOKEN is missing from worker_config.txt.
  pause
  exit /b 1
)
if not defined MEDIA_ROOT (
  echo   MEDIA_ROOT is missing from worker_config.txt.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo.
  echo   The agent isn't installed yet. Run Basiq-Setup.bat first --
  echo   the worker reuses the same Python environment as the agent.
  echo.
  pause
  exit /b 1
)

echo   Worker: %COMPUTERNAME%
echo   Agent:  %AGENT_URL%
echo   Media:  %MEDIA_ROOT%
echo.

.venv\Scripts\python.exe basiq_worker.py

echo.
echo   The worker has stopped.
pause
