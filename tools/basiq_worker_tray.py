"""
basiq_worker_tray.py -- the thing a teammate actually sees and runs: a system
tray icon that supervises basiq_worker.py, replacing the old "double-click a
console window and leave it open forever" pattern (tools/start-worker.bat and
its disabled Task Scheduler entry -- both retired by this file; see
HANDOFF.md for why that scheduled-restart approach got turned off).

What this adds over just running basiq_worker.py directly:
  - Auto-restart if the worker crashes or hangs -- a background watchdog
    relaunches the supervised worker process automatically. This, plus the
    installer dropping a Startup-folder shortcut to THIS script (not
    basiq_worker.py), is the actual "comes back after a reboot or a crash"
    behavior, with no Windows Service and no admin rights required.
  - A tray icon that reflects real status (reads worker_status.json, which
    basiq_worker.py writes -- see its STATUS_PATH/_write_status) instead of
    a console window nobody's watching.
  - Menu-driven control: Pause/Resume, Restart Worker, Log into YouTube...
    (re-runs the one interactive step from youtube_session.py without a
    reinstall or involving whoever set this machine up), Open Logs, Quit.

Run it:
    python basiq_worker_tray.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

try:
    import pystray
except ImportError:
    pystray = None  # type: ignore[assignment]

try:
    from PIL import Image, ImageDraw
except ImportError:
    Image = ImageDraw = None  # type: ignore[assignment]

HERE = (
    Path(sys.executable).resolve().parent
    if getattr(sys, "frozen", False)
    else Path(__file__).resolve().parent
)

LOG_DIR = HERE / "logs"
LOG_PATH = LOG_DIR / "worker.log"
STATUS_PATH = HERE / "worker_status.json"
WATCHDOG_POLL_SECONDS = 3
CRASH_BACKOFF_SECONDS = 10  # don't hot-loop-relaunch a worker that dies instantly

# Manual, not automatic -- see _check_for_update()'s docstring for why this
# stays a "check and offer" rather than a fully silent self-replace for now.
UPDATE_SOURCE_DIR = Path(os.environ.get("WORKER_UPDATE_SOURCE", r"C:\Volumes\md-pac\media\Scripts\BasiqWorker"))
VERSION_MARKER_NAME = "basiq-worker-version.txt"
__version__ = "1.0.0"


# --------------------------------------------------------------------------- #
# Supervised worker subprocess
# --------------------------------------------------------------------------- #
class WorkerSupervisor:
    def __init__(self) -> None:
        self._proc: subprocess.Popen | None = None
        self._log_file = None
        self._paused = False
        self._quitting = False
        self._lock = threading.Lock()
        LOG_DIR.mkdir(parents=True, exist_ok=True)

    def _worker_command(self) -> list[str]:
        # Frozen build: basiq_worker.spec produces a sibling basiq-worker.exe
        # in the same onedir install alongside this tray exe. Source
        # checkout: run basiq_worker.py with the same interpreter as this
        # script, so `python basiq_worker_tray.py` works for dev/testing too.
        if getattr(sys, "frozen", False):
            worker_exe = HERE / ("basiq-worker.exe" if sys.platform == "win32" else "basiq-worker")
            return [str(worker_exe)]
        return [sys.executable, str(HERE / "basiq_worker.py")]

    def _open_log(self):
        if LOG_PATH.exists() and LOG_PATH.stat().st_size > 5_000_000:
            LOG_PATH.replace(LOG_PATH.with_suffix(".log.1"))
        return open(LOG_PATH, "a", encoding="utf-8", errors="replace")

    def start(self) -> None:
        with self._lock:
            if self._proc is not None:
                return
            self._log_file = self._open_log()
            self._log_file.write(f"\n--- worker starting {time.ctime()} ---\n")
            self._log_file.flush()
            self._proc = subprocess.Popen(
                self._worker_command(),
                cwd=str(HERE),
                stdout=self._log_file,
                stderr=subprocess.STDOUT,
            )

    def stop(self) -> None:
        with self._lock:
            proc, self._proc = self._proc, None
        if proc is None:
            return
        try:
            proc.terminate()
            proc.wait(timeout=10)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

    def restart(self) -> None:
        self.stop()
        time.sleep(1)
        self.start()

    def pause(self) -> None:
        self._paused = True
        self.stop()

    def resume(self) -> None:
        self._paused = False
        self.start()

    def is_alive(self) -> bool:
        with self._lock:
            return self._proc is not None and self._proc.poll() is None

    @property
    def paused(self) -> bool:
        return self._paused

    def quit(self) -> None:
        self._quitting = True
        self.stop()
        if self._log_file:
            self._log_file.close()

    def watchdog_tick(self) -> None:
        # A dead process that isn't there on purpose (paused/quitting) is a
        # crash -- relaunch it. A short backoff keeps a worker that fails
        # instantly from becoming a tight restart loop that pins a CPU core.
        if self._quitting or self._paused:
            return
        with self._lock:
            proc = self._proc
        if proc is not None and proc.poll() is not None:
            with self._lock:
                self._proc = None
            time.sleep(CRASH_BACKOFF_SECONDS)
            if not self._quitting and not self._paused:
                self.start()


# --------------------------------------------------------------------------- #
# Status -> icon
# --------------------------------------------------------------------------- #
def _read_status() -> dict:
    try:
        return json.loads(STATUS_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _current_state(supervisor: WorkerSupervisor) -> str:
    if supervisor.paused:
        return "paused"
    if not supervisor.is_alive():
        return "error"
    status = _read_status()
    if status.get("cookies") == "needs_login":
        return "needs_login"
    if status.get("poll") == "error":
        return "error"
    return "ok"


_STATE_COLORS = {
    "ok": (46, 160, 67),        # green
    "needs_login": (219, 171, 9),  # amber
    "error": (207, 34, 46),     # red
    "paused": (110, 118, 129),  # gray
}
_STATE_LABELS = {
    "ok": "Basiq Worker -- running",
    "needs_login": "Basiq Worker -- needs YouTube login",
    "error": "Basiq Worker -- error, check logs",
    "paused": "Basiq Worker -- paused",
}


def _make_icon_image(color: tuple[int, int, int]):
    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    margin = 6
    draw.ellipse([margin, margin, size - margin, size - margin], fill=color + (255,))
    return img


# --------------------------------------------------------------------------- #
# Optional, manual update check -- deliberately NOT a silent auto-replace.
#
# A fully automatic "download and swap my own running files" step is the one
# piece of this whole plan that genuinely needs a real dry run against an
# actual built installer before it should be trusted unattended -- getting
# "overwrite files a running Windows process has open" wrong corrupts an
# install, and that's a worse failure mode than "a teammate needs to notice
# an update is available." So this checks a version marker on the shared
# drive (the same distribution path the installer itself is published to)
# and, if newer, surfaces it as a tray notification + menu item rather than
# replacing anything on its own. Revisit automating the swap once this has
# been proven safe on a real build.
# --------------------------------------------------------------------------- #
def _check_for_update() -> str | None:
    marker = UPDATE_SOURCE_DIR / VERSION_MARKER_NAME
    try:
        remote_version = marker.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if remote_version and remote_version != __version__:
        return remote_version
    return None


# --------------------------------------------------------------------------- #
# Tray app
# --------------------------------------------------------------------------- #
def main() -> None:
    if pystray is None:
        raise SystemExit(
            "pystray and Pillow are required -- pip install pystray Pillow"
        )

    supervisor = WorkerSupervisor()
    supervisor.start()

    icon = pystray.Icon("BasiqWorker")

    def _refresh_icon() -> None:
        state = _current_state(supervisor)
        icon.icon = _make_icon_image(_STATE_COLORS[state])
        icon.title = _STATE_LABELS[state]

    def _watchdog_loop() -> None:
        while True:
            supervisor.watchdog_tick()
            _refresh_icon()
            time.sleep(WATCHDOG_POLL_SECONDS)

    def _on_pause_resume(_icon, item) -> None:
        if supervisor.paused:
            supervisor.resume()
        else:
            supervisor.pause()
        _refresh_icon()

    def _on_restart(_icon, _item) -> None:
        supervisor.restart()

    def _on_login(_icon, _item) -> None:
        # A separate exe (basiq-youtube-login.exe, same onedir/COLLECT as the
        # other two -- see tools/build/basiq_worker.spec) built from
        # youtube_session.py's own --login CLI mode. Kept as its own process
        # rather than a flag on basiq_worker.py because youtube_session.py
        # has none of AGENT_URL/AUTH_TOKEN/MEDIA_ROOT's requirements -- it
        # only ever needs a cookies path, so it can run standalone even
        # before the rest of this identity's config is fully set up.
        cookies_file = os.environ.get("COOKIES_FILE", str(HERE / "cookies.txt"))
        cmd = (
            [str(HERE / "basiq-youtube-login.exe"), "--login", cookies_file]
            if getattr(sys, "frozen", False)
            else [sys.executable, str(HERE / "youtube_session.py"), "--login", cookies_file]
        )
        subprocess.Popen(cmd, cwd=str(HERE))

    def _on_open_logs(_icon, _item) -> None:
        os.startfile(str(LOG_DIR))  # noqa: S606 (Windows-only tray app)

    def _notify(message: str, title: str) -> None:
        try:
            icon.notify(message, title)
        except (NotImplementedError, AttributeError, OSError):
            print(f"[{title}] {message}")

    def _on_check_update(_icon, _item) -> None:
        version = _check_for_update()
        if version:
            _notify(f"Version {version} is available on the shared drive.", "Basiq Worker update")
        else:
            _notify("Already on the latest version.", "Basiq Worker")

    def _on_quit(_icon, _item) -> None:
        supervisor.quit()
        icon.stop()

    icon.menu = pystray.Menu(
        pystray.MenuItem(lambda item: "Resume" if supervisor._paused else "Pause", _on_pause_resume),
        pystray.MenuItem("Restart Worker", _on_restart),
        pystray.MenuItem("Log into YouTube...", _on_login),
        pystray.MenuItem("Open Logs", _on_open_logs),
        pystray.MenuItem("Check for Update", _on_check_update),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit", _on_quit),
    )
    _refresh_icon()

    threading.Thread(target=_watchdog_loop, daemon=True).start()

    remote_version = _check_for_update()
    if remote_version:
        _notify(f"Version {remote_version} is available -- see 'Check for Update'.", "Basiq Worker update")

    icon.run()


if __name__ == "__main__":
    main()
