"""
worker_tray.py — a system-tray supervisor for basiq_worker.py.

Runs with no console window (launched via pythonw.exe, see start-tray.bat /
basiq-worker-task.xml) and keeps exactly one basiq_worker.py subprocess
alive at all times:
  - relaunches it if it exits, for any reason
  - kills and relaunches it if it's alive but hung (heartbeat gone stale) --
    the same "alive isn't the same as working" distinction basiq_worker.py's
    own singleton lock already draws for a second *launch* arriving mid-hang
    (see its _existing_worker_is_healthy()), now applied continuously by
    something that's always watching, not just at the moment of a new launch.

This replaces leaving a visible console window open (start-worker.bat) for
the always-on case: a console that must stay open and that silently piles
up one per crash is exactly the friction this exists to remove. The tray
icon is the at-a-glance replacement for "glance at the window to see if
it's still running":
    green  = worker running, heartbeat fresh
    amber  = starting up (within its own startup grace window)
    red    = worker down or hung -- about to relaunch

Right-click the icon for the current status, a manual restart, and the log
(worker_tray.log, next to this file -- there's no console to read anymore,
so this is the only place output goes).

Install once, on the worker machine only (never on the droplet -- the cloud
agent has no display to put a tray icon on):
    .venv\\Scripts\\pip install -r requirements-tray.txt

Run it (start-tray.bat / basiq-worker-task.xml already do this):
    .venv\\Scripts\\pythonw.exe worker_tray.py
"""
from __future__ import annotations

import atexit
import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Optional

import pystray
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "worker_config.txt"
LOG_PATH = HERE / "worker_tray.log"
LOCK_PATH = HERE / "worker_tray.lock"
HEARTBEAT_PATH = HERE / "worker_heartbeat.txt"  # written by basiq_worker.py
PYTHON_EXE = HERE / ".venv" / "Scripts" / "python.exe"
WORKER_SCRIPT = HERE / "basiq_worker.py"

# Mirrors basiq_worker.py's own STARTUP_GRACE_SECONDS / HEARTBEAT_STALE_SECONDS
# exactly -- same startup cost (heavy ML imports), same definition of "hung".
STARTUP_GRACE_SECONDS = 60.0
HEARTBEAT_STALE_SECONDS = 90.0
POLL_INTERVAL_SECONDS = 5.0
RESTART_BACKOFF_SECONDS = 5.0
MAX_LOG_BYTES = 5 * 1024 * 1024


def _load_worker_env() -> dict[str, str]:
    if not CONFIG_PATH.exists():
        raise SystemExit(
            f"{CONFIG_PATH.name} is missing -- copy worker_config.txt.example "
            f"to worker_config.txt and fill it in first."
        )
    env = dict(os.environ)
    for line in CONFIG_PATH.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if not line or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip()
    for required in ("AGENT_URL", "AUTH_TOKEN", "MEDIA_ROOT", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
        if not env.get(required):
            raise SystemExit(f"{required} is missing from {CONFIG_PATH.name}.")
    return env


# --------------------------------------------------------------------------- #
# One tray icon at a time. Same O_CREAT|O_EXCL + liveness-check pattern as
# basiq_worker.py's own singleton lock (see its comment block for the full
# history of why this needs to be atomic). Without this, a stray second
# launch of the tray itself -- a double-click while Task Scheduler's own
# copy is already running -- would spawn a second basiq_worker.py that
# immediately steps aside via ITS OWN lock (harmless), then get endlessly
# relaunched by the SECOND tray's monitor loop every few seconds forever:
# not a correctness problem, but a confusing second icon and a python
# process launched on a loop for no reason.
# --------------------------------------------------------------------------- #
def _pid_is_running(pid: int) -> bool:
    try:
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
            capture_output=True, text=True, timeout=10,
        ).stdout
    except Exception:
        return False
    return str(pid) in out


def _acquire_tray_lock() -> None:
    try:
        fd = os.open(str(LOCK_PATH), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        try:
            existing_pid = int(LOCK_PATH.read_text(encoding="utf-8").strip())
        except (ValueError, OSError):
            existing_pid = None
        if existing_pid and _pid_is_running(existing_pid):
            raise SystemExit(0)  # another tray already has this covered
        LOCK_PATH.unlink(missing_ok=True)
        _acquire_tray_lock()
        return
    with os.fdopen(fd, "w") as f:
        f.write(str(os.getpid()))
    atexit.register(lambda: LOCK_PATH.unlink(missing_ok=True))


def _open_log():
    if LOG_PATH.exists() and LOG_PATH.stat().st_size > MAX_LOG_BYTES:
        LOG_PATH.write_text("", encoding="utf-8")
    return open(LOG_PATH, "a", encoding="utf-8")


_COLORS = {
    "up": (46, 160, 67),
    "starting": (219, 171, 9),
    "down": (207, 34, 46),
}


def _make_icon_image(state: str) -> Image.Image:
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    ImageDraw.Draw(img).ellipse((8, 8, 56, 56), fill=_COLORS[state])
    return img


class Supervisor:
    def __init__(self) -> None:
        self.env = _load_worker_env()
        self.proc: Optional[subprocess.Popen] = None
        self.log_file = _open_log()
        self.stopping = False
        self.icon: Optional[pystray.Icon] = None
        self.last_launch = 0.0
        self._proc_lock = threading.Lock()

    def _log(self, msg: str) -> None:
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        print(f"[{ts}] {msg}", file=self.log_file, flush=True)

    def _launch_locked(self) -> None:
        self._log("launching basiq_worker.py")
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        self.proc = subprocess.Popen(
            [str(PYTHON_EXE), str(WORKER_SCRIPT)],
            cwd=str(HERE),
            env=self.env,
            stdout=self.log_file,
            stderr=subprocess.STDOUT,
            creationflags=creationflags,
        )
        self.last_launch = time.time()

    def _kill_current_locked(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            try:
                self.proc.kill()
                self.proc.wait(timeout=10)
            except Exception as exc:
                self._log(f"could not stop previous worker process: {exc}")

    def status(self) -> tuple[str, str]:
        """(state, label) where state is one of "up"/"starting"/"down"."""
        if self.proc is None or self.proc.poll() is not None:
            code = self.proc.poll() if self.proc is not None else None
            return "down", f"Worker down (exit {code}) -- restarting"
        try:
            heartbeat_age = time.time() - HEARTBEAT_PATH.stat().st_mtime
        except OSError:
            heartbeat_age = None
        if heartbeat_age is not None and heartbeat_age < HEARTBEAT_STALE_SECONDS:
            return "up", "Worker running"
        if time.time() - self.last_launch < STARTUP_GRACE_SECONDS:
            return "starting", "Worker starting..."
        return "down", "Worker hung -- restarting"

    def _update_icon(self) -> None:
        if self.icon is None:
            return
        state, label = self.status()
        self.icon.icon = _make_icon_image(state)
        self.icon.title = f"Basiq Worker — {label}"

    def monitor_loop(self) -> None:
        with self._proc_lock:
            self._launch_locked()
        self._update_icon()
        while not self.stopping:
            time.sleep(POLL_INTERVAL_SECONDS)
            if self.stopping:
                break
            with self._proc_lock:
                state, _ = self.status()
                if state == "down":
                    if self.proc is not None and self.proc.poll() is None:
                        self._log("heartbeat stale -- worker appears hung, killing it")
                        self._kill_current_locked()
                    else:
                        self._log(f"worker exited (code {self.proc.poll() if self.proc else None}) -- relaunching")
                    time.sleep(RESTART_BACKOFF_SECONDS)
                    if not self.stopping:
                        self._launch_locked()
            self._update_icon()

    def restart_now(self) -> None:
        with self._proc_lock:
            self._log("manual restart requested")
            self._kill_current_locked()
            self._launch_locked()
        self._update_icon()

    def stop(self) -> None:
        self.stopping = True
        with self._proc_lock:
            self._kill_current_locked()
        self._log("tray stopping")
        self.log_file.close()


def main() -> None:
    _acquire_tray_lock()
    sup = Supervisor()

    def on_restart(icon, item):
        threading.Thread(target=sup.restart_now, daemon=True).start()

    def on_open_log(icon, item):
        os.startfile(str(LOG_PATH))

    def on_quit(icon, item):
        sup.stop()
        icon.stop()

    def status_text(item):
        return sup.status()[1]

    menu = pystray.Menu(
        pystray.MenuItem(status_text, None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Restart worker now", on_restart),
        pystray.MenuItem("Open log", on_open_log),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit", on_quit),
    )

    icon = pystray.Icon(
        "basiq_worker", _make_icon_image("starting"), "Basiq Worker — starting...", menu,
    )
    sup.icon = icon

    threading.Thread(target=sup.monitor_loop, daemon=True).start()
    icon.run()


if __name__ == "__main__":
    main()
