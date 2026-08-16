#!/usr/bin/env bash
# =====================================================================
#  Basiq Studio Hub - agent installer (macOS / Linux)
#
#  Run once:   bash install.sh
#  Then start: bash start-agent.sh
# =====================================================================
set -u
cd "$(dirname "$0")"

echo
echo "  Basiq Studio Hub - agent setup"
echo "  =============================="
echo

# ---- Python ---------------------------------------------------------
PY=""
for candidate in python3.12 python3.11 python3.10 python3; do
  if command -v "$candidate" >/dev/null 2>&1; then PY="$candidate"; break; fi
done
if [ -z "$PY" ]; then
  echo "  Python 3.10+ was not found."
  echo "  macOS:  brew install python@3.12"
  echo "  Linux:  sudo apt install python3 python3-venv"
  exit 1
fi
echo "  Using $($PY --version)"

# ---- FFmpeg ---------------------------------------------------------
# Needed for live capture and for exporting clips from the shared drive.
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo
  echo "  FFmpeg was not found."
  if command -v brew >/dev/null 2>&1; then
    echo "  Installing with Homebrew..."
    brew install ffmpeg || echo "  Homebrew install failed - install FFmpeg manually."
  else
    echo "  Install it with:  sudo apt install ffmpeg    (or brew install ffmpeg)"
    echo "  Everything except live capture and clip export will still work."
  fi
else
  echo "  FFmpeg found."
fi

# ---- Virtual environment --------------------------------------------
if [ ! -d ".venv" ]; then
  echo
  echo "  Creating the Python environment..."
  "$PY" -m venv .venv || { echo "  Could not create the environment."; exit 1; }
fi

echo
echo "  Installing packages. About 2 GB, a few minutes, once only."
echo
./.venv/bin/python -m pip install --upgrade pip --quiet
./.venv/bin/python -m pip install -r requirements.txt || {
  echo; echo "  Package installation failed. Check your connection and rerun."; exit 1; }

# ---- Models ---------------------------------------------------------
echo
echo "  Downloading the speech and language models (about 1.5 GB)..."
./.venv/bin/python setup_models.py || \
  echo "  Model download had a problem; the agent will retry on first use."

echo
echo "  =============================================="
echo "   Setup complete."
echo
echo "   Start the agent:  bash start-agent.sh"
echo "  =============================================="
echo
