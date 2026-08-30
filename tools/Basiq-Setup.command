#!/usr/bin/env bash
# =====================================================================
#  Basiq Studio Hub - ONE-TIME SETUP (macOS)
#
#  Give a teammate this whole "tools" folder and tell them to double-
#  click THIS file. It installs everything, asks one question (where's
#  the shared drive), puts a shortcut on the Desktop, and starts the
#  agent. After today they only ever use that Desktop shortcut.
# =====================================================================
set -u
cd "$(dirname "$0")"

echo
echo "  ==========================================="
echo "   Basiq Studio Hub - one-time setup"
echo "  ==========================================="
echo

# ---- Homebrew ---------------------------------------------------------
if ! command -v brew >/dev/null 2>&1; then
  echo "  Homebrew isn't installed. Installing it now - macOS will ask for"
  echo "  your login password in a moment, that's normal..."
  echo
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if ! command -v brew >/dev/null 2>&1; then
    # Apple Silicon Macs install Homebrew under /opt/homebrew, which a brand
    # new shell may not have on PATH yet even though the install succeeded.
    if [ -x "/opt/homebrew/bin/brew" ]; then
      eval "$(/opt/homebrew/bin/brew shellenv)"
    fi
  fi
  if ! command -v brew >/dev/null 2>&1; then
    echo
    echo "  Could not install Homebrew automatically."
    echo "  Go to https://brew.sh, follow the instructions there, then"
    echo "  double-click this file again."
    echo
    read -r -p "  Press Enter to close..."
    exit 1
  fi
fi
echo "  [ok] Homebrew found."

# ---- Python -------------------------------------------------------
PY=""
for candidate in python3.12 python3.11 python3.10 python3; do
  if command -v "$candidate" >/dev/null 2>&1; then PY="$candidate"; break; fi
done
if [ -z "$PY" ]; then
  echo "  Installing Python..."
  brew install python@3.12
  PY="python3"
  if ! command -v "$PY" >/dev/null 2>&1; then
    echo
    echo "  Could not install Python automatically."
    echo "  Run 'brew install python@3.12' yourself, then double-click"
    echo "  this file again."
    echo
    read -r -p "  Press Enter to close..."
    exit 1
  fi
fi
echo "  [ok] $($PY --version) found."

# ---- FFmpeg -----------------------------------------------------------
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "  Installing FFmpeg - needed for downloads and clip export..."
  if brew install ffmpeg; then
    echo "  [ok] FFmpeg installed."
  else
    echo "  [!] Could not install FFmpeg automatically. Live capture and clip"
    echo "      export won't work until it's installed - everything else will."
  fi
else
  echo "  [ok] FFmpeg found."
fi

# ---- Python environment + packages ------------------------------------
if [ ! -x ".venv/bin/python" ]; then
  echo
  echo "  Setting up the agent - this downloads about 3.5 GB total and only"
  echo "  happens this one time. Go grab a coffee; this takes a few minutes."
  echo
  "$PY" -m venv .venv
  ./.venv/bin/python -m pip install --upgrade pip --quiet
  if ! ./.venv/bin/python -m pip install -r requirements.txt; then
    echo
    echo "  Package install failed - check your internet connection and"
    echo "  double-click Basiq-Setup.command again."
    read -r -p "  Press Enter to close..."
    exit 1
  fi
  echo "  Downloading the speech and language models..."
  ./.venv/bin/python setup_models.py
else
  echo "  [ok] Agent already installed."
fi

# ---- Shared drive folder -----------------------------------------------
SUGGESTED="/Volumes/md-pac/media/Archive/Basiq-Studio-Hub"
CURRENT=""
if [ -f "media_root.txt" ]; then
  CURRENT="$(cat media_root.txt)"
fi

echo
echo "  ==========================================="
echo "   Where is the shared media drive?"
echo "  ==========================================="
echo
echo "  This is the LucidLink folder your team shares footage on. Ask your"
echo "  team lead if you're not sure - everyone must point at the exact"
echo "  same folder for the shared library to work."
echo
if [ -n "$CURRENT" ]; then
  echo "  Currently set to: $CURRENT"
  echo "  Press Enter to keep it, or type a new path."
else
  echo "  Suggested: $SUGGESTED"
  echo "  Press Enter to accept that, or type a different path."
fi
echo
read -r -p "  Folder path: " TYPED

if [ -n "$TYPED" ]; then
  MEDIA_ROOT_TO_SAVE="$TYPED"
elif [ -n "$CURRENT" ]; then
  MEDIA_ROOT_TO_SAVE="$CURRENT"
else
  MEDIA_ROOT_TO_SAVE="$SUGGESTED"
fi

printf '%s' "$MEDIA_ROOT_TO_SAVE" > media_root.txt
echo "  Saved."

if [ ! -d "$MEDIA_ROOT_TO_SAVE" ]; then
  echo
  echo "  [!] That folder doesn't exist on this Mac yet - probably because"
  echo "      LucidLink hasn't finished mounting, or it mounts under a"
  echo "      different name here. The agent will report this until the"
  echo "      folder shows up; rerun Basiq-Setup.command once it does to fix it."
fi

# ---- Desktop shortcut ---------------------------------------------------
echo
echo "  Adding a \"Start Basiq Agent\" icon to your Desktop..."
chmod +x "$(pwd)/start-agent.command" "$(pwd)/Basiq-Setup.command" 2>/dev/null || true
if ln -sf "$(pwd)/start-agent.command" "$HOME/Desktop/Start Basiq Agent.command" 2>/dev/null; then
  echo "  [ok] Shortcut created."
else
  echo "  [!] Couldn't create the Desktop shortcut - not a problem, you can"
  echo "      still double-click start-agent.command directly in this folder."
fi

echo
echo "  ==========================================="
echo "   Setup complete!"
echo "  ==========================================="
echo
echo "  From now on: double-click \"Start Basiq Agent\" on your Desktop"
echo "  whenever you want to work, then open basiq-studio-web.vercel.app"
echo "  in your browser. Leave the Terminal window open while you work."
echo
echo "  Starting it now so you can check it's working..."
echo
read -r -p "  Press Enter to continue..."
exec ./start-agent.command
