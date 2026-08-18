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
    AUTH_TOKEN        must match the cloud agent's AUTH_TOKEN exactly
    MEDIA_ROOT        this machine's path to the same shared drive the cloud
                      agent writes to (e.g. a mapped LucidLink drive)
    WORKER_ID         defaults to this machine's hostname
    POLL_SECONDS      how often to check for new jobs (default 4)

Run it:
    python basiq_worker.py
"""
from __future__ import annotations

import json
import os
import platform
import threading
import time
import urllib.error
import urllib.request
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
# --------------------------------------------------------------------------- #
_local_jobs: dict[str, dict[str, Any]] = {}
_local_lock = threading.Lock()


def _relay_set_job(job_id: str, **fields: Any) -> None:
    with _local_lock:
        _local_jobs.setdefault(job_id, {}).update(fields)
    try:
        _post(f"/worker/jobs/{job_id}/update", fields)
    except Exception as exc:
        # A dropped progress update is cosmetic (the next tick sends a fresh
        # one); it must never take down the download thread that's actually
        # doing the work.
        print(f"[worker] progress relay failed for {job_id}: {exc}")


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
    while job_id in _local_jobs and _local_jobs[job_id].get("status") not in ("Complete", "Error"):
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


def main() -> None:
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
