@echo off
setlocal
cd /d "%~dp0\.."

REM =====================================================================
REM  Publish tools\ to the shared drive as a zip (publish_tools.py).
REM
REM  A plain folder copy doesn't work here: Windows/NTFS has no real Unix
REM  execute bit, so a robocopy/tar pipeline through this machine cannot
REM  carry that bit to a Mac reading the same LucidLink share - macOS then
REM  refuses to run Basiq-Setup.command even though git and Git Bash both
REM  show it as executable on this side. A zip stores the Unix permission
REM  as data inside the archive format itself, which any unzip tool
REM  restores correctly on extraction, regardless of what built the zip.
REM
REM  Run this any time a file under tools\ changes.
REM =====================================================================

python scripts\publish_tools.py
if errorlevel 1 (
  echo.
  echo   Publish failed - see the error above.
  pause
  exit /b 1
)
pause
