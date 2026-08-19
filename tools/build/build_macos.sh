#!/usr/bin/env bash
# Build Basiq Agent.dmg on macOS.
#
# UNTESTED — written on a Windows machine with no Mac available to run this
# on. PyInstaller can't cross-compile, so nobody has actually executed this
# script; it's a documented starting point per the mac wheels of every
# dependency (torch, ctranslate2, spaCy...) needing to be resolved by pip
# running ON macOS, not carried over from the Windows build. See
# tools/build/README.md for the specific risk points to check on a first run.
set -euo pipefail
cd "$(dirname "$0")"

VENV_PY="../.venv/bin/python"
if [ ! -x "$VENV_PY" ]; then
  echo "tools/.venv isn't set up yet. From tools/, run:"
  echo "  python3 -m venv .venv"
  echo "  .venv/bin/python -m pip install -r requirements.txt"
  echo "then re-run this script."
  exit 1
fi

echo "[1/4] Installing build-only dependencies into the agent's venv..."
"$VENV_PY" -m pip install --quiet --upgrade pyinstaller pyinstaller-hooks-contrib

echo "[2/4] Freezing basiq_agent.py (reads the whole 2-3GB dependency chain"
echo "      once, so this takes a few minutes)..."
"$VENV_PY" -m PyInstaller --noconfirm --distpath dist --workpath work basiq_agent_macos.spec

APP="dist/Basiq Agent.app"

echo "[3/4] Ad-hoc signing (no paid Apple Developer account needed, but this"
echo "      is NOT notarization — first launch will still need right-click"
echo "      -> Open, same as Basiq-Setup.command today)..."
codesign --force --deep --sign - "$APP"

echo "[4/4] Packaging as a drag-to-Applications .dmg..."
rm -rf dist/dmg_staging
mkdir -p dist/dmg_staging
cp -R "$APP" dist/dmg_staging/
ln -s /Applications dist/dmg_staging/Applications
mkdir -p installer_output
hdiutil create -volname "Basiq Agent" -srcfolder dist/dmg_staging \
  -ov -format UDZO installer_output/Basiq-Agent-Setup.dmg
rm -rf dist/dmg_staging

echo
echo "Done: tools/build/installer_output/Basiq-Agent-Setup.dmg"
echo "Mount it, drag Basiq Agent.app to Applications, eject — no extraction step."
