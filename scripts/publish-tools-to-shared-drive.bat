@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0\.."

REM =====================================================================
REM  Publish a clean tools\ folder to the shared LucidLink drive.
REM
REM  Run this any time tools\ changes (Basiq-Setup.bat, basiq_agent.py,
REM  requirements.txt, etc.) so teammates always copy a small, git-clean
REM  folder - never a machine's own .venv\hf_cache\whisper_cache\media by
REM  accident. That mistake is what turned a 300KB folder into a 6GB,
REM  16,000-item copy that had no setup script in it at all.
REM
REM  Uses `git archive`, so only files committed to git ever leave this
REM  machine. Then robocopy /MIR deletes anything at the destination that
REM  git doesn't track - so even if someone's local build artifacts get
REM  dropped in later, the next publish wipes them back out.
REM =====================================================================

REM  This is the ONE canonical shared-drive location - not the media root
REM  (that's wherever media_root.txt points, a separate thing). Override
REM  with an argument only for local testing.
set "DEST=%~1"
if not defined DEST set "DEST=C:\Volumes\md-pac\media\Scripts\basiq-studio-hub"

echo.
echo   Publishing tools\ -^> "!DEST!"
echo.

if not exist "!DEST!" mkdir "!DEST!"

set "STAGING=%TEMP%\basiq-tools-publish"
if exist "!STAGING!" rmdir /s /q "!STAGING!"
mkdir "!STAGING!"

git archive HEAD -- tools | tar -x -C "!STAGING!"
if errorlevel 1 (
  echo   git archive failed - run this from inside the repo, with tools\
  echo   files committed.
  pause
  exit /b 1
)

robocopy "!STAGING!\tools" "!DEST!" /MIR /NFL /NDL /NJH >nul

rmdir /s /q "!STAGING!"

echo   [ok] Published.
echo.
for /f %%c in ('dir /a-d /s /b "!DEST!" ^| find /c /v ""') do echo   Files at destination: %%c
echo.
echo   If that number looks like more than ~15, something other than this
echo   script wrote into that folder - check for a stray .venv, hf_cache,
echo   whisper_cache, or media directory and remove it.
echo.
pause
