@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM =====================================================================
REM  Basiq Studio Hub - ONE-TIME SETUP
REM
REM  Give a teammate this whole "tools" folder and tell them to double-
REM  click THIS file. It installs everything, asks one question (where's
REM  the shared drive), puts a shortcut on the Desktop, and starts the
REM  agent. After today they only ever use that Desktop shortcut.
REM =====================================================================

echo.
echo   ===========================================
echo    Basiq Studio Hub - one-time setup
echo   ===========================================
echo.

REM ---- Python ---------------------------------------------------------
where python >nul 2>nul
if errorlevel 1 (
  echo   Python isn't installed. Installing it now - this needs your OK
  echo   in the popup that appears...
  echo.
  winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements
  if errorlevel 1 (
    echo.
    echo   Could not install Python automatically.
    echo   Go to https://python.org/downloads and install it yourself -
    echo   tick "Add python.exe to PATH" during install - then double-click
    echo   this file again.
    echo.
    pause
    exit /b 1
  )
  echo.
  echo   Python is installed, but this window needs to close so Windows
  echo   picks up the change. Please double-click Basiq-Setup.bat again
  echo   to continue.
  echo.
  pause
  exit /b 0
)
echo   [ok] Python found.

REM ---- FFmpeg -----------------------------------------------------------
where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo   Installing FFmpeg - needed for downloads and clip export...
  winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements >nul
  if errorlevel 1 (
    echo   [!] Could not install FFmpeg automatically. Live capture and clip
    echo       export won't work until it's installed - everything else will.
  ) else (
    echo   [ok] FFmpeg installed.
  )
) else (
  echo   [ok] FFmpeg found.
)

REM ---- Python environment + packages ------------------------------------
if not exist ".venv\Scripts\python.exe" (
  echo.
  echo   Setting up the agent - this downloads about 3.5 GB total and only
  echo   happens this one time. Go grab a coffee; this takes a few minutes.
  echo.
  python -m venv .venv
  .venv\Scripts\python.exe -m pip install --upgrade pip --quiet
  .venv\Scripts\python.exe -m pip install -r requirements.txt
  if errorlevel 1 (
    echo.
    echo   Package install failed - check your internet connection and
    echo   double-click Basiq-Setup.bat again.
    pause
    exit /b 1
  )
  echo   Downloading the speech and language models...
  .venv\Scripts\python.exe setup_models.py
) else (
  echo   [ok] Agent already installed.
)

REM ---- Shared drive folder -----------------------------------------------
set "SUGGESTED=C:\Volumes\md-pac\media\Archive\Basiq-Studio-Hub"
set "CURRENT="
if exist "media_root.txt" set /p CURRENT=<media_root.txt

echo.
echo   ===========================================
echo    Where is the shared media drive?
echo   ===========================================
echo.
echo   This is the LucidLink folder your team shares footage on. Ask your
echo   team lead if you're not sure - everyone must point at the exact
echo   same folder for the shared library to work.
echo.
if defined CURRENT (
  echo   Currently set to: !CURRENT!
  echo   Press Enter to keep it, or type a new path.
) else (
  echo   Suggested: %SUGGESTED%
  echo   Press Enter to accept that, or type a different path.
)
echo.
set "TYPED="
set /p TYPED="  Folder path: "

if defined TYPED (
  set "MEDIA_ROOT_TO_SAVE=!TYPED!"
) else if defined CURRENT (
  set "MEDIA_ROOT_TO_SAVE=!CURRENT!"
) else (
  set "MEDIA_ROOT_TO_SAVE=%SUGGESTED%"
)

> media_root.txt echo !MEDIA_ROOT_TO_SAVE!
echo   Saved.

if not exist "!MEDIA_ROOT_TO_SAVE!" (
  echo.
  echo   [!] That folder doesn't exist on this PC yet - probably because
  echo       LucidLink hasn't finished mounting, or it uses a different
  echo       drive letter here. The agent will report this until the
  echo       folder shows up; rerun Basiq-Setup.bat once it does to fix it.
)

REM ---- Desktop shortcut ---------------------------------------------------
echo.
echo   Adding a "Start Basiq Agent" icon to your Desktop...
powershell -NoProfile -Command ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('%USERPROFILE%\Desktop\Start Basiq Agent.lnk');" ^
  "$s.TargetPath = '%~dp0start-agent.bat';" ^
  "$s.WorkingDirectory = '%~dp0';" ^
  "$s.IconLocation = 'shell32.dll,13';" ^
  "$s.Description = 'Start the Basiq Studio Hub agent';" ^
  "$s.Save()"
if errorlevel 1 (
  echo   [!] Couldn't create the Desktop shortcut - not a problem, you can
  echo       still use start-agent.bat directly in this folder.
) else (
  echo   [ok] Shortcut created.
)

echo.
echo   ===========================================
echo    Setup complete!
echo   ===========================================
echo.
echo   From now on: double-click "Start Basiq Agent" on your Desktop
echo   whenever you want to work, then open basiq-studio-web.vercel.app
echo   in your browser. Leave the black window open while you work.
echo.
echo   Starting it now so you can check it's working...
echo.
pause
call start-agent.bat
