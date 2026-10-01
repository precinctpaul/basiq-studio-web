#!/bin/bash
# Sets up a Mac as an always-on Basiq backup worker (tools/mesh_worker.py).
# Stage-1 path for the dedicated node; the double-click teammate installer
# (stage 2) replaces this. Safe to re-run: it updates in place.
#
#   bash tools/build/mesh/install-mac-node.sh BQ-XXXX-XXXX-XXXX ["Node name"]
#
# Needs: Homebrew (https://brew.sh) for ffmpeg/deno if they aren't already
# installed, and LucidLink installed + signed in with the archive filespace
# mounted (the worker uploads over HTTPS meanwhile if it isn't).
set -euo pipefail

CODE="${1:-}"
NAME="${2:-$(scutil --get ComputerName 2>/dev/null || hostname)}"
AGENT_URL="${BASIQ_AGENT_URL:-https://basiq.51st.media/agent}"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
TOOLS="$REPO/tools"
VENV="$TOOLS/.venv-worker"
LABEL="media.basiq.worker"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/Library/Application Support/BasiqWorker"

say() { printf '\n==> %s\n' "$*"; }

say "Checking tools"
for bin in ffmpeg deno; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    if command -v brew >/dev/null 2>&1; then
      brew install "$bin"
    else
      echo "Missing $bin and no Homebrew. Install Homebrew from https://brew.sh, then re-run." >&2
      exit 1
    fi
  fi
done
PY="$(command -v python3.12 || command -v python3.11 || command -v python3 || true)"
if [ -z "$PY" ] || ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; then
  if command -v brew >/dev/null 2>&1; then brew install python@3.12; PY="$(brew --prefix)/bin/python3.12"
  else echo "Need Python 3.10+ (or Homebrew to install it)." >&2; exit 1; fi
fi
echo "python: $PY  ffmpeg: $(command -v ffmpeg)  deno: $(command -v deno)"

say "Installing the worker into $VENV"
"$PY" -m venv "$VENV"
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q -r "$TOOLS/requirements-worker.txt"
"$VENV/bin/pip" install -q --pre --upgrade yt-dlp

if [ -n "$CODE" ]; then
  say "Enrolling as \"$NAME\""
  "$VENV/bin/python" "$TOOLS/mesh_worker.py" enroll --agent "$AGENT_URL" --code "$CODE" --name "$NAME"
elif [ ! -f "$LOGDIR/worker.json" ]; then
  echo "No enrollment code given and not enrolled yet. Get a code from the admin console." >&2
  exit 1
fi

say "Starting at login, keeping the Mac awake while it runs"
mkdir -p "$HOME/Library/LaunchAgents" "$LOGDIR"
BREW_PATH="$(dirname "$(command -v ffmpeg)"):$(dirname "$(command -v deno)")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <!-- caffeinate -is: no idle/system sleep while the worker runs (on power). -->
    <string>/usr/bin/caffeinate</string><string>-is</string>
    <string>$VENV/bin/python</string><string>$TOOLS/mesh_worker.py</string><string>run</string>
  </array>
  <key>WorkingDirectory</key><string>$TOOLS</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$BREW_PATH:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <!-- Restart after a crash or an update/restart command (non-zero exit);
       stay stopped after revoke/uninstall (exit 0). -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOGDIR/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/launchd.err.log</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 3
"$VENV/bin/python" "$TOOLS/mesh_worker.py" status
say "Done. It should show as online in the admin console within ~15 seconds."
echo "Log: $LOGDIR/worker.log"
echo "Tip: System Settings > Battery/Energy > prevent sleeping when the display is off (on power adapter)."
