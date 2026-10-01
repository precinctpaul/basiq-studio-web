"""Basiq backup worker -- runs on a teammate's machine or an always-on node.

The droplet does every GRAB itself first. When all of its routes are
blocked, the job is offered here (tools/mesh.py decides who gets it,
automatically: the requester's own network first, then always-on nodes,
then anyone). This worker downloads it over this machine's own internet
connection with the exact same code the droplet uses (basiq_agent.run_grab,
in WORKER_MODE), files it straight into this machine's LucidLink archive
folder, and reports back. The droplet confirms it can see the file in its
own LucidLink mount before the job counts as done; if it can't (or
LucidLink is down here), this worker uploads the file over HTTPS instead.
Nothing for a person to do, ever.

    python mesh_worker.py enroll --agent https://basiq.51st.media/agent --code BQ-XXXX-XXXX-XXXX
    python mesh_worker.py run        # what the login item / service runs
    python mesh_worker.py status

No Supabase key, no shared token: just this machine's own worker key
(revocable from the admin console). Mac, Windows and Linux.
"""
from __future__ import annotations

import argparse
import http.client
import json
import logging
import logging.handlers
import os
import platform
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
HEARTBEAT_SECONDS = 10
POLL_SECONDS = 3
SINGLETON_PORT = 47321          # one worker per machine
ARCHIVE_SUBPATH = Path("Archive") / "Basiq-Studio-Hub"   # same folder as the droplet's MEDIA_ROOT


def data_dir() -> Path:
    if sys.platform == "darwin":
        d = Path.home() / "Library" / "Application Support" / "BasiqWorker"
    elif os.name == "nt":
        d = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "BasiqWorker"
    else:
        d = Path.home() / ".basiq-worker"
    d = Path(os.environ.get("BASIQ_WORKER_HOME", d))
    d.mkdir(parents=True, exist_ok=True)
    return d


CONFIG_FILE = data_dir() / "worker.json"
log = logging.getLogger("basiq-worker")


def setup_logging() -> None:
    log.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    fh = logging.handlers.RotatingFileHandler(data_dir() / "worker.log", maxBytes=2_000_000, backupCount=3,
                                              encoding="utf-8")
    fh.setFormatter(fmt)
    log.addHandler(fh)
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    log.addHandler(sh)


def load_config() -> dict[str, Any]:
    try:
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_config(cfg: dict[str, Any]) -> None:
    tmp = CONFIG_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, indent=1), encoding="utf-8")
    os.replace(tmp, CONFIG_FILE)
    try:
        os.chmod(CONFIG_FILE, 0o600)
    except OSError:
        pass


SYNCED_PACKAGES = ("yt-dlp", "bgutil-ytdlp-pot-provider", "curl-cffi")
PACKAGE_SYNC_RETRY_SECONDS = 3600


def package_versions() -> dict[str, str]:
    from importlib import metadata
    out = {}
    for name in SYNCED_PACKAGES:
        try:
            out[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            pass
    return out


def ffmpeg_version() -> str:
    try:
        line = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True, timeout=10).stdout.splitlines()[0]
        return line.split(" Copyright")[0].replace("ffmpeg version ", "")
    except Exception:
        return ""


def sync_packages(want: dict[str, str]) -> tuple[bool, str]:
    """pip-install exactly the droplet's versions (see mesh.SYNCED_PACKAGES)."""
    specs = [f"{name}=={ver}" for name, ver in want.items()]
    out = subprocess.run([sys.executable, "-m", "pip", "install", "-q", "--pre", *specs],
                         capture_output=True, text=True, timeout=900)
    return out.returncode == 0, (out.stderr or out.stdout).strip()[-400:]


def version() -> str:
    try:
        return subprocess.run(["git", "-C", str(REPO), "rev-parse", "--short", "HEAD"],
                              capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        return ""


# --------------------------------------------------------------------------- #
# LucidLink archive folder
# --------------------------------------------------------------------------- #
def lucid_candidates() -> list[Path]:
    """Where this machine's LucidLink filespace (the one the droplet mounts
    at /mnt/lucidlink) shows up, by OS. The archive folder inside it is the
    same relative path everywhere."""
    roots: list[Path] = []
    if os.name == "nt":
        roots += [Path(r"C:\Volumes\md-pac\media"), Path(r"L:\\"), Path(r"C:\LucidLink\media")]
    elif sys.platform == "darwin":
        vols = Path("/Volumes")
        try:
            for v in sorted(vols.iterdir()):
                roots += [v, v / "media"]
        except OSError:
            pass
    else:
        roots += [Path("/mnt/lucidlink"), Path.home() / "lucidlink"]
    return [r / ARCHIVE_SUBPATH for r in roots]


def find_archive(cfg: dict[str, Any]) -> Path | None:
    for cand in ([Path(cfg["media_root"])] if cfg.get("media_root") else []) + lucid_candidates():
        try:
            if cand.is_dir() and any(cand.iterdir()):
                return cand
        except OSError:
            continue
    return None


# --------------------------------------------------------------------------- #
# HTTP to the droplet
# --------------------------------------------------------------------------- #
class Api:
    def __init__(self, base: str, key: str = "") -> None:
        self.base = base.rstrip("/")
        self.key = key
        self.ctx = ssl.create_default_context()

    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        h = {"User-Agent": f"basiq-worker/{version()}"}
        if self.key:
            h["Authorization"] = f"Bearer {self.key}"
        return h | (extra or {})

    def call(self, method: str, path: str, body: dict[str, Any] | None = None, timeout: float = 20) -> tuple[int, Any]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers=self._headers({"Content-Type": "application/json"} if data else None))
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=self.ctx) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw else {})
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read() or b"{}")
            except ValueError:
                return e.code, {}

    def upload(self, path: str, file: Path, timeout: float = 600) -> tuple[int, str]:
        u = urllib.parse.urlsplit(self.base + path)
        conn_cls = http.client.HTTPSConnection if u.scheme == "https" else http.client.HTTPConnection
        kwargs = {"context": self.ctx} if u.scheme == "https" else {}
        conn = conn_cls(u.hostname, u.port, timeout=timeout, **kwargs)
        size = file.stat().st_size
        conn.putrequest("POST", u.path + (f"?{u.query}" if u.query else ""))
        for k, v in self._headers({"Content-Type": "application/octet-stream",
                                   "Content-Length": str(size)}).items():
            conn.putheader(k, v)
        conn.endheaders()
        with open(file, "rb") as f:
            while chunk := f.read(1 << 20):
                conn.send(chunk)
        resp = conn.getresponse()
        text = resp.read().decode("utf-8", "replace")
        conn.close()
        return resp.status, text


# --------------------------------------------------------------------------- #
# Running a job with the droplet's own grab code
# --------------------------------------------------------------------------- #
def import_agent(archive: Path | None) -> Any:
    os.environ["BASIQ_WORKER_MODE"] = "1"
    os.environ["BASIQ_DATA_DIR"] = str(data_dir() / "agent")
    # This machine's own connection, own nothing else: no proxies, no
    # cookies, no database key.
    for k in ("YTDLP_PROXY", "COOKIES_FILE", "COOKIES_FROM_BROWSER", "SUPABASE_URL",
              "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "AUTH_TOKEN"):
        os.environ.pop(k, None)
    os.environ["MEDIA_ROOT"] = str(archive or (data_dir() / "no-archive"))
    sys.path.insert(0, str(HERE))
    import basiq_agent  # noqa: E402
    return basiq_agent


class Worker:
    def __init__(self, cfg: dict[str, Any]) -> None:
        self.cfg = cfg
        self.api = Api(cfg["agent_url"], cfg["key"])
        self.archive = find_archive(cfg)
        self.agent = import_agent(self.archive)
        self.enabled = True
        self.draining = False
        self.current: str | None = None
        self.stop_flags: dict[str, bool] = {}
        self.pending_command: dict[str, Any] | None = None
        self.exit_code: int | None = None
        self._relay_last: dict[str, float] = {}
        self.packages = package_versions()     # what THIS process has loaded
        self.ffmpeg = ffmpeg_version()
        self.package_sync_error = ""
        self._last_sync_try = 0.0
        self._patch_agent()

    # -- relay the agent's progress to the droplet -------------------------
    def _patch_agent(self) -> None:
        agent = self.agent
        real_set_job = agent.set_job

        def relay_set_job(job_id: str, **fields: Any) -> None:
            real_set_job(job_id, **fields)
            relay = {k: v for k, v in fields.items() if k in ("status", "pct", "detail")}
            if not relay or relay.get("status") in ("Complete", "Error"):
                return
            now = time.monotonic()
            if now - self._relay_last.get(job_id, 0) < 1.0 and "detail" not in relay:
                return
            self._relay_last[job_id] = now
            threading.Thread(target=self.api.call, args=("POST", f"/mesh/jobs/{job_id}/update", relay),
                             daemon=True).start()

        agent.set_job = relay_set_job
        agent.stop_requested = lambda job_id: self.stop_flags.get(job_id, False)

    def _watch_state(self, job_id: str, until: threading.Event) -> None:
        while not until.wait(2):
            code, st = self.api.call("GET", f"/mesh/jobs/{job_id}/state")
            if code == 200:
                if st.get("stop") or not st.get("owned", True):
                    self.stop_flags[job_id] = True

    def run_job(self, offer: dict[str, Any]) -> None:
        job_id, req = offer["jobId"], offer.get("request") or {}
        code, _ = self.api.call("POST", f"/mesh/jobs/{job_id}/claim", {})
        if code != 200:
            return
        self.current = job_id
        log.info("claimed %s (%s, tier %s)", job_id, req.get("url"), offer.get("tier"))
        # The agent's own job table needs the row to exist.
        with self.agent._jobs_lock:
            self.agent._jobs[job_id] = {"status": "Queued", "pct": 0.0, "detail": "", "result": None,
                                        "error": "", "kind": "grab"}
        done = threading.Event()
        threading.Thread(target=self._watch_state, args=(job_id, done), daemon=True).start()
        try:
            self.archive = find_archive(self.cfg)   # LucidLink may have come/gone since start
            self.agent.MEDIA_ROOT = self.archive or (data_dir() / "no-archive")
            self.agent.run_grab(job_id, req["url"], req.get("quality") or "HD", bool(req.get("subs")))
            job = self.agent.get_job(job_id) or {}
            with self.agent._jobs_lock:
                ledger = (self.agent._jobs.get(job_id) or {}).get("ledger")
            if job.get("status") == "Complete" and job.get("result"):
                self.finish(job_id, job["result"], ledger)
            else:
                log.info("%s failed here: %s", job_id, job.get("error"))
                self.api.call("POST", f"/mesh/jobs/{job_id}/failed", {"error": job.get("error") or "failed"})
        except Exception as exc:
            log.exception("%s crashed", job_id)
            self.api.call("POST", f"/mesh/jobs/{job_id}/failed", {"error": f"worker crashed: {exc}"})
        finally:
            done.set()
            self.current = None
            self.stop_flags.pop(job_id, None)
            with self.agent._jobs_lock:
                self.agent._jobs.pop(job_id, None)

    def finish(self, job_id: str, result: dict[str, Any], ledger: Any) -> None:
        staged_media = result.pop("stagedMedia", None)
        staged_sub = result.pop("stagedSubtitle", None)
        self.api.call("POST", f"/mesh/jobs/{job_id}/done",
                      {"result": result, "ledger": ledger, "staged": bool(staged_media)}, timeout=60)
        log.info("%s downloaded (%s), waiting for the archive check", job_id, result.get("localPath"))
        media = Path(staged_media) if staged_media else (self.agent.MEDIA_ROOT / result["localPath"])
        sub = Path(staged_sub) if staged_sub else (
            self.agent.MEDIA_ROOT / result["subtitlePath"] if result.get("subtitlePath") else None)
        uploaded = False
        deadline = time.monotonic() + 3 * 3600
        while time.monotonic() < deadline:
            code, st = self.api.call("GET", f"/mesh/jobs/{job_id}/state")
            if code == 200 and not st.get("owned"):
                break                                    # finished (or taken away) on the droplet
            if code == 200 and st.get("phase") == "need_upload" and not uploaded:
                if sub and sub.is_file():
                    self.api.upload(f"/mesh/jobs/{job_id}/upload?kind=subtitle", sub)
                status, text = self.api.upload(f"/mesh/jobs/{job_id}/upload?kind=media", media)
                log.info("%s uploaded over HTTPS: %s %s", job_id, status, text[:200])
                uploaded = status == 200
            time.sleep(3)
        if staged_media:
            shutil.rmtree(Path(staged_media).parent, ignore_errors=True)

    # -- heartbeat, commands, polling ----------------------------------------
    def heartbeat(self) -> None:
        self.archive = find_archive(self.cfg)
        try:
            free = shutil.disk_usage(self.archive or data_dir()).free / 1e9
        except OSError:
            free = None
        body = {"version": version(), "platform": f"{platform.system()} {platform.release()}",
                "hostname": socket.gethostname(), "lucid_ok": bool(self.archive and self.agent_writable()),
                "media_root": str(self.archive or ""), "free_gb": round(free, 1) if free else None,
                "current_job": self.current, "packages": self.packages, "ffmpeg": self.ffmpeg,
                "package_sync_error": self.package_sync_error}
        code, resp = self.api.call("POST", "/mesh/heartbeat", body)
        if code == 401:
            log.warning("this worker was revoked in the admin console -- stopping")
            self.cfg["revoked"] = True
            save_config(self.cfg)
            self.exit_code = 0
            return
        if code != 200:
            return
        self.enabled, self.draining = resp.get("enabled", True), resp.get("draining", False)
        for cmd in resp.get("commands") or []:
            self.pending_command = cmd
        want_pkgs = {k: v for k, v in (resp.get("desiredPackages") or {}).items() if k in SYNCED_PACKAGES}
        if (want_pkgs and any(self.packages.get(k) != v for k, v in want_pkgs.items()) and not self.pending_command
                and time.monotonic() - self._last_sync_try > PACKAGE_SYNC_RETRY_SECONDS):
            self.pending_command = {"type": "sync_packages", "want": want_pkgs}
        want = resp.get("desiredVersion")
        if want and body["version"] and want != body["version"] and not self.pending_command:
            self.pending_command = {"type": "update", "auto": True}

    def agent_writable(self) -> bool:
        self.agent.MEDIA_ROOT = self.archive
        return self.agent._media_root_writable()

    def run_command(self, cmd: dict[str, Any]) -> None:
        kind = cmd.get("type")
        log.info("command: %s", cmd)
        if kind == "update":
            ok = update_self()
            if ok:
                self.exit_code = 75       # non-zero: the service manager restarts us on the new code
        elif kind == "sync_packages":
            self._last_sync_try = time.monotonic()
            ok, detail = sync_packages(cmd["want"])
            if ok:
                log.info("matched the server's packages: %s", cmd["want"])
                self.exit_code = 75       # restart so the new versions are the ones loaded
            else:
                self.package_sync_error = detail
                log.warning("could not match the server's packages (retrying in 1h): %s", detail)
        elif kind == "restart":
            self.exit_code = 75
        elif kind == "uninstall":
            uninstall_service()
            self.cfg["revoked"] = True
            save_config(self.cfg)
            self.exit_code = 0

    def loop(self) -> int:
        log.info("worker %s (%s) running; archive: %s", self.cfg.get("name"), self.cfg.get("worker_id"),
                 self.archive or "NOT FOUND (uploads over HTTPS instead)")
        last_hb = 0.0
        job_thread: threading.Thread | None = None
        while self.exit_code is None:
            if time.monotonic() - last_hb >= HEARTBEAT_SECONDS:
                try:
                    self.heartbeat()
                except Exception as exc:
                    log.warning("heartbeat failed: %s", exc)
                last_hb = time.monotonic()
            busy = job_thread is not None and job_thread.is_alive()
            if self.pending_command and not busy:
                cmd, self.pending_command = self.pending_command, None
                self.run_command(cmd)
                continue
            if not busy and self.enabled and not self.draining:
                try:
                    code, resp = self.api.call("GET", "/mesh/jobs")
                    offers = resp.get("jobs", []) if code == 200 else []
                    if code == 401:
                        last_hb = 0
                    if offers:
                        offers.sort(key=lambda o: o.get("tier", 9))
                        job_thread = threading.Thread(target=self.run_job, args=(offers[0],), daemon=True)
                        job_thread.start()
                except Exception as exc:
                    log.warning("poll failed: %s", exc)
            time.sleep(POLL_SECONDS)
        return self.exit_code


# --------------------------------------------------------------------------- #
# Self-update / service management
# --------------------------------------------------------------------------- #
def update_self() -> bool:
    """A git-checkout install (the always-on node): pull, refresh deps.
    The packaged installer (stage 2) replaces this with its own updater."""
    if not (REPO / ".git").exists():
        log.warning("not a git checkout -- can't self-update")
        return False
    try:
        out = subprocess.run(["git", "-C", str(REPO), "pull", "--ff-only", "-q"], capture_output=True,
                             text=True, timeout=120)
        if out.returncode != 0:
            log.warning("git pull failed: %s", out.stderr.strip())
            return False
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-r", str(HERE / "requirements-worker.txt")],
                       capture_output=True, text=True, timeout=900)
        log.info("updated to %s", version())
        return True
    except Exception as exc:
        log.warning("update failed: %s", exc)
        return False


LAUNCHD_LABEL = "media.basiq.worker"


def uninstall_service() -> None:
    if sys.platform == "darwin":
        plist = Path.home() / "Library" / "LaunchAgents" / f"{LAUNCHD_LABEL}.plist"
        plist.unlink(missing_ok=True)   # launchd stops relaunching once it's gone (and we exit 0)
    elif os.name == "nt":
        subprocess.run(["schtasks", "/delete", "/tn", "Basiq Backup Worker", "/f"], capture_output=True)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def cmd_enroll(args: argparse.Namespace) -> int:
    api = Api(args.agent)
    name = args.name or socket.gethostname()
    code, resp = api.call("POST", "/mesh/enroll", {"code": args.code, "name": name, "owner": args.owner or "",
                                                  "platform": f"{platform.system()} {platform.release()}"})
    if code != 200:
        print(f"enroll failed ({code}): {resp.get('error')}")
        return 1
    cfg = {"agent_url": args.agent, "worker_id": resp["workerId"], "key": resp["key"], "name": name,
           "owner": args.owner or ""}
    if args.media_root:
        cfg["media_root"] = args.media_root
    save_config(cfg)
    print(f"enrolled as {name} ({resp['workerId']}); archive: {find_archive(cfg) or 'not found yet'}")
    return 0


def cmd_run(_: argparse.Namespace) -> int:
    setup_logging()
    cfg = load_config()
    if not cfg.get("key"):
        log.error("not enrolled -- run: mesh_worker.py enroll --agent URL --code CODE")
        return 0
    if cfg.get("revoked"):
        log.info("revoked -- not starting")
        return 0
    try:
        lock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        lock.bind(("127.0.0.1", SINGLETON_PORT))
    except OSError:
        log.info("another worker is already running on this machine")
        return 0
    return Worker(cfg).loop()


def cmd_status(_: argparse.Namespace) -> int:
    cfg = load_config()
    print(json.dumps({k: v for k, v in cfg.items() if k != "key"} | {"archive": str(find_archive(cfg) or "")},
                     indent=1))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("enroll")
    e.add_argument("--agent", required=True)
    e.add_argument("--code", required=True)
    e.add_argument("--name")
    e.add_argument("--owner")
    e.add_argument("--media-root")
    sub.add_parser("run")
    sub.add_parser("status")
    args = ap.parse_args()
    return {"enroll": cmd_enroll, "run": cmd_run, "status": cmd_status}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
