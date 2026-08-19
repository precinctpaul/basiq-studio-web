@echo off
setlocal
cd /d "%~dp0\.."

REM =====================================================================
REM  Publish the compiled agent installer(s) to the shared drive.
REM
REM  This does NOT build anything - it just copies whatever's already in
REM  tools\build\installer_output\ to the shared drive. Run
REM  tools\build\build_windows.bat first (and, once someone has a Mac,
REM  build_macos.sh) any time basiq_agent.py changes, then run this.
REM =====================================================================

python scripts\publish_tools.py
if errorlevel 1 (
  echo.
  echo   Publish failed - see the error above.
  pause
  exit /b 1
)
pause
