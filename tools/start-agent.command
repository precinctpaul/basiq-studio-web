#!/usr/bin/env bash
# =====================================================================
#  Start the Basiq agent. Double-click this (or the Desktop shortcut
#  Basiq-Setup.command creates) whenever you want to work. Leave the
#  Terminal window open; closing it stops the agent.
#
#  SHARED DRIVE: read from media_root.txt, written once by
#  Basiq-Setup.command. No manual editing needed - rerun Basiq-Setup.command
#  to change it.
# =====================================================================
set -u
cd "$(dirname "$0")"

# export COOKIES_FROM_BROWSER=chrome
# export COOKIES_FILE="/path/to/cookies.txt"  # alternative if no logged-in browser here

if [ -f "media_root.txt" ]; then
  MEDIA_ROOT="$(cat media_root.txt)"
  export MEDIA_ROOT
fi

if [ ! -x ".venv/bin/python" ]; then
  echo
  echo "  The agent isn't installed yet."
  echo "  Run Basiq-Setup.command first."
  echo
  read -r -p "  Press Enter to close..."
  exit 1
fi

# ---- Free up port 8000 ----------------------------------------------
# A Terminal window closed with the red button can leave the previous
# agent running as an orphan - it then keeps answering the website with
# stale info (wrong folder, etc). Clear it before every start so this
# window is always the one in charge.
PIDS="$(lsof -ti:8000 2>/dev/null || true)"
if [ -n "$PIDS" ]; then
  kill -9 $PIDS 2>/dev/null || true
fi

if [ -n "${MEDIA_ROOT:-}" ]; then
  echo "  Shared media root: $MEDIA_ROOT"
else
  echo "  No shared folder set - media will be kept in tools/media on this Mac."
  echo "  Run Basiq-Setup.command to point at the team's shared folder."
fi
echo

./.venv/bin/python basiq_agent.py

echo
echo "  The agent has stopped."
read -r -p "  Press Enter to close..."
