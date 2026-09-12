"""
pipeline_doctor.py -- a full-pipeline health check + self-heal pass, run once
every 15 minutes forever by a Windows Scheduled Task ("Basiq Pipeline
Doctor" -- see tools/build/deploy/SETUP.md, step 11), independent of and in
addition to worker_tray.py's own fast (5s) heartbeat-based restart of
basiq_worker.py.

Why this exists on top of worker_tray.py: worker_tray.py only answers "is
basiq_worker.py's own loop still iterating" -- it has no way to notice that
LucidLink (a separate application, not a child process of anything this
project starts) has stopped running. Real incident, confirmed 2026-09-12:
LucidLink was not running on the worker machine and was not installed as a
Windows service, so basiq_worker.py kept writing finished downloads into
what used to be the LucidLink mount folder -- succeeding locally, marking
the video "ready" in Supabase -- while the file never left this machine.
Every layer of self-healing already in place (worker_tray.py's heartbeat,
Task Scheduler restarting the tray, the droplet's systemd Restart=on-failure)
was watching the wrong thing: all three assumed LucidLink was simply always
there, because until this incident it always had been. The web UI's own
"waiting for file to finish syncing" retry loop (app/page.tsx) can't see
this either -- from its side, the file is just slow, not gone missing at the
source.

This script checks, in order, and heals what it can safely do unattended:
  1. LucidLink -- running, and a filespace actually mounted? If it's
     installed as a Windows service but stopped, start it. If it isn't
     installed as a service at all, this can NOT be healed unattended (the
     one-time `lucid link` needs a human's credentials) -- logged loudly
     instead of silently retried forever every 15 minutes.
  2. basiq_worker.py / worker_tray.py -- heartbeat freshness. If stale well
     beyond worker_tray.py's own threshold (see WORKER_STALE_SECONDS below),
     worker_tray.py's own faster loop has apparently failed to recover it --
     do the full "shut down, clean up, turn back on": kill the tray's whole
     process tree, clear stale lock/heartbeat files, relaunch the tray.
  3. The tray's own Scheduled Task -- still Enabled? (Confirmed once before,
     2026-09-11, that this can silently flip to Disabled with no one
     noticing for days.) Re-enable it if not.
  4. The cloud agent (AGENT_URL) -- reachable? Only ever a GET to its own
     /health -- never touches YouTube or any grab site, per the standing
     rule against automated calls to real video platforms.
  5. Free disk space where MEDIA_ROOT lives -- logged, warns below a
     threshold.

Every run appends one block to pipeline_doctor.log and never leaves a
process running behind it -- it does its checks, heals what it safely can,
and exits.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "worker_config.txt"
LOG_PATH = HERE / "pipeline_doctor.log"
DOCTOR_LOCK_PATH = HERE / "pipeline_doctor.lock"
LOCK_PATH = HERE / "worker.lock"                    # basiq_worker.py's own
HEARTBEAT_PATH = HERE / "worker_heartbeat.txt"      # basiq_worker.py's own
TRAY_LOCK_PATH = HERE / "worker_tray.lock"          # worker_tray.py's own
PYTHONW_EXE = HERE / ".venv" / "Scripts" / "pythonw.exe"
TRAY_SCRIPT = HERE / "worker_tray.py"
LUCID_CLI = Path(os.environ.get("LUCID_CLI", r"C:\Program Files\LucidLink\bin\Lucid.exe"))

WORKER_TASK_NAME = "Basiq Worker"

# Generous on purpose: worker_tray.py already declares a worker hung and
# restarts it once its own heartbeat check exceeds 90s. This check only
# needs to catch the case where THAT mechanism itself has somehow failed
# (worker_tray.py's monitor thread died, the tray process is gone, etc.) --
# it should almost never be the one to actually fire.
WORKER_STALE_SECONDS = 10 * 60

DISK_FREE_WARN_GB = 20

_log_lines: list[str] = []


def _log(msg: str) -> None:
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    _log_lines.append(f"[{ts}] {msg}")


def _flush_log() -> None:
    MAX_LOG_BYTES = 5 * 1024 * 1024
    if LOG_PATH.exists() and LOG_PATH.stat().st_size > MAX_LOG_BYTES:
        LOG_PATH.write_text("", encoding="utf-8")
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write("\n".join(_log_lines) + "\n")


# --------------------------------------------------------------------------- #
# Small helpers, matching worker_tray.py's / basiq_worker.py's own style.
# --------------------------------------------------------------------------- #
def _run(cmd: list[str], timeout: int = 20) -> tuple[int, str]:
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return proc.returncode, (proc.stdout + proc.stderr)
    except Exception as exc:
        return -1, str(exc)


def _pid_is_running(pid: int) -> bool:
    out = _run(["tasklist", "/FI", f"PID eq {pid}", "/NH"])[1]
    return str(pid) in out


def _load_worker_env() -> dict[str, str]:
    env = dict(os.environ)
    if not CONFIG_PATH.exists():
        return env
    for line in CONFIG_PATH.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if not line or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip()
    return env


# --------------------------------------------------------------------------- #
# 1. LucidLink
# --------------------------------------------------------------------------- #
def check_lucidlink() -> None:
    if not LUCID_CLI.exists():
        _log("LUCIDLINK: CLI not found at " + str(LUCID_CLI) + " -- skipping check (set LUCID_CLI if it's installed elsewhere).")
        return

    _, service_out = _run([str(LUCID_CLI), "service", "--status"])
    installed_as_service = "not installed as a service" not in service_out.lower()

    _, status_out = _run([str(LUCID_CLI), "status"])
    running = "not running" not in status_out.lower()

    if not running:
        if installed_as_service:
            _log("LUCIDLINK: daemon not running, but installed as a Windows service -- starting it.")
            rc, start_out = _run([str(LUCID_CLI), "service", "--start"])
            time.sleep(3)
            _, recheck = _run([str(LUCID_CLI), "status"])
            if "not running" in recheck.lower():
                _log(f"LUCIDLINK: HEAL FAILED -- still not running after 'service --start'. Output: {start_out.strip()!r}")
            else:
                _log("LUCIDLINK: healed -- service started, daemon now running.")
        else:
            _log(
                "LUCIDLINK: *** NOT RUNNING and NOT installed as a Windows service. *** "
                "This can't be fixed unattended -- every grab from this machine is "
                "landing on local disk only and NOT reaching the shared drive until "
                "a human opens LucidLink (or, better, installs it as a service so this "
                "can't happen again: run 'Lucid.exe service --install' then "
                "'Lucid.exe service --start' from an elevated prompt, then link the "
                "filespace once through the GUI so the service persists it)."
            )
        return

    # Running -- confirm a filespace is actually mounted, not just the daemon alive.
    _, list_out = _run([str(LUCID_CLI), "list"])
    lines = [ln for ln in list_out.splitlines() if ln.strip() and "INSTANCE ID" not in ln]
    if not lines:
        _log(
            "LUCIDLINK: daemon is running but no filespace is linked/mounted -- "
            "needs a human to run 'Lucid.exe link' once. Not attempted automatically "
            "(requires credentials this script doesn't have)."
        )
    else:
        _log(f"LUCIDLINK: healthy -- daemon running, {len(lines)} filespace(s) mounted.")


# --------------------------------------------------------------------------- #
# 2. Worker + tray process stack
# --------------------------------------------------------------------------- #
def _kill_tray_tree() -> None:
    if TRAY_LOCK_PATH.exists():
        try:
            pid = int(TRAY_LOCK_PATH.read_text(encoding="utf-8").strip())
        except (ValueError, OSError):
            pid = None
        if pid and _pid_is_running(pid):
            _run(["taskkill", "/F", "/T", "/PID", str(pid)])
    for p in (LOCK_PATH, HEARTBEAT_PATH, TRAY_LOCK_PATH):
        p.unlink(missing_ok=True)


def check_worker_stack() -> None:
    tray_pid = None
    if TRAY_LOCK_PATH.exists():
        try:
            tray_pid = int(TRAY_LOCK_PATH.read_text(encoding="utf-8").strip())
        except (ValueError, OSError):
            tray_pid = None

    tray_alive = tray_pid is not None and _pid_is_running(tray_pid)

    heartbeat_age = None
    if HEARTBEAT_PATH.exists():
        heartbeat_age = time.time() - HEARTBEAT_PATH.stat().st_mtime

    if tray_alive and heartbeat_age is not None and heartbeat_age < WORKER_STALE_SECONDS:
        _log(f"WORKER: healthy -- tray PID {tray_pid} alive, heartbeat {heartbeat_age:.0f}s old.")
        return

    reason = (
        "tray process is not running" if not tray_alive
        else f"heartbeat is {heartbeat_age:.0f}s old (> {WORKER_STALE_SECONDS}s)" if heartbeat_age is not None
        else "no heartbeat file exists"
    )
    _log(f"WORKER: unhealthy -- {reason}. Shutting down, cleaning up, and turning it back on.")
    _kill_tray_tree()
    time.sleep(2)
    try:
        env = _load_worker_env()
        subprocess.Popen(
            [str(PYTHONW_EXE), str(TRAY_SCRIPT)],
            cwd=str(HERE),
            env=env,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        _log("WORKER: healed -- tray relaunched.")
    except Exception as exc:
        _log(f"WORKER: HEAL FAILED -- could not relaunch tray: {exc}")


# --------------------------------------------------------------------------- #
# 3. The tray's own Scheduled Task
# --------------------------------------------------------------------------- #
def check_scheduled_task() -> None:
    rc, out = _run(["schtasks", "/query", "/tn", WORKER_TASK_NAME, "/v", "/fo", "list"])
    if rc != 0:
        _log(f"SCHEDULED TASK: could not query '{WORKER_TASK_NAME}' (rc={rc}) -- {out.strip()[:200]}")
        return
    status_line = next((ln for ln in out.splitlines() if ln.strip().lower().startswith("status:")), "")
    if "disabled" in status_line.lower() or "ready" not in status_line.lower() and "running" not in status_line.lower():
        _log(f"SCHEDULED TASK: '{WORKER_TASK_NAME}' looks disabled ({status_line.strip()!r}) -- re-enabling.")
        rc2, out2 = _run(["schtasks", "/change", "/tn", WORKER_TASK_NAME, "/enable"])
        if rc2 == 0:
            _log("SCHEDULED TASK: healed -- re-enabled.")
        else:
            _log(f"SCHEDULED TASK: HEAL FAILED -- 'schtasks /change /enable' failed (rc={rc2}): {out2.strip()[:200]}")
    else:
        _log(f"SCHEDULED TASK: healthy -- {status_line.strip()}")


# --------------------------------------------------------------------------- #
# 4. Cloud agent connectivity (read-only -- /health only, never a grab site)
# --------------------------------------------------------------------------- #
def check_agent_connectivity(env: dict[str, str]) -> None:
    agent_url = env.get("AGENT_URL", "").rstrip("/")
    auth_token = env.get("AUTH_TOKEN", "")
    if not agent_url or not auth_token:
        _log("AGENT CONNECTIVITY: worker_config.txt missing AGENT_URL/AUTH_TOKEN -- skipping.")
        return
    req = urllib.request.Request(
        f"{agent_url}/health", headers={"Authorization": f"Bearer {auth_token}"}
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = json.loads(resp.read() or b"{}")
        _log(f"AGENT CONNECTIVITY: healthy -- {agent_url}/health -> {resp.status} {body}")
    except urllib.error.HTTPError as exc:
        _log(f"AGENT CONNECTIVITY: {agent_url}/health -> HTTP {exc.code} (nothing local to heal for this).")
    except Exception as exc:
        _log(f"AGENT CONNECTIVITY: unreachable -- {exc} (nothing local to heal for this; check the droplet itself).")


# --------------------------------------------------------------------------- #
# 5. Disk space where MEDIA_ROOT lives
# --------------------------------------------------------------------------- #
def check_disk_space(env: dict[str, str]) -> None:
    media_root = env.get("MEDIA_ROOT", "")
    if not media_root or not Path(media_root).exists():
        _log(f"DISK SPACE: MEDIA_ROOT {media_root!r} not accessible -- skipping.")
        return
    try:
        free_gb = shutil.disk_usage(media_root).free / (1024 ** 3)
    except OSError as exc:
        _log(f"DISK SPACE: could not check {media_root!r}: {exc}")
        return
    if free_gb < DISK_FREE_WARN_GB:
        _log(f"DISK SPACE: *** LOW *** -- only {free_gb:.1f} GB free at {media_root!r} (warn threshold {DISK_FREE_WARN_GB} GB).")
    else:
        _log(f"DISK SPACE: healthy -- {free_gb:.1f} GB free at {media_root!r}.")


# --------------------------------------------------------------------------- #
# Singleton guard -- a slow run (e.g. LucidLink service start taking a while)
# should never overlap with the next 15-minute tick.
# --------------------------------------------------------------------------- #
def _acquire_doctor_lock() -> bool:
    try:
        fd = os.open(str(DOCTOR_LOCK_PATH), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        try:
            pid = int(DOCTOR_LOCK_PATH.read_text(encoding="utf-8").strip())
        except (ValueError, OSError):
            pid = None
        if pid and _pid_is_running(pid):
            return False  # a previous run is still going -- skip this tick
        DOCTOR_LOCK_PATH.unlink(missing_ok=True)
        return _acquire_doctor_lock()
    with os.fdopen(fd, "w") as f:
        f.write(str(os.getpid()))
    return True


def main() -> None:
    if not _acquire_doctor_lock():
        return  # previous run still in progress; next scheduled tick will try again
    try:
        _log("=== pipeline doctor run starting ===")
        env = _load_worker_env()
        check_lucidlink()
        check_worker_stack()
        check_scheduled_task()
        check_agent_connectivity(env)
        check_disk_space(env)
        _log("=== pipeline doctor run finished ===")
    finally:
        _flush_log()
        DOCTOR_LOCK_PATH.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
