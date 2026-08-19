@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM =====================================================================
REM  Build Basiq-Agent-Setup.exe — the whole distributable, in one file.
REM
REM  Run this from a checkout that already has tools\.venv set up with the
REM  agent's runtime dependencies (tools\requirements.txt) — that venv is
REM  what gets frozen, so whatever's importable there is what ships.
REM =====================================================================

set "VENV_PY=..\.venv\Scripts\python.exe"
if not exist "%VENV_PY%" (
  echo   tools\.venv isn't set up yet. From tools\, run:
  echo     python -m venv .venv
  echo     .venv\Scripts\python.exe -m pip install -r requirements.txt
  echo   then re-run this script.
  exit /b 1
)

echo   [1/3] Installing build-only dependencies into the agent's venv...
"%VENV_PY%" -m pip install --quiet --upgrade pyinstaller pyinstaller-hooks-contrib
if errorlevel 1 (
  echo   Could not install PyInstaller. Check your internet connection.
  exit /b 1
)

echo   [2/3] Freezing basiq_agent.py (this reads the whole 2-3GB dependency
echo         chain once, so it takes a few minutes)...
"%VENV_PY%" -m PyInstaller --noconfirm --distpath dist --workpath work basiq_agent.spec
if errorlevel 1 (
  echo   PyInstaller build failed — see the traceback above.
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
"%ISCC%" installer.iss
if errorlevel 1 (
  echo   Inno Setup compile failed — see the output above.
  exit /b 1
)

echo.
echo   Done: build\installer_output\Basiq-Agent-Setup.exe
