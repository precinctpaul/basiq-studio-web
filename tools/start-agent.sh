#!/usr/bin/env bash
# Start the Basiq agent. Leave this running while you work.
#
# SHARED DRIVE: point MEDIA_ROOT at the team's LucidLink folder so everyone
# sees the same library. Uncomment and edit the line below.
set -u
cd "$(dirname "$0")"

# export MEDIA_ROOT="/Volumes/md-pac/media/Archive/Basiq-Studio-Hub"
# export COOKIES_FROM_BROWSER=chrome

if [ ! -x ".venv/bin/python" ]; then
  echo
  echo "  The agent isn't installed yet. Run:  bash install.sh"
  echo
  exit 1
fi

if [ -n "${MEDIA_ROOT:-}" ]; then
  echo "  Shared media root: $MEDIA_ROOT"
else
  echo "  No MEDIA_ROOT set - media will be kept in tools/media on this Mac."
  echo "  Edit start-agent.sh to point at the team's shared folder."
fi
echo

exec ./.venv/bin/python basiq_agent.py
