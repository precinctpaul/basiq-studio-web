"""
basiq_worker.py — runs GRAB/GO LIVE jobs on a residential IP instead of the
cloud droplet.

YouTube bot-blocks the droplet's datacenter IP: 403s, "sign in to confirm
you're not a bot", PO-token warnings, on every yt-dlp download and live
capture. It does not block a normal residential connection. Rather than
fight that with proxies or cookie hacks, the cloud agent (basiq_agent.py,
running with DELEGATE_TO_WORKER=1) leaves GRAB/CAPTURE jobs "Queued" instead
of running them, and this script — running on one designated always-on
Windows/Mac machine on a normal home/office connection — claims them and
does the actual download.

It deliberately does NOT reimplement any download/capture logic. It imports
basiq_agent.py itself and calls run_grab()/run_live_capture() unchanged —
the two functions this script drives are exactly the ones the cloud agent
would have called locally. The only trick is that those functions report
progress by calling the plain module-level set_job()/get_job() (see
basiq_agent.py's Jobs section) rather than through a class, so this script
replaces those two names with versions that relay to the cloud over HTTPS
instead of writing to a local dict.

Configure with environment variables (same idea as basiq_agent.py):
    AGENT_URL        https://basiq.51st.media/agent   (the cloud agent, no
                                                       trailing slash)
    AUTH_TOKEN       must match the cloud agent's AUTH_TOKEN exactly
    MEDIA_ROOT       this machine's path to the same shared drive the cloud
                     agent writes to (e.g. a mapped LucidLink drive)
    WORKER_ID        defaults to this machine's hostname
    POLL_SECONDS     how often to check for new jobs (default 4)

Run it:
    python basiq_worker.py
"""
from __future__ import annotations

import atexit
import json
import os
import platform
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

AGENT_URL = os.environ.get("AGENT_URL", "").rstrip("/")
AUTH_TOKEN = os.environ.get("AUTH_TOKEN", "")
WORKER_ID = os.environ.get("WORKER_ID", "") or platform.node() or "worker"
POLL_SECONDS = float(os.environ.get("POLL_SECONDS", "4"))

if not AGENT_URL:
    raise SystemExit("AGENT_URL is not set — e.g. https://basiq.51st.media/agent")
if not AUTH_TOKEN:
    raise SystemExit(
        "AUTH_TOKEN is not set. This must match the cloud agent's AUTH_TOKEN "
        "exactly, or every request below will 401."
    )

# basiq_agent reads MEDIA_ROOT at import time, so this has to happen before
# the import below — it's what points run_grab/run_live_capture at this
# machine's copy of the shared drive instead of a local "media" folder.
if "MEDIA_ROOT" not in os.environ:
    raise SystemExit(
        "MEDIA_ROOT is not set — point it at this machine's path to the same "
        "shared drive the cloud agent writes to."
    )

import basiq_agent  # noqa: E402  (must follow the MEDIA_ROOT env check above)


# --------------------------------------------------------------------------- #
# HTTP to the cloud agent — plain urllib, matching basiq_agent.py's own style
# so this script needs no dependency beyond what basiq_agent.py already has.
# --------------------------------------------------------------------------- #
def _request(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    url = f"{AGENT_URL}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {AUTH_TOKEN}",
        "Content-Type": "application/json",
    })
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read() or b"{}")


def _get(path: str) -> dict[str, Any]:
    return _request("GET", path)


def _post(path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    return _request("POST", path, body or {})


# --------------------------------------------------------------------------- #
# Bridge run_grab()/run_live_capture()'s progress reporting to the cloud.
#
# Those functions only ever call the plain module-level set_job()/get_job()
# (never a class method), so replacing those two names on the basiq_agent
# module redirects every internal call — no changes to basiq_agent.py's
# download/capture logic itself. A local mirror is kept alongside the relay
# because run_live_capture calls get_job() once, to read back the elapsed
# `seconds` it reported earlier — round-tripping to the cloud for that would
# be slower and adds a failure mode for no benefit.
#
# The relay itself runs off-thread and is throttled (see RELAY_MIN_INTERVAL
# below): yt-dlp's progress hook can fire many times a second on a real
# download, and each relay used to be a synchronous HTTPS round-trip on the
# SAME thread doing the download — so a slow or timed-out handshake to the
# cloud stalled the download itself, sometimes for the full 15s urlopen
# timeout, on every single tick. Firing relays from a background thread and
# collapsing frequent ticks down to roughly one per second fixes both the
# stall and the request volume that was likely triggering the timeouts.
# --------------------------------------------------------------------------- #
_local_jobs: dict[str, dict[str, Any]] = {}
_local_lock = threading.Lock()

_last_relay_time: dict[str, float] = {}
_relay_lock = threading.Lock()
RELAY_MIN_INTERVAL = 1.0  # seconds between relayed progress updates, per job

# Terminal statuses always relay immediately (never throttled/dropped) —
# these are the ones the DB/UI actually depends on for correctness, unlike
# an in-between percentage tick.
_TERMINAL_STATUSES = {"Complete", "Error"}


def _do_relay(job_id: str, fields: dict[str, Any]) -> None:
    # A blind 12-second sleep used to live here before every "Complete"
    # relay ("give LucidLink time to sync"). Removed 2026-08-27: it was an
    # unconditional fixed cost on every single job regardless of file size,
    # and it duplicated work the frontend already does properly -- page.tsx's
    # own runGrab() polls agentLibrary() in a backoff loop, checking the
    # actual reported file size until it's stable, rather than just
    # guessing a fixed wait. Two mechanisms solving the same problem, one
    # blind and one that actually checks reality; only the one that checks
    # reality needs to stay.
    # A dropped progress update is cosmetic (the next tick sends a fresh
    # one) EXCEPT for a terminal Complete/Error relay -- there is no next
    # tick for those, so losing one leaves the cloud-side job stuck at
    # whatever status it last saw forever (this worker has already moved on
    # and considers the job done). Retry those specifically; a single
    # attempt is still fine for an in-between percentage tick, which must
    # never take down the download thread actually doing the work anyway.
    is_terminal = fields.get("status") in _TERMINAL_STATUSES
    attempts = 5 if is_terminal else 1
    delay = 2.0
    for attempt in range(attempts):
        try:
            _post(f"/worker/jobs/{job_id}/update", fields)
            return
        except Exception as exc:
            if attempt < attempts - 1:
                print(f"[worker] progress relay attempt {attempt + 1} failed for {job_id}, retrying: {exc}")
                time.sleep(delay)
                delay = min(delay * 2, 30)
            else:
                print(f"[worker] progress relay failed for {job_id}: {exc}")


def _relay_set_job(job_id: str, **fields: Any) -> None:
    with _local_lock:
        _local_jobs.setdefault(job_id, {}).update(fields)

    status = fields.get("status")
    is_terminal = status in _TERMINAL_STATUSES

    if not is_terminal:
        now = time.time()
        with _relay_lock:
            last = _last_relay_time.get(job_id, 0.0)
            if now - last < RELAY_MIN_INTERVAL:
                return  # relayed recently enough for this job; skip this tick
            _last_relay_time[job_id] = now

    # Off-thread: even a fully hung network call can no longer block the
    # download thread that called set_job().
    threading.Thread(target=_do_relay, args=(job_id, dict(fields)), daemon=True).start()


def _relay_get_job(job_id: str) -> dict[str, Any] | None:
    with _local_lock:
        job = _local_jobs.get(job_id)
        return dict(job) if job else None


basiq_agent.set_job = _relay_set_job
basiq_agent.get_job = _relay_get_job


# --------------------------------------------------------------------------- #
# Stop bridge — only capture jobs are stoppable. The STOP button in the web
# UI hits the cloud's existing /jobs/<id>/stop, which sets a threading.Event
# in the CLOUD process. That object is invisible here, so one thread per
# active capture polls the cloud for whether a stop was requested and sets
# the LOCAL Event that run_capture() (inside run_live_capture) is actually
# watching.
# --------------------------------------------------------------------------- #
def _watch_for_stop(job_id: str) -> None:
    # _run_capture_job starts this thread and then calls run_live_capture
    # synchronously in the same breath -- _local_jobs[job_id] only exists
    # once that call makes its own first set_job(), which can easily lose
    # the race against this thread's very first loop check. The old
    # condition (`job_id in _local_jobs and ...`) treated "not there yet" the
    # same as "already finished" and returned immediately without ever
    # polling once -- confirmed 2026-08-31: an open-ended x.com capture (no
    # maxMinutes, so nothing else could ever stop it) ran for 12+ minutes
    # straight through four STOP clicks because of exactly this. Only a
    # status this loop has actually SEEN be terminal should end it.
    while True:
        with _local_lock:
            status = _local_jobs.get(job_id, {}).get("status")
        if status in ("Complete", "Error"):
            return
        try:
            if _get(f"/worker/jobs/{job_id}/stop-requested").get("stop"):
                basiq_agent._stop_flags.setdefault(job_id, threading.Event()).set()
                return
        except Exception as exc:
            print(f"[worker] stop-check failed for {job_id}: {exc}")
        time.sleep(2)


# --------------------------------------------------------------------------- #
# Claim + run
# --------------------------------------------------------------------------- #
_claimed: set[str] = set()


def _run_grab_job(job_id: str, req: dict[str, Any]) -> None:
    print(f"[worker] running grab {job_id}: {req.get('url')}")
    basiq_agent.run_grab(job_id, req["url"], req.get("quality") or "HD", bool(req.get("subs")))


def _run_capture_job(job_id: str, req: dict[str, Any]) -> None:
    print(f"[worker] running capture {job_id}: {req.get('url')}")
    threading.Thread(target=_watch_for_stop, args=(job_id,), daemon=True).start()
    basiq_agent.run_live_capture(
        job_id, req["url"], req.get("title") or "", float(req.get("maxMinutes") or 0.0),
    )


def _poll_once() -> None:
    jobs = _get("/worker/jobs?kind=grab,capture").get("jobs", [])
    for job in jobs:
        job_id = job["jobId"]
        if job_id in _claimed:
            continue
        try:
            _post(f"/worker/jobs/{job_id}/claim", {"workerId": WORKER_ID})
        except urllib.error.HTTPError as exc:
            if exc.code == 409:
                continue  # another worker got it first
            raise
        _claimed.add(job_id)

        req = job.get("request") or {}
        kind = job.get("kind")
        if kind == "grab":
            threading.Thread(target=_run_grab_job, args=(job_id, req), daemon=True).start()
        elif kind == "capture":
            threading.Thread(target=_run_capture_job, args=(job_id, req), daemon=True).start()
        else:
            print(f"[worker] job {job_id} has unrecognised kind {kind!r}, skipping")


# --------------------------------------------------------------------------- #
# Singleton lock — only one worker may run at a time. Confirmed (2026-08-31)
# a real incident: something ended up launching duplicate worker instances,
# and because run_capture()'s progress-reporting and stop-handling both key
# off the SAME job_id but live in each process's own separate memory, a stop
# request handled by one instance's threading.Event never reached whichever
# instance was actually running the ffmpeg subprocess -- the STOP button
# silently did nothing. A lock file holding the current PID prevents a
# second launch outright; the PID is verified actually alive (not just
# present) via tasklist, so a stale lock left behind by a crash doesn't
# permanently block every future start.
#
# The first version of this (check LOCK_PATH.exists(), then write it) had a
# real gap: two processes starting close together can both pass the
# exists()-and-dead-PID check before either has written its own PID, so both
# proceed. Confirmed 2026-08-31: killing a stuck worker and immediately
# hand-launching a replacement raced the Scheduled Task's own once-a-minute
# relaunch check, and FOUR instances ended up running at once. Claiming the
# lock with os.O_CREAT | O_EXCL closes that gap -- the OS guarantees only one
# caller can win that atomic create no matter how many start at the same
# instant; everyone else gets FileExistsError and only THEN falls back to
# checking (and clearing) a stale lock from a real crash.
# --------------------------------------------------------------------------- #
LOCK_PATH = Path(__file__).resolve().parent / "worker.lock"


def _pid_is_running(pid: int) -> bool:
    try:
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
            capture_output=True, text=True, timeout=10,
        ).stdout
    except Exception:
        return False
    return str(pid) in out


def _acquire_singleton_lock() -> None:
    while True:
        try:
            fd = os.open(str(LOCK_PATH), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            try:
                existing_pid = int(LOCK_PATH.read_text(encoding="utf-8").strip())
            except (ValueError, OSError):
                existing_pid = None
            if existing_pid and _pid_is_running(existing_pid):
                # Exit 0, not an error -- the scheduled task that keeps this
                # worker alive treats a non-zero exit as a crash and retries
                # near-instantly (confirmed 2026-08-31: that turned a single
                # rejection into a runaway retry loop). "Another instance has
                # this covered" is success, not failure.
                print(
                    f"Another worker is already running (PID {existing_pid}). "
                    f"Only one worker may run at a time -- exiting cleanly, "
                    f"not launching a second one alongside it."
                )
                sys.exit(0)
            # Stale lock (process from a crash that never cleaned up) -- clear
            # it and retry the atomic claim.
            try:
                LOCK_PATH.unlink()
            except OSError:
                pass
            continue
        else:
            with os.fdopen(fd, "w") as f:
                f.write(str(os.getpid()))
            atexit.register(lambda: LOCK_PATH.unlink(missing_ok=True))
            return


def main() -> None:
    _acquire_singleton_lock()
    print(f"Basiq worker '{WORKER_ID}' polling {AGENT_URL} every {POLL_SECONDS}s")
    print(f"  MEDIA_ROOT={basiq_agent.MEDIA_ROOT}")
    while True:
        try:
            _poll_once()
        except Exception as exc:
            print(f"[worker] poll error: {exc}")
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
