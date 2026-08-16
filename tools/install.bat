@echo off
setlocal

REM =====================================================================
REM  Basiq Studio Hub - agent installer (Windows)
REM
REM  Run this ONCE. It builds an isolated Python environment beside this
REM  script, installs everything, and pre-downloads the models so the first
REM  real transcription isn't a surprise ten-minute wait.
REM
REM  Afterwards, start the agent by double-clicking start-agent.bat.
REM =====================================================================

cd /d "%~dp0"
echo.
echo   Basiq Studio Hub - agent setup
echo   ==============================
echo.

REM ---- Python -------------------------------------------------------
where python >nul 2>nul
if errorlevel 1 (
  echo   Python was not found.
  echo.
  echo   Install Python 3.10 or newer from https://python.org/downloads
  echo   IMPORTANT: tick "Add python.exe to PATH" in the installer.
  echo.
  pause
  exit /b 1
)

for /f "tokens=2" %%v in ('python --version 2^>^&1') do set PYVER=%%v
echo   Python %PYVER% found.

REM ---- FFmpeg -------------------------------------------------------
REM Needed for live capture and for exporting clips from the shared drive.
where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo.
  echo   FFmpeg was not found. Installing it with winget...
  winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
  if errorlevel 1 (
    echo.
    echo   Could not install FFmpeg automatically.
    echo   Download it from https://ffmpeg.org/download.html and add it to PATH.
    echo   Everything except live capture and clip export will still work.
    echo.
  ) else (
    echo   FFmpeg installed. You may need to reopen this window for it to be found.
  )
) else (
  echo   FFmpeg found.
)

REM ---- Virtual environment ------------------------------------------
if not exist ".venv" (
  echo.
  echo   Creating the Python environment...
  python -m venv .venv
  if errorlevel 1 (
    echo   Could not create the environment. Is Python installed correctly?
    pause
    exit /b 1
  )
)

echo.
echo   Installing packages. This downloads about 2 GB and takes a few
echo   minutes on a normal connection - it only happens once.
echo.
.venv\Scripts\python.exe -m pip install --upgrade pip --quiet
.venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 (
  echo.
  echo   Package installation failed. Check your internet connection and rerun.
  pause
  exit /b 1
)

REM ---- Models -------------------------------------------------------
REM Pulled now rather than on first use, so nobody's first transcription
REM looks like a hang.
echo.
echo   Downloading the speech and language models (about 1.5 GB)...
.venv\Scripts\python.exe setup_models.py
if errorlevel 1 (
  echo.
  echo   Model download had a problem. The agent will still start and will
  echo   retry on first use.
)

echo.
echo   ==============================================
echo    Setup complete.
echo.
echo    Start the agent:  double-click start-agent.bat
echo   ==============================================
echo.
pause
