#!/usr/bin/env bash
# =====================================================================
#  Start the Basiq capture worker. Double-click this on the ONE
#  designated always-on machine. Leave the Terminal window open;
#  closing it stops the worker -- any queued GRAB/GO LIVE jobs just wait
#  for it to come back, nothing is lost.
#
#  Configure once: copy worker_config.txt.example to worker_config.txt
#  and fill in AGENT_URL, AUTH_TOKEN, MEDIA_ROOT.
# =====================================================================
set -u
cd "$(dirname "$0")"

if [ ! -f "worker_config.txt" ]; then
  echo
  echo "  worker_config.txt is missing."
  echo "  Copy worker_config.txt.example to worker_config.txt and fill it in."
  echo
  read -r -p "  Press Enter to close..."
  exit 1
fi

# Deliberately not `source`d: a plain KEY=VALUE line is easier to write
# correctly than real shell syntax, and this way a path with a space in
# MEDIA_ROOT needs no quoting.
while IFS='=' read -r key value; do
  case "$key" in
    ''|\#*) continue ;;
  esac
  export "$key=$value"
done < worker_config.txt

for var in AGENT_URL AUTH_TOKEN MEDIA_ROOT; do
  if [ -z "${!var:-}" ]; then
    echo "  $var is missing from worker_config.txt."
    read -r -p "  Press Enter to close..."
    exit 1
  fi
done

if [ ! -x ".venv/bin/python" ]; then
  echo
  echo "  The agent isn't installed yet. Run Basiq-Setup.command first --"
  echo "  the worker reuses the same Python environment as the agent."
  echo
  read -r -p "  Press Enter to close..."
  exit 1
fi

echo "  Worker: $(hostname)"
echo "  Agent:  $AGENT_URL"
echo "  Media:  $MEDIA_ROOT"
echo

./.venv/bin/python basiq_worker.py

echo
echo "  The worker has stopped."
read -r -p "  Press Enter to close..."
