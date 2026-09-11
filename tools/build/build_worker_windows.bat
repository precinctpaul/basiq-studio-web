@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM =====================================================================
REM  Build Basiq-Worker-Setup.exe -- the whole distributable, in one file.
REM
REM  Run this from a checkout that already has tools\.venv-worker set up
REM  with the worker role's OWN runtime dependencies
REM  (tools\requirements-worker.txt) -- deliberately separate from
REM  tools\.venv (the agent's venv, which has torch/spaCy/faster-whisper).
REM  That venv is what gets frozen, so whatever's importable there is what
REM  ships -- keeping it separate is what keeps the worker build lean.
REM =====================================================================

set "VENV_PY=..\.venv-worker\Scripts\python.exe"
if not exist "%VENV_PY%" (
  echo   tools\.venv-worker isn't set up yet. From tools\, run:
  echo     python -m venv .venv-worker
  echo     .venv-worker\Scripts\python.exe -m pip install -r requirements-worker.txt
  echo   then re-run this script.
  exit /b 1
)

echo   [1/3] Installing build-only dependencies into the worker's venv...
"%VENV_PY%" -m pip install --quiet --upgrade pyinstaller pyinstaller-hooks-contrib
if errorlevel 1 (
  echo   Could not install PyInstaller. Check your internet connection.
  exit /b 1
)

echo   [2/3] Freezing basiq_worker.py / basiq_worker_tray.py / youtube_session.py...
"%VENV_PY%" -m PyInstaller --noconfirm --distpath dist --workpath work basiq_worker.spec
if errorlevel 1 (
  echo   PyInstaller build failed -- see the traceback above.
  exit /b 1
)

echo   [3/3] Compiling the installer...
set "ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" set "ISCC=C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" (
  where ISCC.exe >nul 2>nul
  if errorlevel 1 (
    echo   Inno Setup isn't installed. Get it from https://jrsoftware.org/isinfo.php
    echo   or: winget install --id JRSoftware.InnoSetup -e
    exit /b 1
  )
  set "ISCC=ISCC.exe"
)
"%ISCC%" installer_worker.iss
if errorlevel 1 (
  echo   Inno Setup compile failed -- see the output above.
  exit /b 1
)

echo.
echo   Done: build\installer_output\Basiq-Worker-Setup.exe
echo.
echo   NOTE: this installer does NOT bundle a Chrome binary -- it runs
echo   "playwright install chrome" once on the teammate's own machine
echo   during install (see installer_worker.iss). That step needs a normal
echo   internet connection the first time; nothing further to do after.
