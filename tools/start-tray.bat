@echo off
setlocal
cd /d "%~dp0"

REM =====================================================================
REM  Start the Basiq worker's system-tray supervisor. Unlike
REM  start-worker.bat, this opens NO console window -- look for the tray
REM  icon near your clock instead. Right-click it for status, a manual
REM  restart, and the log. This is what basiq-worker-task.xml launches at
REM  logon; double-click this only to start it by hand right now instead
REM  of waiting for next logon.
REM =====================================================================

if not exist "worker_config.txt" (
  echo.
  echo   worker_config.txt is missing.
  echo   Copy worker_config.txt.example to worker_config.txt and fill it in.
  echo.
  timeout /t 10
  exit /b 1
)

if not exist ".venv\Scripts\pythonw.exe" (
  echo.
  echo   The agent isn't installed yet. Run Basiq-Setup.bat first --
  echo   the worker reuses the same Python environment as the agent.
  echo.
  timeout /t 10
  exit /b 1
)

.venv\Scripts\python.exe -c "import pystray" 2>nul
if errorlevel 1 (
  echo.
  echo   Installing the tray icon's dependencies (one-time)...
  .venv\Scripts\pip.exe install -r requirements-tray.txt
)

start "" ".venv\Scripts\pythonw.exe" "worker_tray.py"
echo   Basiq Worker tray icon starting -- check near your clock.
timeout /t 3 >nul
