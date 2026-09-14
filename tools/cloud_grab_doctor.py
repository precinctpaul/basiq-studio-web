#!/usr/bin/env python3
"""Watches basiq-agent's own journal for a run of consecutive real GRAB jobs
that all hit YouTube's bot-check error -- the one thing a single job's own
3x internal retry can't tell apart from "the proxy/cookie fix broke again".

Read-only: parses journalctl output already written by the agent. Never
makes a request of its own to YouTube or anywhere else, per the standing
rule that only a real, human-initiated grab from the actual product UI is
an acceptable way to exercise anything YouTube-facing.

Run periodically (see the paired basiq-grab-doctor.timer), not continuously
-- GRAB traffic is bursty, not constant. A non-zero exit code on ALERT is
deliberate: it shows up in `systemctl --failed` for this oneshot service,
which is the loud, discoverable signal -- no separate notification channel
to build or maintain.
"""
from __future__ import annotations

import subprocess
import sys

SIGNATURE = "Sign in to confirm you’re not a bot"
THRESHOLD = 3  # consecutive distinct real jobs, not retries within one job
WINDOW = "6 hours ago"


def journal_lines() -> list[str]:
    out = subprocess.run(
        ["journalctl", "-u", "basiq-agent", "--since", WINDOW, "--no-pager", "-o", "cat"],
        capture_output=True, text=True, check=True,
    ).stdout
    return out.splitlines()


def grab_job_outcomes(lines: list[str]) -> list[bool]:
    """One bool per real GRAB job (True = hit the bot-check signature),
    in chronological order. A job's span runs from its own "POST /grab"
    line up to (but not including) the next one."""
    outcomes: list[bool] = []
    in_job = False
    bot_checked = False
    for line in lines:
        if '"POST /grab HTTP' in line:
            if in_job:
                outcomes.append(bot_checked)
            in_job = True
            bot_checked = False
        elif in_job and "[grab]" in line and "attempt 1 failed" in line and SIGNATURE in line:
            bot_checked = True
    if in_job:
        outcomes.append(bot_checked)
    return outcomes


def main() -> int:
    outcomes = grab_job_outcomes(journal_lines())
    tail = outcomes[-THRESHOLD:]
    if len(tail) == THRESHOLD and all(tail):
        print(
            f"\U0001F534 ALERT: the last {THRESHOLD} real GRAB jobs all hit "
            f"YouTube's bot-check error -- the proxy/cookie path may be down "
            f"again. Check /etc/basiq-agent.env's YTDLP_PROXY/COOKIES_FILE, "
            f"the droplet's yt-dlp version, and Decodo's dashboard for a "
            f"flagged IP before assuming it's the same fix as before."
        )
        return 1
    print(f"ok -- {len(outcomes)} real GRAB job(s) seen since {WINDOW}, no alert threshold hit")
    return 0


if __name__ == "__main__":
    sys.exit(main())
