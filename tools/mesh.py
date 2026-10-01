"""Worker mesh -- the cloud side. Runs inside basiq_agent.py on the droplet.

Cloud first, never "failed because of blocking": a GRAB runs on the droplet
as always. If every cloud route fails for a reason a different network
could fix (YouTube bot-check, 403, 429, timeouts -- see basiq_agent's
_retryable()), the job is NOT failed. It's queued here for a *worker*: a
small program on a teammate's machine or a dedicated always-on node
(tools/mesh_worker.py), on a real home/office connection. Routing is
automatic, nobody picks anything:

  1. a worker on the SAME network as whoever clicked GRAB, immediately.
     Matched by public IP: the web app has no logins, and "same network"
     is exactly what matters to YouTube anyway -- it keeps each person's
     YouTube traffic on their own connection, at normal-person volume.
  2. always-on nodes (flagged in the admin console) -- immediately if (1)
     has nobody online, otherwise after TIER_GRACE_SECONDS.
  3. any other online worker, after a further TIER_GRACE_SECONDS.

If no worker is online, the cloud retries every CLOUD_RETRY_SECONDS; the
job only errors after MESH_MAX_WAIT_SECONDS. Every grab that hasn't
finished is saved to disk (pending_grabs.json) and resumed after an agent
restart, so a deploy or an unattended-upgrade restart can't lose one.

Filing: a worker downloads straight into its own LucidLink mount. The
droplet marks the job Complete only once it can see that file in ITS OWN
LucidLink mount at the full size (that's what catches "landed locally,
never synced", 2026-09-12). If it can't within VERIFY_TIMEOUT_SECONDS -- or
the worker's LucidLink is down -- the worker uploads the file over HTTPS
and the droplet files it. The droplet does every database write; a worker
never holds a Supabase key.

Auth: workers enroll once with a team code and get their own key (only a
hash is stored here; revocable). /admin/* takes ADMIN_TOKEN, which only the
web app's server holds -- the browser never sees it.

State lives in DATA_DIR/mesh.json, designed to grow: unknown keys are kept,
and every record is a plain dict.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

ONLINE_SECONDS = 45            # a worker heartbeats every ~10s
TIER_GRACE_SECONDS = float(os.environ.get("MESH_TIER_GRACE_SECONDS", "8"))
STALE_CLAIM_SECONDS = 120      # claimed but silent this long -> back in the queue
CLOUD_RETRY_SECONDS = float(os.environ.get("MESH_CLOUD_RETRY_SECONDS", "300"))
MESH_MAX_WAIT_SECONDS = float(os.environ.get("MESH_MAX_WAIT_SECONDS", str(6 * 3600)))
MAX_WORKER_TRIES = int(os.environ.get("MESH_MAX_WORKER_TRIES", "4"))   # per job, across all workers
VERIFY_TIMEOUT_SECONDS = float(os.environ.get("MESH_VERIFY_TIMEOUT_SECONDS", "480"))
TICK_SECONDS = float(os.environ.get("MESH_TICK_SECONDS", "5"))
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")

FINAL = ("Complete", "Error")
STATUS_WAITING = "Trying a backup route…"

_agent: Any = None             # basiq_agent module, set by bind()
_lock = threading.RLock()
_state: dict[str, Any] = {}
_state_file: Path | None = None
_pending_file: Path | None = None
_server_version = ""


# --------------------------------------------------------------------------- #
# Persistence
# --------------------------------------------------------------------------- #
def _load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _write_json(path: Path, data: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def _save() -> None:
    with _lock:
        try:
            _write_json(_state_file, _state)
        except OSError as exc:
            _agent.log(f"[mesh] could not save state: {exc}")


def _git_version(repo: Path) -> str:
    try:
        return subprocess.run(
            ["git", "-C", str(repo), "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=5,
        ).stdout.strip()
    except Exception:
        return ""


def bind(agent: Any) -> None:
    """Called once by basiq_agent at import: loads state, resumes every
    unfinished grab, starts the supervisor."""
    global _agent, _state_file, _pending_file, _state, _server_version
    _agent = agent
    _state_file = agent.DATA_DIR / "mesh.json"
    _pending_file = agent.DATA_DIR / "pending_grabs.json"
    _state = _load_json(_state_file, {})
    _state.setdefault("workers", {})
    _state.setdefault("codes", {})
    _state.setdefault("settings", {"mesh_enabled": True, "auto_update": True})
    _server_version = _git_version(agent.HERE.parent)
    _resume_pending()
    threading.Thread(target=_supervisor, daemon=True, name="mesh-supervisor").start()


def bound() -> bool:
    """False inside a worker (mesh_worker imports basiq_agent as a library)
    and in tests that drive run_grab() directly: every entry point below is
    then a safe no-op."""
    return _agent is not None and _state_file is not None


def settings() -> dict[str, Any]:
    return _state.get("settings") or {}


# --------------------------------------------------------------------------- #
# Workers, keys, enrollment codes
# --------------------------------------------------------------------------- #
def _hash(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def _now() -> float:
    return time.time()


def _online(w: dict[str, Any], now: float | None = None) -> bool:
    return (now or _now()) - w.get("last_seen", 0) <= ONLINE_SECONDS


def _usable(w: dict[str, Any], now: float | None = None) -> bool:
    return (not w.get("revoked") and w.get("enabled", True) and not w.get("draining")
            and _online(w, now))


def create_code(label: str, uses: int = 50, days: float = 30) -> str:
    code = "BQ-" + "-".join(secrets.token_hex(2).upper() for _ in range(3))
    with _lock:
        _state["codes"][_hash(code)[:16]] = {
            "label": label or "team code", "created": _now(), "expires": _now() + days * 86400,
            "uses_left": int(uses), "used_by": [], "revoked": False, "hint": code[-4:],
        }
        _save()
    return code


def enroll(code: str, name: str, owner: str, platform: str, ip: str) -> dict[str, str]:
    with _lock:
        rec = _state["codes"].get(_hash((code or "").strip().upper())[:16])
        if not rec or rec.get("revoked") or rec["uses_left"] <= 0 or _now() > rec["expires"]:
            raise PermissionError("invalid or expired enrollment code")
        rec["uses_left"] -= 1
        worker_id = secrets.token_hex(6)
        secret = secrets.token_urlsafe(32)
        _state["workers"][worker_id] = {
            "id": worker_id, "name": (name or "").strip()[:80] or f"worker-{worker_id}",
            "owner": (owner or "").strip()[:80], "platform": (platform or "")[:40],
            "version": "", "enabled": True, "draining": False, "always_on": False,
            "revoked": False, "key_hash": _hash(secret), "created": _now(),
            "last_seen": 0, "last_ip": ip, "lucid_ok": None, "free_gb": None,
            "current_job": None, "done": 0, "failed": 0, "commands": [], "notes": "",
            "enrolled_with": rec["label"],
        }
        rec["used_by"].append(worker_id)
        _save()
    _agent.log(f"[mesh] enrolled worker {worker_id} ({name}, {platform}) from {ip}")
    return {"workerId": worker_id, "key": f"bw_{worker_id}_{secret}"}


def auth_worker(header: str) -> dict[str, Any] | None:
    """Bearer bw_<id>_<secret> -> the worker record, or None."""
    token = (header or "").removeprefix("Bearer ").strip()
    if not token.startswith("bw_"):
        return None
    try:
        _, worker_id, secret = token.split("_", 2)
    except ValueError:
        return None
    with _lock:
        w = _state["workers"].get(worker_id)
        if not w or w.get("revoked") or not hmac.compare_digest(w["key_hash"], _hash(secret)):
            return None
        return w


def heartbeat(w: dict[str, Any], body: dict[str, Any], ip: str) -> dict[str, Any]:
    with _lock:
        w["last_seen"] = _now()
        w["last_ip"] = ip
        for key in ("version", "platform", "lucid_ok", "free_gb", "current_job", "media_root", "hostname"):
            if key in body:
                w[key] = body[key]
        commands, w["commands"] = w.get("commands", []), []
        if commands:
            _save()
        return {
            "enabled": w.get("enabled", True) and settings().get("mesh_enabled", True),
            "draining": w.get("draining", False),
            "commands": commands,
            "desiredVersion": _server_version if settings().get("auto_update", True) else "",
        }


# --------------------------------------------------------------------------- #
# The queue (fields live on basiq_agent's own job dicts)
# --------------------------------------------------------------------------- #
def has_workers() -> bool:
    if not bound() or not settings().get("mesh_enabled", True):
        return False
    with _lock:
        return any(not w.get("revoked") and w.get("enabled", True) for w in _state["workers"].values())


def any_online() -> bool:
    if not bound():
        return False
    now = _now()
    with _lock:
        return any(_usable(w, now) for w in _state["workers"].values())


def _job(job_id: str) -> dict[str, Any] | None:
    return _agent._jobs.get(job_id)


def note_grab(job_id: str, request: dict[str, Any], requester_ip: str) -> None:
    """Every GRAB is recorded the moment it's created, so a restart mid-
    grab resumes it (see _resume_pending)."""
    if not bound():
        return
    with _agent._jobs_lock:
        job = _job(job_id)
        if job is not None:
            job["request"] = request
            job["requester_ip"] = requester_ip
            job["created_at"] = job.get("created_at") or _now()
    _persist_pending()


def queue(job_id: str, reason: str) -> None:
    """Cloud gave up on this grab for a retryable reason -> backup routes."""
    with _agent._jobs_lock:
        job = _job(job_id)
        if job is None:
            return
        m = job.setdefault("mesh", {"since": _now(), "tried": [], "cloud_tries": 0})
        m.update({"phase": "queued", "claimed_by": None, "cloud_running": False,
                  "last_cloud": _now(), "last_reason": (reason or "")[:300]})
        m["cloud_tries"] = m.get("cloud_tries", 0) + 1
        job["route"] = "mesh"
    _agent.set_job(job_id, status=STATUS_WAITING, pct=None)
    _agent.log(f"[mesh] {job_id} queued for a backup route ({(reason or '')[:120]})")
    _persist_pending()


def _tier(w: dict[str, Any], job: dict[str, Any]) -> int:
    if job.get("requester_ip") and w.get("last_ip") == job.get("requester_ip"):
        return 0
    return 1 if w.get("always_on") else 2


def offers_for(w: dict[str, Any]) -> list[dict[str, Any]]:
    now = _now()
    with _lock:
        others = [x for x in _state["workers"].values() if _usable(x, now)]
    out = []
    with _agent._jobs_lock:
        for job_id, job in _agent._jobs.items():
            m = job.get("mesh")
            if (job.get("route") != "mesh" or not m or m.get("phase") != "queued"
                    or m.get("claimed_by") or m.get("cloud_running") or job.get("status") in FINAL):
                continue
            if w["id"] in m.get("tried", []):
                # Let someone who hasn't failed it go first; otherwise wait a
                # minute before the same worker tries again (no hot loop).
                if any(o["id"] not in m["tried"] for o in others) or now - m.get("last_fail_at", 0) < 60:
                    continue
            tier = _tier(w, job)
            better = {_tier(o, job) for o in others if o["id"] != w["id"] and o["id"] not in m.get("tried", [])}
            delay = sum(TIER_GRACE_SECONDS for t in range(tier) if t in better)
            if now - m.get("since", now) >= delay:
                out.append({"jobId": job_id, "request": job.get("request") or {}, "tier": tier})
    return out


def claim(w: dict[str, Any], job_id: str) -> bool:
    with _agent._jobs_lock:
        job = _job(job_id)
        m = (job or {}).get("mesh")
        if (not job or job.get("route") != "mesh" or not m or m.get("phase") != "queued"
                or m.get("claimed_by") or m.get("cloud_running") or job.get("status") in FINAL):
            return False
        m.update({"phase": "running", "claimed_by": w["id"], "claimed_at": _now(), "last_seen": _now()})
    with _lock:
        w["current_job"] = job_id
    _agent.set_job(job_id, status="Downloading via backup route…", pct=None)
    _agent.log(f"[mesh] {job_id} claimed by {w['name']} ({w['id']})")
    _persist_pending()
    return True


def _owned(w: dict[str, Any], job_id: str) -> dict[str, Any] | None:
    job = _job(job_id)
    m = (job or {}).get("mesh")
    return job if m and m.get("claimed_by") == w["id"] else None


RELAY_FIELDS = {"status", "pct", "detail"}


def update(w: dict[str, Any], job_id: str, fields: dict[str, Any]) -> bool:
    with _agent._jobs_lock:
        job = _owned(w, job_id)
        if not job:
            return False
        job["mesh"]["last_seen"] = _now()
        if job["mesh"].get("phase") != "running":
            return True  # verifying/uploading: the droplet owns the status now
    clean = {k: v for k, v in fields.items() if k in RELAY_FIELDS}
    if clean.get("status") in FINAL:
        clean.pop("status")  # only done()/failed() may finish a mesh job
    if clean:
        _agent.set_job(job_id, **clean)
    return True


def state(w: dict[str, Any], job_id: str) -> dict[str, Any]:
    with _agent._jobs_lock:
        job = _owned(w, job_id)
        if not job:
            return {"owned": False}
        job["mesh"]["last_seen"] = _now()
        return {"owned": True, "phase": job["mesh"].get("phase"), "status": job.get("status"),
                "stop": _agent.stop_requested(job_id)}


def failed(w: dict[str, Any], job_id: str, message: str) -> None:
    with _lock:
        w["failed"] = w.get("failed", 0) + 1
        w["current_job"] = None
    with _agent._jobs_lock:
        job = _owned(w, job_id)
        if not job:
            return
        m = job["mesh"]
        m["tried"] = list(dict.fromkeys([*m.get("tried", []), w["id"]]))
        m.update({"phase": "queued", "claimed_by": None, "last_reason": (message or "")[:300],
                  "last_fail_at": _now()})
        m["worker_tries"] = m.get("worker_tries", 0) + 1
        exhausted = m["worker_tries"] >= MAX_WORKER_TRIES
        stopped = _agent.stop_requested(job_id)
    _agent.log(f"[mesh] {job_id} failed on {w['name']}: {(message or '')[:200]}")
    if stopped or not _agent._retryable(message) or exhausted:
        # Not something another route can fix (private/deleted video...), or
        # the cloud AND MAX_WORKER_TRIES worker attempts all failed -- at that
        # point it's the video, not the network.
        _finish(job_id, error=message or "Download failed")
    else:
        _agent.set_job(job_id, status=STATUS_WAITING, pct=None)
    _persist_pending()


def done(w: dict[str, Any], job_id: str, body: dict[str, Any]) -> None:
    result = body.get("result") or {}
    with _agent._jobs_lock:
        job = _owned(w, job_id)
        if not job:
            return
        job["mesh"].update({"phase": "verifying", "last_seen": _now(),
                            "result": result, "staged": bool(body.get("staged"))})
    if body.get("ledger"):
        _append_ledger(dict(body["ledger"], route=f"worker:{w['name']}"))
    extra = {"detail": result["title"]} if result.get("title") else {}
    _agent.set_job(job_id, status="Checking the archive…", pct=99.0, **extra)
    threading.Thread(target=_verify, args=(w, job_id), daemon=True).start()


def _expected(job_id: str) -> tuple[Path | None, int]:
    with _agent._jobs_lock:
        r = ((_job(job_id) or {}).get("mesh") or {}).get("result") or {}
    rel = r.get("localPath") or ""
    if not rel:
        return None, 0
    return _agent.MEDIA_ROOT / rel, int(r.get("sizeBytes") or 0)


def _visible(path: Path | None, size: int) -> bool:
    try:
        return bool(path) and path.is_file() and path.stat().st_size >= size > 0
    except OSError:
        return False


def _verify(w: dict[str, Any], job_id: str) -> None:
    path, size = _expected(job_id)
    with _agent._jobs_lock:
        staged = ((_job(job_id) or {}).get("mesh") or {}).get("staged")
    deadline = _now() + (0 if staged else VERIFY_TIMEOUT_SECONDS)
    while _now() < deadline and not _visible(path, size):
        time.sleep(3)
    if _visible(path, size):
        _file_and_finish(w, job_id)
        return
    with _agent._jobs_lock:
        job = _owned(w, job_id)
        if not job:
            return
        job["mesh"]["phase"] = "need_upload"
    _agent.log(f"[mesh] {job_id}: file not visible in the archive here "
               f"({'worker LucidLink down' if staged else 'sync timeout'}) -- asking {w['name']} to upload it")
    _agent.set_job(job_id, status="Sending the file to the archive…", pct=99.0)


def receive_upload(w: dict[str, Any], job_id: str, kind: str, rfile: Any, length: int) -> tuple[int, str]:
    """Worker streams the file (kind "media" or "subtitle") when the
    archive copy can't be seen from here. Written next to the final name
    and renamed into place only when the byte count is right."""
    with _agent._jobs_lock:
        job = _owned(w, job_id)
        if not job or job["mesh"].get("phase") not in ("need_upload", "uploading"):
            return 409, "not expecting an upload"
        job["mesh"]["phase"] = "uploading"
        r = job["mesh"].get("result") or {}
    rel = r.get("localPath") if kind == "media" else r.get("subtitlePath")
    if not rel or ".." in Path(rel).parts:
        return 400, "no path for that file"
    dest = _agent.MEDIA_ROOT / rel
    tmp = dest.with_name(dest.name + ".uploading")
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        got = 0
        with open(tmp, "wb") as f:
            while got < length:
                chunk = rfile.read(min(1 << 20, length - got))
                if not chunk:
                    break
                f.write(chunk)
                got += len(chunk)
                with _agent._jobs_lock:
                    if _job(job_id) and _job(job_id).get("mesh"):
                        _job(job_id)["mesh"]["last_seen"] = _now()
        if got != length:
            tmp.unlink(missing_ok=True)
            with _agent._jobs_lock:
                if _owned(w, job_id):
                    _job(job_id)["mesh"]["phase"] = "need_upload"
            return 400, f"short upload ({got}/{length})"
        if dest.exists() and dest.stat().st_size >= got:
            tmp.unlink(missing_ok=True)   # the LucidLink copy arrived meanwhile
        else:
            os.replace(tmp, dest)
    except OSError as exc:
        tmp.unlink(missing_ok=True)
        with _agent._jobs_lock:
            if _owned(w, job_id):
                _job(job_id)["mesh"]["phase"] = "need_upload"
        return 500, f"could not write to the archive: {exc}"
    _agent.log(f"[mesh] {job_id}: received {kind} upload from {w['name']} ({got} bytes)")
    if kind == "media":
        _file_and_finish(w, job_id)
    return 200, "ok"


def _file_and_finish(w: dict[str, Any], job_id: str) -> None:
    """The file is in the archive (seen from here). Write the DB row the
    worker prepared, then finish -- the same end state as a cloud grab."""
    with _agent._jobs_lock:
        m = ((_job(job_id) or {}).get("mesh") or {})
        result = dict(m.get("result") or {})
    payload = result.pop("videoPayload", None)
    if payload:
        row = None
        for _ in range(3):
            row = _agent._db_request("videos", method="POST", data=payload, params="?on_conflict=id")
            if row is not None:
                break
            time.sleep(3)
        if row is None:
            _finish(job_id, error=(
                "Downloaded and filed to the archive, but saving it to the database failed "
                "(Supabase unreachable). It won't appear in the library until this succeeds."))
            return
    with _lock:
        w["done"] = w.get("done", 0) + 1
        w["current_job"] = None
        _save()
    with _agent._jobs_lock:
        if (_job(job_id) or {}).get("mesh") is not None:
            _job(job_id)["mesh"]["completed_by"] = w["id"]
    _finish(job_id, result=result)
    _agent.log(f"[mesh] {job_id} complete via {w['name']}")


def _finish(job_id: str, result: dict[str, Any] | None = None, error: str | None = None) -> None:
    with _agent._jobs_lock:
        job = _job(job_id)
        if job and job.get("mesh"):
            job["mesh"]["phase"] = "done" if error is None else "error"
            job["mesh"]["claimed_by"] = None
    if error is None:
        _agent.set_job(job_id, status="Complete", pct=100.0, result=result, error="")
    else:
        _agent.set_job(job_id, status="Error", pct=None, error=error)
    _persist_pending()


def _append_ledger(entry: dict[str, Any]) -> None:
    try:
        with open(_agent._GRAB_LEDGER_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass


# --------------------------------------------------------------------------- #
# Supervisor: stale claims, cloud retries, give-up, restart persistence
# --------------------------------------------------------------------------- #
def _persist_pending() -> None:
    out = {}
    with _agent._jobs_lock:
        for job_id, job in _agent._jobs.items():
            if job.get("kind") == "grab" and job.get("request") and job.get("status") not in FINAL:
                m = dict(job.get("mesh") or {})
                if m.get("phase") in ("running", "verifying", "need_upload", "uploading"):
                    m["phase"], m["claimed_by"] = "queued", None   # resumed jobs re-queue
                m["cloud_running"] = False
                out[job_id] = {"request": job["request"], "requester_ip": job.get("requester_ip", ""),
                               "created_at": job.get("created_at"), "route": job.get("route", "cloud"),
                               "mesh": m, "detail": job.get("detail", "")}
    try:
        _write_json(_pending_file, out)
    except OSError:
        pass


def _resume_pending() -> None:
    pending = _load_json(_pending_file, {})
    for job_id, p in pending.items():
        req = p.get("request") or {}
        if not req.get("url"):
            continue
        with _agent._jobs_lock:
            _agent._jobs[job_id] = {
                "status": STATUS_WAITING, "pct": None, "detail": p.get("detail", ""), "result": None,
                "error": "", "kind": "grab", "claimed_by": None, "claimed_at": None, "last_seen_at": None,
                "request": req, "requester_ip": p.get("requester_ip", ""), "created_at": p.get("created_at"),
            }
            if p.get("route") == "mesh":
                _agent._jobs[job_id]["route"] = "mesh"
                _agent._jobs[job_id]["mesh"] = dict(p.get("mesh") or {}, phase="queued", claimed_by=None,
                                                    cloud_running=False)
        if p.get("route") != "mesh":
            _agent.log(f"[mesh] resuming interrupted grab {job_id} (cloud)")
            threading.Thread(target=_agent.run_grab, args=(job_id, req["url"], req.get("quality") or "HD",
                             bool(req.get("subs"))), daemon=True).start()
        else:
            _agent.log(f"[mesh] resuming queued grab {job_id} (backup route)")


def _cloud_retry(job_id: str) -> None:
    with _agent._jobs_lock:
        job = _job(job_id)
        req = dict((job or {}).get("request") or {})
    _agent.log(f"[mesh] {job_id}: no worker online, retrying in the cloud")
    try:
        _agent.run_grab(job_id, req["url"], req.get("quality") or "HD", bool(req.get("subs")))
    finally:
        with _agent._jobs_lock:
            m = ((_job(job_id) or {}).get("mesh") or {})
            m["cloud_running"] = False
        _persist_pending()


def _tick() -> None:
    now = _now()
    someone_online = any_online()
    retry: list[str] = []
    expired: list[str] = []
    stopped: list[str] = []
    with _agent._jobs_lock:
        for job_id, job in _agent._jobs.items():
            m = job.get("mesh")
            if job.get("route") != "mesh" or not m or job.get("status") in FINAL:
                continue
            if m.get("phase") == "running" and now - m.get("last_seen", now) > STALE_CLAIM_SECONDS:
                _agent.log(f"[mesh] {job_id}: worker {m.get('claimed_by')} went silent, re-queueing")
                m["tried"] = list(dict.fromkeys([*m.get("tried", []), m.get("claimed_by")]))
                m.update({"phase": "queued", "claimed_by": None})
            if m.get("phase") != "queued" or m.get("cloud_running"):
                continue
            if _agent.stop_requested(job_id):
                stopped.append(job_id)
            elif now - m.get("since", now) > MESH_MAX_WAIT_SECONDS:
                expired.append(job_id)
            elif not someone_online and now - m.get("last_cloud", 0) >= CLOUD_RETRY_SECONDS:
                m["cloud_running"] = True
                m["last_cloud"] = now
                retry.append(job_id)
    for job_id in stopped:
        _finish(job_id, error="Stopped by user")
    for job_id in expired:
        with _agent._jobs_lock:
            reason = ((_job(job_id) or {}).get("mesh") or {}).get("last_reason", "")
        _finish(job_id, error=f"No route could download this after {MESH_MAX_WAIT_SECONDS / 3600:.0f}h "
                               f"of trying. Last error: {reason}")
    for job_id in retry:
        threading.Thread(target=_cloud_retry, args=(job_id,), daemon=True).start()
    # Workers whose job vanished (agent restart) shouldn't look busy forever.
    with _lock:
        for w in _state["workers"].values():
            if w.get("current_job") and (_job(w["current_job"]) or {}).get("status") in (None, *FINAL):
                w["current_job"] = None


def _supervisor() -> None:
    while True:
        time.sleep(TICK_SECONDS)
        try:
            _tick()
            _persist_pending()
        except Exception as exc:
            _agent.log(f"[mesh] supervisor error: {exc}")


# --------------------------------------------------------------------------- #
# Admin API (the web app's admin console; ADMIN_TOKEN only)
# --------------------------------------------------------------------------- #
def admin_ok(header: str) -> bool:
    return bool(ADMIN_TOKEN) and hmac.compare_digest((header or "").encode(), f"Bearer {ADMIN_TOKEN}".encode())


def _public(w: dict[str, Any], now: float) -> dict[str, Any]:
    out = {k: v for k, v in w.items() if k != "key_hash"}
    out["online"] = _online(w, now)
    out["status"] = ("revoked" if w.get("revoked") else "off" if not w.get("enabled", True)
                     else "draining" if w.get("draining") else "busy" if w.get("current_job") and _online(w, now)
                     else "online" if _online(w, now) else "offline")
    out["outdated"] = bool(_server_version and w.get("version") and w["version"] != _server_version)
    return out


def overview() -> dict[str, Any]:
    now = _now()
    with _lock:
        workers = [_public(w, now) for w in _state["workers"].values()]
        codes = [{"id": cid, **{k: v for k, v in c.items()}} for cid, c in _state["codes"].items()]
        sett = dict(_state["settings"])
    queue_rows = []
    with _agent._jobs_lock:
        for job_id, job in _agent._jobs.items():
            if job.get("kind") != "grab" or not job.get("request"):
                continue
            m = job.get("mesh") or {}
            queue_rows.append({
                "jobId": job_id, "url": job["request"].get("url"), "title": job.get("detail"),
                "status": job.get("status"), "route": job.get("route", "cloud"), "phase": m.get("phase"),
                "claimedBy": m.get("claimed_by"), "completedBy": m.get("completed_by"), "tried": m.get("tried", []), "cloudTries": m.get("cloud_tries", 0),
                "since": m.get("since") or job.get("created_at"), "lastReason": m.get("last_reason", ""),
                "error": job.get("error", ""),
            })
    queue_rows.sort(key=lambda r: r.get("since") or 0, reverse=True)
    health = {}
    try:
        health = json.loads(_agent._PROXY_HEALTH_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    return {"serverVersion": _server_version, "now": now, "settings": sett, "workers": workers,
            "codes": codes, "jobs": queue_rows[:100], "proxyHealth": health,
            "benchSeconds": _agent.PROXY_BENCH_SECONDS, "onlineSeconds": ONLINE_SECONDS}


EDITABLE = {"name": str, "owner": str, "notes": str, "enabled": bool, "draining": bool, "always_on": bool}


def admin(method: str, path: str, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    parts = [p for p in path.split("?")[0].split("/") if p][1:]   # drop "admin"
    if method == "GET" and parts == ["overview"]:
        return 200, overview()
    if method != "POST":
        return 404, {"error": "not found"}
    if parts == ["settings"]:
        with _lock:
            for key in ("mesh_enabled", "auto_update"):
                if key in body:
                    _state["settings"][key] = bool(body[key])
            _save()
        return 200, {"settings": settings()}
    if parts == ["codes"]:
        code = create_code(str(body.get("label") or ""), int(body.get("uses") or 50), float(body.get("days") or 30))
        return 200, {"code": code}
    if len(parts) == 3 and parts[0] == "codes" and parts[2] == "revoke":
        with _lock:
            if parts[1] not in _state["codes"]:
                return 404, {"error": "unknown code"}
            _state["codes"][parts[1]]["revoked"] = True
            _save()
        return 200, {"ok": True}
    if len(parts) >= 2 and parts[0] == "workers":
        with _lock:
            w = _state["workers"].get(parts[1])
            if not w:
                return 404, {"error": "unknown worker"}
            action = parts[2] if len(parts) > 2 else "edit"
            if action == "edit":
                for key, typ in EDITABLE.items():
                    if key in body:
                        w[key] = typ(body[key]) if typ is not str else str(body[key])[:200]
            elif action == "revoke":
                w["revoked"] = True
                w["enabled"] = False
                if body.get("uninstall"):
                    w.setdefault("commands", []).append({"type": "uninstall", "at": _now()})
            elif action == "command":
                kind = body.get("type")
                if kind not in ("restart", "update", "uninstall"):
                    return 400, {"error": "unknown command"}
                w.setdefault("commands", []).append({"type": kind, "at": _now()})
            elif action == "delete":
                if not w.get("revoked"):
                    return 400, {"error": "revoke it first"}
                del _state["workers"][parts[1]]
            else:
                return 404, {"error": "not found"}
            _save()
        return 200, {"ok": True}
    if len(parts) == 3 and parts[0] == "jobs":
        job_id, action = parts[1], parts[2]
        if action == "cancel":
            if (_job(job_id) or {}).get("status") in FINAL or not _job(job_id):
                return 404, {"error": "no such active job"}
            _agent._stop_flags.setdefault(job_id, threading.Event()).set()
            with _agent._jobs_lock:
                m = (_job(job_id) or {}).get("mesh") or {}
                unclaimed = not m.get("claimed_by") and not m.get("cloud_running")
            if unclaimed and m:
                _finish(job_id, error="Cancelled by admin")
            return 200, {"ok": True}
        if action == "retry-cloud":
            with _agent._jobs_lock:
                m = (_job(job_id) or {}).get("mesh")
                if not m or m.get("phase") != "queued" or m.get("cloud_running"):
                    return 409, {"error": "job isn't waiting for a route"}
                m["cloud_running"] = True
                m["last_cloud"] = _now()
            threading.Thread(target=_cloud_retry, args=(job_id,), daemon=True).start()
            return 200, {"ok": True}
    return 404, {"error": "not found"}


