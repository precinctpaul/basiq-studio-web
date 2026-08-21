"""
basiq_agent.py — the local companion agent for Basiq Studio Hub (web).

Runs on the operator's own machine and does the two jobs a Vercel function
structurally cannot: pulling media with yt-dlp (a C-SPAN hearing is hours
long and hundreds of MB) and transcribing it with faster-whisper. Audio and
video never leave this machine except as the finished file, which the agent
uploads straight to storage — the browser never proxies the bytes.

    pip install -r requirements.txt
    python basiq_agent.py

Endpoints
    GET  /health           -> {status, model, ytdlp, ...}
    POST /probe            -> {is_live}          (arms the GRAB/GO LIVE label)
    POST /grab             -> {jobId}            (background download + upload)
    POST /transcribe       -> {jobId}            (background transcription)
    GET  /jobs/<id>        -> {status, pct, detail, result, error}
    GET  /logs             -> {logs: [...]}       (last 200 request/activity lines)

Worker delegation (see tools/basiq_worker.py) — only relevant when
DELEGATE_TO_WORKER is set, which makes /grab and /capture leave their job
"Queued" instead of running yt-dlp/ffmpeg here:
    GET  /worker/jobs?kind=grab,capture      -> {jobs: [...]}   (Queued + unclaimed)
    POST /worker/jobs/<id>/claim             -> {claimed} | 409 if taken
    POST /worker/jobs/<id>/update            -> {updated}       (relays set_job fields)
    GET  /worker/jobs/<id>/stop-requested    -> {stop}          (STOP button bridge)

Download behaviour is a faithful port of DownloadTask in app/tasks.py — same
format ladder, same vertical-aware caps, same mp4 merge, same subtitle opts —
so a file grabbed here matches one grabbed by the desktop build.
"""
from __future__ import annotations

import collections
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Sequence
from urllib.parse import urlparse

HERE = (
    Path(sys.executable).resolve().parent
    if getattr(sys, "frozen", False)
    else Path(__file__).resolve().parent
)

DATA_DIR = (
    Path.home() / "Library" / "Application Support" / "BasiqAgent"
    if getattr(sys, "frozen", False) and sys.platform == "darwin"
    else HERE
)
DATA_DIR.mkdir(parents=True, exist_ok=True)

def _media_root_from_file() -> str:
    marker = DATA_DIR / "media_root.txt"
    try:
        return marker.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


MEDIA_ROOT = Path(
    os.environ.get("MEDIA_ROOT", "") or _media_root_from_file() or (DATA_DIR / "media")
).expanduser()
MEDIA_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".m4v", ".ts", ".mp3", ".m4a", ".wav"}

AUTH_TOKEN = os.environ.get("AUTH_TOKEN", "")
DELEGATE_TO_WORKER = os.environ.get("DELEGATE_TO_WORKER", "") not in ("", "0", "false")

HF_CACHE = DATA_DIR / "hf_cache"
HF_CACHE.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HOME", str(HF_CACHE))
os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(HF_CACHE / "hub"))
os.environ.setdefault("TRANSFORMERS_CACHE", str(HF_CACHE / "transformers"))
os.environ.setdefault("SENTENCE_TRANSFORMERS_HOME", str(HF_CACHE / "sentence-transformers"))

try:
    from faster_whisper import WhisperModel
except ImportError:
    WhisperModel = None  # type: ignore[assignment]

try:
    import yt_dlp
except ImportError:
    yt_dlp = None  # type: ignore[assignment]
CACHE_DIR = DATA_DIR / "whisper_cache"

MODEL_NAME = os.environ.get("WHISPER_MODEL", "base")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE", "int8")
BEAM_SIZE = int(os.environ.get("WHISPER_BEAM", "5"))
VAD_FILTER = os.environ.get("WHISPER_VAD", "1").lower() not in ("0", "false", "no")
DEFAULT_LANGUAGE = os.environ.get("WHISPER_LANG", "en") or None
PORT = int(os.environ.get("PORT", "8000"))

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

_model_lock = threading.Lock()
_model: Any = None


def _importable(name: str) -> bool:
    import importlib.util
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False

_jobs: dict[str, dict[str, Any]] = {}
_jobs_lock = threading.Lock()
_stop_flags: dict[str, threading.Event] = {}

LOG_BUFFER: collections.deque[str] = collections.deque(maxlen=200)


def log(msg: str) -> None:
    entry = f"[{datetime.now().strftime('%H:%M:%S')}] {msg}"
    print(entry, flush=True)
    LOG_BUFFER.append(entry)


# --------------------------------------------------------------------------- #
# Whisper
# --------------------------------------------------------------------------- #
def get_model():
    global _model
    if WhisperModel is None:
        raise RuntimeError("faster-whisper is not installed")
    with _model_lock:
        if _model is None:
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            print(f"Loading faster-whisper '{MODEL_NAME}' ({DEVICE}/{COMPUTE_TYPE})…")
            _model = WhisperModel(
                MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE,
                download_root=str(CACHE_DIR),
            )
            print("Model ready.")
        return _model


def download_to_temp(url: str) -> str:
    fd, path = tempfile.mkstemp(suffix=".media")
    os.close(fd)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=30) as resp, open(path, "wb") as out:
            while chunk := resp.read(1024 * 1024):
                out.write(chunk)
    except Exception:
        os.remove(path)
        raise
    return path


# --------------------------------------------------------------------------- #
# Jobs
# --------------------------------------------------------------------------- #
def new_job(kind: str = "") -> str:
    job_id = uuid.uuid4().hex
    with _jobs_lock:
        _jobs[job_id] = {
            "status": "Queued", "pct": 0.0, "detail": "", "result": None, "error": "",
            "kind": kind, "claimed_by": None, "claimed_at": None,
        }
    return job_id


def set_job(job_id: str, **fields: Any) -> None:
    with _jobs_lock:
        if job_id in _jobs:
            _jobs[job_id].update(fields)


def get_job(job_id: str) -> dict[str, Any] | None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        return dict(job) if job else None


def list_worker_jobs(kinds: set[str]) -> list[dict[str, Any]]:
    with _jobs_lock:
        return [
            {"jobId": jid, **job}
            for jid, job in _jobs.items()
            if job.get("kind") in kinds and job.get("status") == "Queued" and not job.get("claimed_by")
        ]


def claim_job(job_id: str, worker_id: str) -> bool:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None or job.get("status") != "Queued" or job.get("claimed_by"):
            return False
        job["claimed_by"] = worker_id
        job["claimed_at"] = time.time()
        return True


def stop_requested(job_id: str) -> bool:
    event = _stop_flags.get(job_id)
    return event is not None and event.is_set()

_WORKER_UPDATE_FIELDS = {
    "status", "pct", "detail", "result", "error", "local_path", "seconds", "bytes_written",
}


# --------------------------------------------------------------------------- #
# Hardening Helpers
# --------------------------------------------------------------------------- #
def sanitize_media_path(raw_path: str) -> str:
    decoded = urllib.parse.unquote(raw_path)
    cleaned = decoded.strip("'\"")
    return cleaned


# --------------------------------------------------------------------------- #
# Download
# --------------------------------------------------------------------------- #
def format_string(quality: str, is_vertical: bool) -> str:
    if "Audio" in quality:
        return "bestaudio/best"
    cap = {"HD": 1920 if is_vertical else 1080,
           "SD": 1280 if is_vertical else 720}.get(quality, 640 if is_vertical else 360)
    return f"bestvideo[height<={cap}]+bestaudio/best[height<={cap}]/best"


def base_opts(referer: str) -> dict[str, Any]:
    opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "noprogress": True,
        "socket_timeout": 30,
        "retries": 3,
        "fragment_retries": 3,
        "concurrent_fragment_downloads": 4,
        "http_headers": {"User-Agent": USER_AGENT, "Referer": referer},
        "extractor_args": {"youtube": {"player_client": ["android", "web"]}},
        "restrictfilenames": True,
        "windowsfilenames": True,
    }
    if browser := os.environ.get("COOKIES_FROM_BROWSER", "").strip():
        opts["cookiesfrombrowser"] = (browser,)
    return opts


class _NullLogger:
    def debug(self, msg): pass
    def info(self, msg): pass
    def warning(self, msg): pass
    def error(self, msg): pass


def probe_is_live(url: str) -> bool:
    if yt_dlp is None:
        return False
    opts = base_opts(url) | {"logger": _NullLogger(), "skip_download": True}
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
        return bool(info and (info.get("is_live") or info.get("live_status") == "is_live"))
    except Exception:
        return False


_ILLEGAL_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _free_media_path(title: str, suffix: str, subdir: str = "") -> Path:
    root = (MEDIA_ROOT / subdir) if subdir else MEDIA_ROOT
    root.mkdir(parents=True, exist_ok=True)
    
    clean = re.sub(r"['\"‘’“”]", "", title or "")
    clean = _ILLEGAL_NAME.sub(" ", clean).strip()
    clean = re.sub(r"\s+", " ", clean)[:120] or "Untitled"
    
    dest = root / f"{clean}{suffix}"
    counter = 2
    while dest.exists():
        dest = root / f"{clean} ({counter}){suffix}"
        counter += 1
    return dest


def store_in_media_root(src: Path, title: str, subdir: str = "") -> str:
    dest = _free_media_path(title, src.suffix, subdir)
    shutil.move(str(src), str(dest))
    return dest.relative_to(MEDIA_ROOT).as_posix()


def reserve_media_path(title: str, suffix: str, subdir: str = "") -> Path:
    dest = _free_media_path(title, suffix, subdir)
    dest.touch()
    return dest


RETRY_DELAYS = (60, 300)

def _retryable(message: str) -> bool:
    low = (message or "").lower()
    transient = (
        "429", "too many requests", "rate limit", "rate-limit", "throttl",
        "temporarily", "try again", "timed out", "timeout", "connection reset",
        "connection aborted", "connection refused", "unable to download",
        "read operation", "remote end closed", "503", "502", "500",
        "sign in to confirm", "unable to extract",
    )
    permanent = (
        "private video", "video unavailable", "removed by the uploader",
        "copyright", "members-only", "is not available in your country",
        "no video formats found", "unsupported url",
    )
    if any(p in low for p in permanent):
        return False
    return any(t in low for t in transient)


def _wait_with_countdown(job_id: str, seconds: int, attempt: int, total: int) -> None:
    label = "1 minute" if seconds <= 60 else f"{seconds // 60} minutes"
    end = time.monotonic() + seconds
    set_job(job_id, status=f"Rate limited — retrying in {label}", pct=None)
    while True:
        left = int(end - time.monotonic())
        if left <= 0:
            break
        mins, secs = divmod(left, 60)
        countdown = f"{mins}:{secs:02d}" if mins else f"{secs}s"
        set_job(
            job_id,
            status=f"Retrying in {countdown}  ·  attempt {attempt + 1} of {total}",
            pct=None,
        )
        time.sleep(min(2, max(1, left)))


def run_grab(job_id: str, url: str, quality: str, subs: bool) -> None:
    if yt_dlp is None:
        set_job(job_id, status="Error", error="yt-dlp is not installed", pct=None)
        return

    total_attempts = len(RETRY_DELAYS) + 1
    for attempt in range(total_attempts):
        try:
            _grab_once(job_id, url, quality, subs, attempt, total_attempts)
            return
        except Exception as exc:
            message = str(exc)
            last = attempt == total_attempts - 1
            if last or not _retryable(message):
                set_job(job_id, status="Error", error=message, pct=None)
                return
            print(f"[grab] attempt {attempt + 1} failed ({message[:120]}); backing off")
            _wait_with_countdown(job_id, RETRY_DELAYS[attempt], attempt, total_attempts)


def _grab_once(
    job_id: str,
    url: str,
    quality: str,
    subs: bool,
    attempt: int = 0,
    total_attempts: int = 1,
) -> None:
    workdir = tempfile.mkdtemp(prefix="basiq_grab_")
    try:
        suffix = f"  ·  attempt {attempt + 1} of {total_attempts}" if attempt else ""
        set_job(job_id, status=f"Resolving source…{suffix}", pct=0.0)

        is_vertical = False
        title = ""
        try:
            with yt_dlp.YoutubeDL(base_opts(url) | {"logger": _NullLogger()}) as ydl:
                info = ydl.extract_info(url, download=False)
            if info:
                w = int(info.get("width") or 1920)
                h = int(info.get("height") or 1080)
                is_vertical = h > w
                title = (info.get("title") or "").strip()
        except Exception as exc:
            set_job(job_id, detail=f"probe failed: {exc}")

        set_job(job_id, status="Downloading…", detail=title)

        def hook(d: dict) -> None:
            if d.get("status") == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                done = d.get("downloaded_bytes") or 0
                if total:
                    set_job(job_id, pct=min(99.0, done / total * 100.0))
                speed = d.get("speed")
                if speed:
                    set_job(job_id, status=f"Downloading — {speed / 1_000_000:.1f} MB/s")
            elif d.get("status") == "finished":
                set_job(job_id, status="Muxing…", pct=99.0)

        opts = base_opts(url) | {
            "logger": _NullLogger(),
            "format": format_string(quality, is_vertical),
            "outtmpl": str(Path(workdir) / f"{job_id}.%(ext)s"),
            "ignoreerrors": False,
            "progress_hooks": [hook],
        }
        if "Audio" in quality:
            opts["postprocessors"] = [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }]
        else:
            opts["merge_output_format"] = "mp4"
        if subs:
            opts.update({
                "writesubtitles": True,
                "writeautomaticsub": True,
                "subtitleslangs": ["en.*", "orig"],
                "subtitlesformat": "srt/vtt/best",
            })

        with yt_dlp.YoutubeDL(opts) as ydl:
            result = ydl.extract_info(url, download=True)
        if not title:
            title = (result.get("title") or "Untitled").strip()

        media = [p for p in Path(workdir).iterdir()
                 if p.suffix.lower() in {".mp4", ".mkv", ".webm", ".m4a", ".mp3", ".ts"}]
        if not media:
            raise RuntimeError("yt-dlp produced no media file")
        media_file = max(media, key=lambda p: p.stat().st_size)
        size_bytes = media_file.stat().st_size

        set_job(job_id, status="Filing to the shared drive…", pct=99.0)
        
        # Save as strict ID
        local_path = store_in_media_root(media_file, job_id)

        # Write metadata sidecar so UI shows the correct display title
        meta_dest = MEDIA_ROOT / f"{job_id}.meta.json"
        with open(meta_dest, "w", encoding="utf-8") as f:
            json.dump({"title": title}, f, ensure_ascii=False)

        set_job(job_id, status="Complete", pct=100.0, result={
            "title": title,
            "sizeBytes": size_bytes,
            "ext": media_file.suffix.lstrip("."),
            "uploader": (result.get("uploader") or result.get("channel") or "") if result else "",
            "channel": (result.get("channel") or result.get("channel_id") or "") if result else "",
            "uploadDate": (result.get("upload_date") or "") if result else "",
            "sourceUrl": url,
            "localPath": local_path,
        })
    finally:
        for p in Path(workdir).glob("*"):
            try:
                p.unlink()
            except OSError:
                pass
        try:
            os.rmdir(workdir)
        except OSError:
            pass


# --------------------------------------------------------------------------- #
# Live capture
# --------------------------------------------------------------------------- #
MANIFEST_EXTS = (".m3u8", ".mpd", ".f4m", ".ism")
STREAM_SCHEMES = ("rtmp", "rtmps", "rtmpe", "rtsp", "srt", "udp", "rtp", "tcp")
_LISTEN_HOSTS = {"0.0.0.0", "127.0.0.1", "localhost", "::", "[::]"}

KIND_MANIFEST = "manifest"
KIND_PROTOCOL = "protocol"
KIND_LISTENER = "listener"
KIND_PAGE = "page"


# --------------------------------------------------------------------------- #
# Shared media library
# --------------------------------------------------------------------------- #
def safe_media_path(rel: str) -> Path:
    root = MEDIA_ROOT.resolve()
    target = (root / rel.lstrip("/\\")).resolve()
    if target != root and root not in target.parents:
        raise ValueError("path escapes the media root")
    return target


def _bundled_ffprobe() -> str | None:
    plat = {"win32": "win32", "darwin": "darwin", "linux": "linux"}.get(sys.platform)
    if plat is None:
        return None
    arch = {"AMD64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(
        platform.machine(), "x64"
    )
    name = "ffprobe.exe" if plat == "win32" else "ffprobe"
    cand = HERE.parent / "node_modules" / "ffprobe-static" / "bin" / plat / arch / name
    return str(cand) if cand.is_file() else None


def probe_media(path: Path) -> dict[str, Any]:
    exe = shutil.which("ffprobe") or _bundled_ffprobe()
    if not exe:
        return {}
    try:
        proc = subprocess.Popen(
            [exe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
    except Exception:
        return {}

    # A file a network mount (LucidLink, NFS) can't actually fetch — a
    # missing cloud object, an offline source peer — leaves ffprobe stuck
    # in an uninterruptible kernel read that SIGKILL cannot preempt, so
    # waiting it out would hang the whole library scan on one bad file.
    # Give up on THIS file past a short deadline and let it keep running
    # unattended; communicate() is safe to call again per the docs, so a
    # daemon thread reaps it whenever (if ever) it actually exits instead
    # of leaving a zombie.
    try:
        out, _ = proc.communicate(timeout=8)
    except subprocess.TimeoutExpired:
        threading.Thread(target=proc.communicate, daemon=True).start()
        return {}

    try:
        if proc.returncode != 0:
            return {}
        info = json.loads(out or "{}")
    except Exception:
        return {}

    streams = info.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    fmt = info.get("format") or {}

    fps = 0.0
    if video and video.get("avg_frame_rate"):
        try:
            num, _, den = video["avg_frame_rate"].partition("/")
            fps = round(float(num) / float(den), 3) if float(den) else 0.0
        except (ValueError, ZeroDivisionError):
            fps = 0.0

    return {
        "duration": float(fmt.get("duration") or 0.0),
        "width": int(video.get("width") or 0) if video else 0,
        "height": int(video.get("height") or 0) if video else 0,
        "fps": fps,
        "hasVideo": video is not None,
        "hasAudio": audio is not None,
        "vcodec": (video or {}).get("codec_name", ""),
        "acodec": (audio or {}).get("codec_name", ""),
    }


_probe_cache: dict[tuple[str, int, int], dict[str, Any]] = {}
_scan_lock = threading.Lock()
_last_scan_result: list[dict[str, Any]] = []
_last_scan_at = 0.0
_SCAN_RESULT_TTL_SECONDS = 15.0


def get_library_files(force: bool = False) -> list[dict[str, Any]]:
    # do_GET runs each request on its own thread with no serialization, so
    # with many teammates' browsers all polling /library at once, a file
    # scan_media() hasn't probed yet gets raced by every concurrent request
    # before any of them populates _probe_cache — each spawning its own
    # ffprobe on the SAME stuck placeholder file. A held-open network mount
    # (LucidLink) that never resolves means those duplicate ffprobes can
    # pile up unbounded, one storm per burst of requests, without this.
    # Solution: only one scan_media() call runs at a time; a fresh-enough
    # result short-circuits entirely, and anyone who arrives mid-scan just
    # waits for that ONE scan instead of starting their own.
    global _last_scan_result, _last_scan_at
    now = time.monotonic()
    if not force and _last_scan_result and (now - _last_scan_at) < _SCAN_RESULT_TTL_SECONDS:
        return _last_scan_result
    with _scan_lock:
        now = time.monotonic()
        if not force and _last_scan_result and (now - _last_scan_at) < _SCAN_RESULT_TTL_SECONDS:
            return _last_scan_result
        result = scan_media()
        _last_scan_result = result
        _last_scan_at = time.monotonic()
        return result


def scan_media() -> list[dict[str, Any]]:
    root = MEDIA_ROOT
    if not root.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for path in sorted(root.glob("*")):
        try:
            if not path.is_file() or path.suffix.lower() not in MEDIA_EXTS:
                continue
            if ".part" in path.name:
                continue
                
            display_name = path.stem
            meta_path = path.with_suffix(".meta.json")
            if meta_path.exists():
                try:
                    with open(meta_path, "r", encoding="utf-8") as mf:
                        display_name = json.load(mf).get("title", path.stem)
                except Exception:
                    pass

            stat = path.stat()
            rel = path.relative_to(root).as_posix()
            key = (rel, stat.st_size, int(stat.st_mtime))
            info = _probe_cache.get(key)
            if info is None:
                info = probe_media(path)
                _probe_cache[key] = info
            out.append({
                "path": rel,
                "name": display_name,
                "sizeBytes": stat.st_size,
                "modified": int(stat.st_mtime),
                **info,
            })
        except OSError:
            continue
    return out


def find_ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    for candidate in (
        HERE.parent / "node_modules" / "ffmpeg-static" / "ffmpeg.exe",
        HERE.parent / "node_modules" / "ffmpeg-static" / "ffmpeg",
    ):
        if candidate.is_file():
            return str(candidate)
    raise RuntimeError("FFmpeg was not found on PATH or in node_modules/ffmpeg-static")


def classify_source(url: str) -> tuple[str, str]:
    raw = (url or "").strip()
    if not raw:
        return KIND_PAGE, ""
    parsed = urlparse(raw)
    scheme = (parsed.scheme or "").lower()
    path_lower = (parsed.path or "").lower()
    low = raw.lower()

    if scheme in STREAM_SCHEMES:
        host = (parsed.hostname or "").lower()
        return (KIND_LISTENER if host in _LISTEN_HOSTS else KIND_PROTOCOL), raw

    if scheme in ("http", "https") or not scheme:
        if any(path_lower.endswith(ext) for ext in MANIFEST_EXTS):
            return KIND_MANIFEST, raw
        if any(f"{ext}?" in low for ext in MANIFEST_EXTS):
            return KIND_MANIFEST, raw
        if any(low.endswith(ext) for ext in MANIFEST_EXTS):
            return KIND_MANIFEST, raw
    return KIND_PAGE, raw


def best_stream_url(info: dict) -> str:
    if info.get("manifest_url"):
        return str(info["manifest_url"])
    formats = info.get("formats") or []
    manifests = [f for f in formats if f.get("manifest_url")]
    if manifests:
        return str(manifests[-1]["manifest_url"])
    for fmt in reversed(formats):
        if fmt.get("url") and fmt.get("acodec") not in (None, "none"):
            return str(fmt["url"])
    for fmt in reversed(formats):
        if fmt.get("url"):
            return str(fmt["url"])
    return str(info.get("url") or "")


def resolve_live_stream(url: str) -> tuple[str, str, dict[str, str]]:
    if yt_dlp is None:
        raise RuntimeError("yt-dlp is not installed")
    opts = base_opts(url) | {"logger": _NullLogger()}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False) or {}
    stream = best_stream_url(info)
    if not stream:
        raise RuntimeError("no playable stream found on that page")
    title = (info.get("title") or "").strip() or title_from_url(url)
    headers = {k: v for k, v in (info.get("http_headers") or {}).items()}
    return stream, title, headers


def title_from_url(url: str) -> str:
    host = (urlparse(url).hostname or "").replace("www.", "")
    return f"{host} live" if host else "Live Capture"


def build_capture_cmd(
    stream_url: str,
    kind: str,
    dest: str,
    max_seconds: float = 0.0,
    headers: dict[str, str] | None = None,
) -> list[str]:
    cmd = [find_ffmpeg(), "-hide_banner", "-loglevel", "error", "-y"]

    if headers:
        cmd += ["-headers", "".join(f"{k}: {v}\r\n" for k, v in headers.items())]

    scheme = (urlparse(stream_url).scheme or "").lower()
    if scheme in ("http", "https"):
        cmd += ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "10"]
    if kind == KIND_LISTENER:
        cmd += ["-listen", "1"]

    cmd += ["-i", stream_url]
    if max_seconds and max_seconds > 0:
        cmd += ["-t", f"{float(max_seconds):.3f}"]
    cmd += [
        "-map", "0:v?",
        "-map", "0:a?",
        "-c", "copy",
        "-f", "mpegts",
        "-flush_packets", "1",
        "-progress", "pipe:1",
        dest,
    ]
    return cmd


def build_remux_cmd(src: str, dest: str) -> list[str]:
    return [
        find_ffmpeg(), "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
        "-fflags", "+genpts",
        "-i", src,
        "-c", "copy",
        "-movflags", "+faststart",
        dest,
    ]


def human_size(num_bytes: float) -> str:
    n = float(num_bytes or 0)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit in ("B", "KB") else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"


def format_short(seconds: float) -> str:
    total = int(max(0.0, seconds))
    h, m, s = total // 3600, (total % 3600) // 60, total % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


_PROGRESS_KEY = re.compile(r"^([a-z_]+)=(.*)$")


def run_capture(
    cmd: Sequence[str],
    on_tick: Callable[[float, int], None],
    should_stop: Callable[[], bool],
    poll_interval: float = 0.25,
) -> tuple[int, str]:
    proc = subprocess.Popen(
        list(cmd),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    err_tail: list[str] = []
    state = {"seconds": 0.0, "bytes": 0}
    stopped = threading.Event()

    def drain_stderr() -> None:
        for line in proc.stderr:  # type: ignore[union-attr]
            line = line.rstrip()
            if line:
                err_tail.append(line)
                del err_tail[:-40]

    def watch_controls() -> None:
        while proc.poll() is None:
            if should_stop():
                stopped.set()
                graceful_stop(proc)
                return
            time.sleep(poll_interval)

    threads = [
        threading.Thread(target=drain_stderr, daemon=True),
        threading.Thread(target=watch_controls, daemon=True),
    ]
    for t in threads:
        t.start()

    try:
        for raw in proc.stdout:  # type: ignore[union-attr]
            m = _PROGRESS_KEY.match(raw.strip())
            if not m:
                continue
            key, value = m.group(1), m.group(2).strip()
            if key == "out_time_ms":
                try:
                    state["seconds"] = int(value) / 1_000_000.0
                except ValueError:
                    continue
            elif key == "total_size":
                try:
                    state["bytes"] = int(value)
                except ValueError:
                    continue
            elif key == "progress":
                on_tick(state["seconds"], state["bytes"])
    finally:
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            hard_stop(proc)
        for t in threads:
            t.join(timeout=2)
        try:
            if proc.stdin and not proc.stdin.closed:
                proc.stdin.close()
        except OSError:
            pass

    code = proc.returncode or 0
    if stopped.is_set():
        code = 0
    return code, "\n".join(err_tail[-12:])


def graceful_stop(proc: subprocess.Popen) -> None:
    try:
        if proc.stdin and not proc.stdin.closed:
            proc.stdin.write("q")
            proc.stdin.flush()
    except (OSError, ValueError):
        pass
    try:
        proc.wait(timeout=10)
        return
    except subprocess.TimeoutExpired:
        pass
    hard_stop(proc)


def hard_stop(proc: subprocess.Popen) -> None:
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except (subprocess.TimeoutExpired, OSError):
        try:
            proc.kill()
        except OSError:
            pass


def run_live_capture(
    job_id: str,
    url: str,
    title_hint: str,
    max_minutes: float,
) -> None:
    ts_path: Path | None = None
    try:
        set_job(job_id, status="Resolving source…", pct=None)
        kind, raw = classify_source(url)

        headers: dict[str, str] = {}
        title = title_hint.strip()
        stream_url = raw
        if kind == KIND_PAGE:
            stream_url, resolved_title, headers = resolve_live_stream(raw)
            title = title or resolved_title
        title = title or title_from_url(url)

        ts_path = reserve_media_path(job_id, ".ts")
        rel_ts = ts_path.relative_to(MEDIA_ROOT).as_posix()
        set_job(job_id, status="Connecting…", detail=title, local_path=rel_ts)

        max_seconds = max(0.0, float(max_minutes or 0.0)) * 60.0
        cmd = build_capture_cmd(stream_url, kind, str(ts_path), max_seconds, headers)

        def on_tick(seconds: float, written: int) -> None:
            set_job(
                job_id,
                status=f"Recording  {format_short(seconds)}  ·  {human_size(written)}",
                seconds=seconds,
                bytes_written=written,
            )

        stop_event = _stop_flags.setdefault(job_id, threading.Event())
        code, err = run_capture(cmd, on_tick, stop_event.is_set)

        if not ts_path.exists() or ts_path.stat().st_size == 0:
            raise RuntimeError(err or "the capture produced no data — is that stream actually live?")
        if code != 0:
            set_job(job_id, detail=f"ffmpeg exited {code}; keeping the recording")

        set_job(job_id, status="Finalising (remux to MP4)…")
        mp4_path = reserve_media_path(job_id, ".mp4")
        remux = subprocess.run(
            build_remux_cmd(str(ts_path), str(mp4_path)), capture_output=True, text=True, timeout=1800,
        )
        if remux.returncode == 0 and mp4_path.is_file() and mp4_path.stat().st_size > 0:
            final_path, ext = mp4_path, "mp4"
            try:
                ts_path.unlink()
            except OSError:
                pass
        else:
            set_job(job_id, detail="remux failed; the .ts recording is the final file")
            try:
                mp4_path.unlink()
            except OSError:
                pass
            final_path, ext = ts_path, "ts"

        # Write metadata sidecar
        meta_dest = MEDIA_ROOT / f"{job_id}.meta.json"
        with open(meta_dest, "w", encoding="utf-8") as f:
            json.dump({"title": title}, f, ensure_ascii=False)

        rel_final = final_path.relative_to(MEDIA_ROOT).as_posix()
        seconds = (get_job(job_id) or {}).get("seconds", 0.0)
        set_job(job_id, status="Complete", pct=100.0, local_path=rel_final, result={
            "title": title,
            "sizeBytes": final_path.stat().st_size,
            "ext": ext,
            "uploader": "",
            "uploadDate": "",
            "sourceUrl": url,
            "durationSeconds": seconds,
            "isLive": True,
            "localPath": rel_final,
        })
    except Exception as exc:
        if ts_path is not None and ts_path.exists() and ts_path.stat().st_size == 0:
            try:
                ts_path.unlink()
            except OSError:
                pass
        set_job(job_id, status="Error", error=str(exc), pct=None)
    finally:
        _stop_flags.pop(job_id, None)


# --------------------------------------------------------------------------- #
# Transcribe (Asynchronous Job)
# --------------------------------------------------------------------------- #
def parse_vtt_or_srt(sub_path: str) -> list[dict[str, Any]] | None:
    if not os.path.exists(sub_path):
        return None
    segments = []
    try:
        with open(sub_path, "r", encoding="utf-8", errors="ignore") as f:
            lines = f.readlines()
        time_pattern = re.compile(r"(\d+):(\d+):(\d+)[\.,](\d+)\s*-->\s*(\d+):(\d+):(\d+)[\.,](\d+)")
        for i, line in enumerate(lines):
            match = time_pattern.search(line)
            if match:
                h1, m1, s1, ms1, h2, m2, s2, ms2 = map(int, match.groups())
                start = h1 * 3600 + m1 * 60 + s1 + ms1 / 1000.0
                end = h2 * 3600 + m2 * 60 + s2 + ms2 / 1000.0
                text_lines = []
                j = i + 1
                while j < len(lines) and lines[j].strip() and not time_pattern.search(lines[j]):
                    clean = re.sub(r"<[^>]+>", "", lines[j]).strip()
                    if clean and not clean.isdigit():
                        text_lines.append(clean)
                    j += 1
                text = " ".join(text_lines)
                if text:
                    segments.append({"start": round(start, 2), "end": round(end, 2), "text": text})
        return segments if segments else None
    except Exception as e:
        print(f"[subtitles] Failed to parse subtitle file {sub_path}: {e}")
        return None

def extract_audio_wav(input_video_path: str) -> str:
    temp_dir = tempfile.gettempdir()
    temp_id = uuid.uuid4().hex
    wav_path = os.path.join(temp_dir, f"basiq_audio_{temp_id}.wav")
    cmd = [
        find_ffmpeg(), "-y", "-i", input_video_path,
        "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        wav_path
    ]
    try:
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        return wav_path
    except Exception:
        if os.path.exists(wav_path):
            os.remove(wav_path)
        return input_video_path

def run_transcribe(job_id: str, url: str, rel: str, start_seconds: float, language: str) -> None:
    tmp_path = None
    slice_path = None
    local_source = None
    audio_path = None
    
    try:
        # Hijacked uploads are marked as 'transcribe' instantly to swap the UI color
        set_job(job_id, kind="transcribe", status="Preparing media…", pct=5.0)
        
        if rel:
            clean_rel = sanitize_media_path(rel)
            local_source = str(safe_media_path(clean_rel))
            
            if not os.path.isfile(local_source):
                raise RuntimeError(f"Media file not physically found at path: {local_source}")
        else:
            set_job(job_id, status="Downloading media…", pct=10.0)
            tmp_path = download_to_temp(url)

        source_for_whisper = local_source or tmp_path

        if local_source and start_seconds == 0:
            set_job(job_id, status="Checking for native subtitles…", pct=15.0)
            base_path = os.path.splitext(local_source)[0]
            possible_subs = [
                f"{base_path}.en.vtt", f"{base_path}.en-US.vtt", f"{base_path}.vtt",
                f"{base_path}.en.srt", f"{base_path}.en-US.srt", f"{base_path}.srt"
            ]
            for sub_file in possible_subs:
                if os.path.exists(sub_file):
                    print(f"[transcribe] Native subtitle file found: {sub_file}. Converting instantly...")
                    set_job(job_id, status="Parsing native subtitles…", pct=60.0)
                    parsed_segments = parse_vtt_or_srt(sub_file)
                    if parsed_segments:
                        
                        result_payload = {
                            "segments": parsed_segments,
                            "duration": parsed_segments[-1]["end"] if parsed_segments else 0.0,
                            "language": "en"
                        }
                        
                        ts_path = f"{base_path}.transcript.json"
                        with open(ts_path, "w", encoding="utf-8") as f:
                            json.dump(result_payload, f, ensure_ascii=False, indent=2)
                        
                        set_job(job_id, status="Complete", pct=100.0, result=result_payload)
                        return

        if start_seconds > 0:
            set_job(job_id, status="Slicing audio…", pct=20.0)
            fd, slice_path = tempfile.mkstemp(suffix=".wav")
            os.close(fd)
            extract = subprocess.run(
                [
                    find_ffmpeg(), "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
                    "-ss", str(start_seconds), "-i", source_for_whisper,
                    "-vn", "-ar", "16000", "-ac", "1", "-f", "wav", slice_path,
                ],
                capture_output=True, text=True, timeout=120,
            )
            if extract.returncode != 0 or os.path.getsize(slice_path) < 1024:
                set_job(job_id, status="Complete", pct=100.0, result={"segments": [], "duration": 0.0, "language": language or ""})
                return
            source_for_whisper = slice_path
        else:
            set_job(job_id, status="Extracting audio track…", pct=20.0)
            audio_path = extract_audio_wav(source_for_whisper)
            source_for_whisper = audio_path

        set_job(job_id, status="Loading AI model…", pct=25.0)
        model = get_model()

        print(f"[transcribe] Starting transcription for {source_for_whisper}...")
        set_job(job_id, status="Transcribing…", pct=30.0)
        
        segments_iter, info = model.transcribe(
            source_for_whisper,
            beam_size=BEAM_SIZE,
            vad_filter=VAD_FILTER,
            language=language,
            condition_on_previous_text=False,
        )
        
        segments = []
        duration = float(getattr(info, "duration", 0.0) or 0.0)

        for s in segments_iter:
            seg_text = (s.text or "").strip()
            if seg_text:
                segments.append({
                    "start": float(s.start) + start_seconds,
                    "end": float(s.end) + start_seconds,
                    "text": seg_text,
                })
            
            if duration > 0:
                progress_ratio = min(1.0, float(s.end) / duration)
                current_pct = 30.0 + (progress_ratio * 59.0)  # Leaves last 10% for tagging
                set_job(job_id, pct=round(current_pct, 1), detail=f"Transcribing {int(progress_ratio * 100)}%")
        
        if not segments and start_seconds == 0:
            raise RuntimeError("no speech detected")
        
        print(f"[transcribe] Successfully transcribed {source_for_whisper}")
        
        result_payload = {
            "segments": segments,
            "duration": duration,
            "language": getattr(info, "language", language) or "",
        }
        
        if local_source:
            base_name = os.path.splitext(local_source)[0]
            ts_path = f"{base_name}.transcript.json"
            with open(ts_path, "w", encoding="utf-8") as f:
                json.dump(result_payload, f, ensure_ascii=False, indent=2)
                
            # TAGGING INTEGRATION
            try:
                set_job(job_id, status="Extracting tags…", pct=90.0)
                full_text = " ".join(seg["text"] for seg in segments)
                tags = extract_tags(full_text, [])
                with open(f"{base_name}.tags.json", "w", encoding="utf-8") as f:
                    json.dump({"tags": tags}, f, ensure_ascii=False, indent=2)
                result_payload["tags"] = tags
            except Exception as e:
                print(f"Tagging failed: {e}")
                
        set_job(job_id, status="Complete", pct=100.0, detail="Done", result=result_payload)
        
    except Exception as exc: 
        print(f"[transcribe ERROR] Failed to transcribe {rel or url}: {exc}")
        set_job(job_id, status="Error", error=str(exc), pct=None)
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
        if slice_path and os.path.exists(slice_path):
            try:
                os.remove(slice_path)
            except OSError:
                pass
        if audio_path and os.path.exists(audio_path):
            try:
                os.remove(audio_path)
            except OSError:
                pass


# --------------------------------------------------------------------------- #
# Summaries
# --------------------------------------------------------------------------- #
USE_ABSTRACTIVE = os.environ.get("ABSTRACTIVE_SUMMARIES", "").lower() in ("1", "true", "yes")
SUMMARY_MODEL = os.environ.get("SUMMARY_MODEL", "sshleifer/distilbart-cnn-12-6")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "all-MiniLM-L6-v2")
MAX_INPUT_CHARS = 3500
MIN_INPUT_WORDS = 25
SUMMARY_MAX_TOKENS = int(os.environ.get("SUMMARY_MAX_TOKENS", "40"))
SUMMARY_MIN_TOKENS = 8

HEADLINE_MIN_WORDS = 7
HEADLINE_MAX_WORDS = 38

_FILLER_STARTS = (
    "good morning", "good afternoon", "good evening", "thank you", "thanks",
    "welcome", "hello", "hi ", "okay", "all right", "alright",
    "yes ", "no ", "sure ", "please ", "excuse me",
)

_WEAK_STARTS = (
    "and ", "but ", "so ", "or ", "then ", "then,", "also ", "plus ",
    "that means", "that is", "that's", "this is", "it is", "it's",
    "i mean", "you know", "well ", "right ", "now ", "because ",
    "which ", "who ", "there's", "there is", "there are",
)

IDEAL_WORDS = 18

_embedder = None
_embedder_failed = False
_embed_lock = threading.Lock()

_sum_tokenizer = None
_sum_model = None
_torch = None
_sum_failed = False
_sum_lock = threading.Lock()


def summarizer_available() -> bool:
    if USE_ABSTRACTIVE:
        return _importable("torch") and _importable("transformers")
    return _importable("sentence_transformers")


def load_summarizer() -> bool:
    global _sum_tokenizer, _sum_model, _torch, _sum_failed
    if _sum_model is not None:
        return True
    if _sum_failed:
        return False
    with _sum_lock:
        if _sum_model is not None:
            return True
        if _sum_failed:
            return False
        try:
            import torch
            from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

            _torch = torch
            torch.set_num_threads(max(1, (torch.get_num_threads() or 2) // 2))
            print(f"Loading summariser {SUMMARY_MODEL} (first run downloads ~1.2GB)…")
            _sum_tokenizer = AutoTokenizer.from_pretrained(SUMMARY_MODEL)
            _sum_model = AutoModelForSeq2SeqLM.from_pretrained(SUMMARY_MODEL)
            if getattr(_sum_model.generation_config, "forced_bos_token_id", None) is None:
                _sum_model.generation_config.forced_bos_token_id = 0
            _sum_model.eval()
            print("Summariser ready.")
            return True
        except Exception as exc:
            _sum_failed = True
            print(f"Summariser unavailable: {exc}")
            return False


def _clean_for_summary(text: str) -> str:
    text = re.sub(r"\b(?:uh|um|er|ah)\b[,.]?\s*", "", text, flags=re.IGNORECASE)
    return re.sub(r"\s+", " ", text).strip()


_ABBREVIATIONS = {
    "mr", "mrs", "ms", "dr", "prof", "sen", "rep", "gov", "gen", "lt", "sgt",
    "col", "capt", "st", "jr", "sr", "vs", "etc", "inc", "ltd", "co", "corp",
    "no", "fig", "approx", "dept", "univ", "asst", "atty", "supt", "hon",
}


def _first_sentence(text: str) -> str:
    for match in re.finditer(r"[.!?]", text):
        end = match.end()
        head = text[:end]
        if re.search(r"(?:\b[A-Za-z]\.){1,}$", head):
            continue
        word = re.search(r"([A-Za-z]+)\.$", head)
        if word and word.group(1).lower() in _ABBREVIATIONS:
            continue
        rest = text[end:].lstrip()
        if rest and not (rest[0].isupper() or rest[0] in "\"'“‘"):
            continue
        return head.strip()
    return text.strip()


def _polish(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\s+([.,;:!?])", r"\1", text)

    first = _first_sentence(text)
    if first and first[-1] in ".!?" and len(first.split()) >= 5:
        text = first
    elif text and text[-1] not in ".!?":
        cut = max(text.rfind("."), text.rfind("!"), text.rfind("?"))
        if cut >= len(text) * 0.6:
            text = text[: cut + 1]
        else:
            text = text.rstrip(" ,;:-") + "…"

    if text and text[0].islower():
        text = text[0].upper() + text[1:]
    return text


def load_embedder():
    global _embedder, _embedder_failed
    if _embedder is not None or _embedder_failed:
        return _embedder
    with _embed_lock:
        if _embedder is not None or _embedder_failed:
            return _embedder
        try:
            from sentence_transformers import SentenceTransformer
            print(f"Loading sentence embedder {EMBED_MODEL}…")
            _embedder = SentenceTransformer(EMBED_MODEL)
            print("Headline selector ready.")
        except Exception as exc:
            _embedder_failed = True
            print(f"Headline selector unavailable: {exc}")
    return _embedder


def _split_sentences(text: str) -> list[str]:
    text = re.sub(r"\s+", " ", text or "").strip()
    if not text:
        return []
    nlp = load_spacy()
    if nlp is not None:
        try:
            doc = nlp(text[:100_000])
            out = [s.text.strip() for s in doc.sents if s.text.strip()]
            if out:
                return out
        except Exception:
            pass
    out: list[str] = []
    start = 0
    for match in re.finditer(r"[.!?]", text):
        end = match.end()
        head = text[start:end]
        if re.search(r"(?:\b[A-Za-z]\.){1,}$", head):
            continue
        word = re.search(r"([A-Za-z]+)\.$", head)
        if word and word.group(1).lower() in _ABBREVIATIONS:
            continue
        rest = text[end:].lstrip()
        if rest and not (rest[0].isupper() or rest[0] in "\"'“‘"):
            continue
        out.append(head.strip())
        start = end
    tail = text[start:].strip()
    if tail:
        out.append(tail)
    return out


def _is_filler(sentence: str) -> bool:
    low = sentence.lower().lstrip("\"'“‘ ")
    return any(low.startswith(f) for f in _FILLER_STARTS)


def extractive_headline(text: str) -> str | None:
    sentences = [s for s in _split_sentences(text)]
    candidates = [
        s for s in sentences
        if HEADLINE_MIN_WORDS <= len(s.split()) <= HEADLINE_MAX_WORDS
    ]
    if not candidates:
        longest = max(sentences, key=lambda s: len(s.split()), default="")
        words = longest.split()
        if len(words) < 4:
            return None
        return _polish(" ".join(words[:HEADLINE_MAX_WORDS]))

    model = load_embedder()
    if model is None:
        for s in candidates:
            if not _is_filler(s):
                return _polish(s)
        return _polish(candidates[0])

    try:
        import numpy as np

        vectors = model.encode(candidates, normalize_embeddings=True)
        centroid = np.mean(vectors, axis=0)
        norm = np.linalg.norm(centroid)
        if norm > 0:
            centroid = centroid / norm
        scores = vectors @ centroid

        best_i, best_score = 0, -1e9
        for i, s in enumerate(candidates):
            low = s.lower().lstrip("\"'“‘ ")
            words = len(s.split())

            score = float(scores[i])
            if _is_filler(s):
                score -= 0.30
            if low.startswith(_WEAK_STARTS):
                score -= 0.18
            pronouns = sum(1 for w in low.split() if w.strip(".,;:") in
                           {"it", "he", "she", "they", "this", "that", "them", "we", "i"})
            if words and pronouns / words > 0.22:
                score -= 0.12
            score += 0.14 * (1 - min(1.0, abs(words - IDEAL_WORDS) / IDEAL_WORDS))
            score += max(0.0, 0.06 * (1 - i / max(1, len(candidates) - 1)))

            if score > best_score:
                best_i, best_score = i, score
        return _polish(candidates[best_i])
    except Exception as exc:
        print(f"headline selection failed: {exc}")
        return _polish(candidates[0])


def summarize_one(text: str) -> str | None:
    cleaned = _clean_for_summary(text)
    if len(cleaned.split()) < MIN_INPUT_WORDS:
        return None
    if not USE_ABSTRACTIVE:
        return extractive_headline(cleaned)
    if not load_summarizer():
        return extractive_headline(cleaned)
    try:
        inputs = _sum_tokenizer(
            cleaned[:MAX_INPUT_CHARS], max_length=1024, truncation=True, return_tensors="pt",
        )
        with _torch.inference_mode():
            ids = _sum_model.generate(
                **inputs,
                max_length=SUMMARY_MAX_TOKENS,
                min_length=SUMMARY_MIN_TOKENS,
                do_sample=False,
                num_beams=4,
                no_repeat_ngram_size=3,
                length_penalty=1.0,
            )
        return _polish(_sum_tokenizer.decode(ids[0], skip_special_tokens=True)) or None
    except Exception as exc:
        print(f"summarisation failed: {exc}")
        return None


def run_summarize(job_id: str, texts: list[str]) -> None:
    out: list[str | None] = []
    try:
        if not summarizer_available():
            set_job(job_id, status="Error", pct=None,
                    error="summariser libraries not installed (pip install -r requirements.txt)")
            return
        set_job(job_id, status="Loading model…", pct=0.0)
        for i, text in enumerate(texts):
            set_job(job_id, status=f"Writing summary {i + 1}/{len(texts)}…",
                    pct=(i / max(1, len(texts))) * 100.0)
            out.append(summarize_one(text or ""))
        set_job(job_id, status="Complete", pct=100.0, result={"summaries": out})
    except Exception as exc:
        set_job(job_id, status="Error", error=str(exc), pct=None)


# --------------------------------------------------------------------------- #
# Smart tags
# --------------------------------------------------------------------------- #
SPACY_MODEL = "en_core_web_sm"
KEYBERT_MODEL = "all-MiniLM-L6-v2"
MAX_TAGS = 14
ENTITY_LABELS = {"PERSON", "ORG", "GPE", "LOC", "NORP", "EVENT", "LAW", "FAC", "PRODUCT"}
ENTITY_GROUP = {
    "PERSON": "people",
    "ORG": "organizations",
    "NORP": "organizations",
    "GPE": "places",
    "LOC": "places",
    "FAC": "places",
    "EVENT": "events",
    "LAW": "policy",
    "PRODUCT": "topics",
}
_CHUNK_STOP = {
    "i", "me", "my", "we", "us", "our", "you", "your", "he", "him", "his", "she",
    "her", "it", "its", "they", "them", "their", "this", "that", "these", "those",
    "who", "what", "which", "there", "here", "one", "ones", "thing", "things",
    "lot", "lots", "kind", "sort", "way", "ways", "something", "anything",
    "everything", "nothing", "someone", "anyone", "everyone", "people", "time",
    "times", "year", "years", "day", "days", "today", "tomorrow", "yesterday",
}

_DURATION_RE = re.compile(
    r"(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|many|few)\s+"
    r"(?:second|minute|hour|day|week|month|year|decade)s?",
)

_nlp = None
_nlp_failed = False
_kw_model = None
_kw_failed = False
_tag_lock = threading.Lock()


def load_spacy():
    global _nlp, _nlp_failed
    if _nlp is not None or _nlp_failed:
        return _nlp
    with _tag_lock:
        if _nlp is not None or _nlp_failed:
            return _nlp
        try:
            import spacy
            try:
                _nlp = spacy.load(SPACY_MODEL)
            except OSError:
                print(f"Downloading spaCy model {SPACY_MODEL} (~15MB)…")
                from spacy.cli import download as spacy_download
                spacy_download(SPACY_MODEL)
                _nlp = spacy.load(SPACY_MODEL)
            print("Entity tagger ready.")
        except Exception as exc:
            _nlp_failed = True
            print(f"Entity tagger unavailable: {exc}")
    return _nlp


def load_keybert():
    global _kw_model, _kw_failed
    if _kw_model is not None or _kw_failed:
        return _kw_model
    with _tag_lock:
        if _kw_model is not None or _kw_failed:
            return _kw_model
        try:
            from keybert import KeyBERT
            print(f"Loading keyphrase model {KEYBERT_MODEL} (first run downloads ~90MB)…")
            _kw_model = KeyBERT(model=KEYBERT_MODEL)
            print("Keyphrase tagger ready.")
        except Exception as exc:
            _kw_failed = True
            print(f"Keyphrase tagger unavailable: {exc}")
    return _kw_model


def _tidy_entity(text: str) -> str:
    t = re.sub(r"\s+", " ", (text or "").strip())
    t = re.sub(r"['']s$", "", t)
    t = re.sub(r"^(the|a|an)\s+", "", t, flags=re.IGNORECASE)
    t = t.strip(" ,-—\n\t")
    if re.fullmatch(r"(?:[A-Za-z]\.){2,}", t):
        return t
    if re.fullmatch(r"(?:[A-Za-z]\.)+[A-Za-z]", t):
        return t + "."
    return t.rstrip(".")


def _subsumed(label: str, others: list[str]) -> bool:
    words = set(label.lower().split())
    if not words:
        return True
    for other in others:
        ow = set(other.lower().split())
        if words < ow:
            return True
    return False


def extract_tags(text: str, extra: list[str] | None = None) -> list[dict[str, Any]]:
    text = (text or "").strip()
    entities: list[str] = []
    topics: list[str] = []
    entity_kinds: dict[str, str] = {}

    noun_chunks: list[str] = []
    if text:
        nlp = load_spacy()
        if nlp is not None:
            try:
                doc = nlp(text[:400_000])

                counts: dict[str, int] = {}
                for ent in doc.ents:
                    if ent.label_ not in ENTITY_LABELS:
                        continue
                    name = _tidy_entity(ent.text)
                    if name and 2 < len(name) <= 40:
                        counts[name] = counts.get(name, 0) + 1
                        entity_kinds.setdefault(name, ENTITY_GROUP.get(ent.label_, "topics"))
                ordered = [n for n, _ in sorted(counts.items(), key=lambda kv: (-kv[1], -len(kv[0])))]
                entities = [n for n in ordered if not _subsumed(n, ordered)]

                chunk_counts: dict[str, int] = {}
                for nc in doc.noun_chunks:
                    p = _tidy_entity(nc.text.lower())
                    words = p.split()
                    if not (2 < len(p) <= 40) or not words:
                        continue
                    if all(w in _CHUNK_STOP for w in words):
                        continue
                    if _DURATION_RE.fullmatch(p):
                        continue
                    chunk_counts[p] = chunk_counts.get(p, 0) + 1
                ranked_chunks = sorted(chunk_counts.items(), key=lambda kv: (-kv[1], -len(kv[0])))
                multi = [c for c, _ in ranked_chunks if 2 <= len(c.split()) <= 4]
                single = [c for c, n in ranked_chunks if len(c.split()) == 1 and n > 2]
                noun_chunks = (multi if len(multi) >= 8 else multi + single)[:400]
            except Exception as exc:
                print(f"entity extraction failed: {exc}")

        kw = load_keybert()
        if kw is not None:
            try:
                common = {"top_n": 12, "use_mmr": True, "diversity": 0.6}
                if noun_chunks:
                    pairs = kw.extract_keywords(
                        text[:20_000], candidates=noun_chunks,
                        keyphrase_ngram_range=(1, 4), **common,
                    )
                else:
                    pairs = kw.extract_keywords(
                        text[:20_000], keyphrase_ngram_range=(1, 3), stop_words="english", **common,
                    )
                for phrase, _score in pairs:
                    p = _tidy_entity(phrase)
                    if p and 2 < len(p) <= 40 and not _subsumed(p, topics):
                        topics.append(p)
            except Exception as exc:
                print(f"keyphrase extraction failed: {exc}")

    tags: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(label: str, kind: str) -> bool:
        key = label.lower()
        if not label or key in seen:
            return False
        seen.add(key)
        tags.append({"label": label, "kind": kind})
        return True

    for label in extra or []:
        tidy = _tidy_entity(label)
        if tidy:
            add(tidy, "source")

    entity_quota = max(1, int((MAX_TAGS - len(tags)) * 0.6))
    topic_quota = MAX_TAGS - len(tags) - entity_quota

    kept_e = [e for e in entities if not _subsumed(e, [t["label"] for t in tags])][:entity_quota]
    for e in kept_e:
        add(e, entity_kinds.get(e, "topics"))
    kept_t = [t for t in topics if not _subsumed(t, [x["label"] for x in tags])][:topic_quota]
    for t in kept_t:
        add(t, "topics")

    if len(tags) < MAX_TAGS:
        for pool, default_kind in ((entities, None), (topics, "topics")):
            for label in pool:
                if len(tags) >= MAX_TAGS:
                    break
                if _subsumed(label, [x["label"] for x in tags]):
                    continue
                add(label, default_kind or entity_kinds.get(label, "topics"))

    return tags[:MAX_TAGS]


def run_export(job_id: str, args: list[str], rel_path: str, title: str) -> None:
    workdir = tempfile.mkdtemp(prefix="basiq_export_")
    out_path = str(Path(workdir) / "clip.mp4")
    try:
        source = str(safe_media_path(rel_path))
        if not os.path.isfile(source):
            raise RuntimeError(f"not on the shared drive: {rel_path}")

        final_args = [find_ffmpeg()] + [
            source if a == "%INPUT%" else out_path if a == "%OUTPUT%" else a
            for a in args
        ]
        set_job(job_id, status="Encoding…", pct=10.0)
        proc = subprocess.run(final_args, capture_output=True, text=True, timeout=1800)
        if proc.returncode != 0 or not os.path.isfile(out_path) or os.path.getsize(out_path) == 0:
            tail = "\n".join((proc.stderr or "").strip().splitlines()[-6:])
            raise RuntimeError(f"ffmpeg export failed: {tail or proc.returncode}")

        size = os.path.getsize(out_path)
        set_job(job_id, status="Filing to the shared drive…", pct=90.0)
        local_path = store_in_media_root(Path(out_path), job_id, subdir="clips")
        
        meta_dest = MEDIA_ROOT / "clips" / f"{job_id}.meta.json"
        meta_dest.parent.mkdir(parents=True, exist_ok=True)
        with open(meta_dest, "w", encoding="utf-8") as f:
            json.dump({"title": title}, f, ensure_ascii=False)
            
        set_job(job_id, status="Complete", pct=100.0, result={"sizeBytes": size, "localPath": local_path})
    except Exception as exc:
        set_job(job_id, status="Error", error=str(exc), pct=None)
    finally:
        for p in Path(workdir).glob("*"):
            try:
                p.unlink()
            except OSError:
                pass
        try:
            os.rmdir(workdir)
        except OSError:
            pass


def run_tagging(job_id: str, rel_path: str, raw_text: str, extra: list[str]) -> None:
    try:
        set_job(job_id, status="Reading transcript…", pct=10.0)
        
        full_text = raw_text
        base_name = ""
        
        if rel_path:
            clean_rel = sanitize_media_path(rel_path)
            local_source = str(safe_media_path(clean_rel))
            base_name = os.path.splitext(local_source)[0]
            transcript_path = f"{base_name}.transcript.json"
            if os.path.exists(transcript_path):
                with open(transcript_path, "r", encoding="utf-8") as f:
                    ts_data = json.load(f)
                full_text = " ".join(seg["text"] for seg in ts_data.get("segments", []))
        
        if not full_text:
            raise RuntimeError("No text or transcript found to tag.")
            
        set_job(job_id, status="Extracting tags…", pct=50.0)
        tags = extract_tags(full_text, extra)
        
        if base_name:
            with open(f"{base_name}.tags.json", "w", encoding="utf-8") as f:
                json.dump({"tags": tags}, f, ensure_ascii=False, indent=2)
                
        set_job(job_id, status="Complete", pct=100.0, result={"tags": tags})
    except Exception as exc:
        set_job(job_id, status="Error", error=str(exc), pct=None)


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", "*"))
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", 0) or 0)
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return {}

    def _check_auth(self) -> bool:
        if not AUTH_TOKEN:
            return True
        auth_header = self.headers.get("Authorization", "")
        if auth_header == f"Bearer {AUTH_TOKEN}":
            return True
        if self.path.startswith("/media/"):
            query = urllib.parse.urlsplit(self.path).query
            if urllib.parse.parse_qs(query).get("token", [None])[0] == AUTH_TOKEN:
                return True
        self._json(401, {"error": "unauthorized"})
        return False

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _serve_media(self, rel: str, download: bool = False) -> None:
        try:
            clean_rel = sanitize_media_path(rel)
            path = safe_media_path(clean_rel)
        except ValueError:
            self._json(403, {"error": "forbidden"})
            return
        if not path.is_file():
            self._json(404, {"error": "not found"})
            return

        size = path.stat().st_size
        ctype = {
            ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
            ".mkv": "video/x-matroska", ".webm": "video/webm", ".ts": "video/mp2t",
            ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav",
        }.get(path.suffix.lower(), "application/octet-stream")

        start, end = 0, size - 1
        is_range = False
        header = self.headers.get("Range", "")
        match = re.match(r"bytes=(\d*)-(\d*)", header or "")
        if match:
            raw_start, raw_end = match.group(1), match.group(2)
            if raw_start:
                start = int(raw_start)
                if raw_end:
                    end = min(int(raw_end), size - 1)
            elif raw_end:
                start = max(0, size - int(raw_end))
            is_range = True
            if start >= size:
                self.send_response(416)
                self._cors()
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return

        length = end - start + 1
        self.send_response(206 if is_range else 200)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if is_range:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        if download:
            self.send_header("Content-Disposition", f'attachment; filename="{path.name}"')
        self.end_headers()

        try:
            with open(path, "rb") as fh:
                fh.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = fh.read(min(256 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self) -> None:
        if not self._check_auth():
            return
        if self.path.startswith("/media/"):
            tail = self.path[len("/media/"):]
            rel, _, query = tail.partition("?")
            download = urllib.parse.parse_qs(query).get("download", ["0"])[0] not in ("0", "", "false")
            self._serve_media(rel, download=download)
            return

        if self.path.startswith("/library"):
            force = "?force=1" in self.path or "&force=1" in self.path
            self._json(200, {
                "root": str(MEDIA_ROOT),
                "exists": MEDIA_ROOT.is_dir(),
                "files": get_library_files(force=force),
            })
            return

        if self.path == "/health":
            self._json(200, {
                "status": "ok",
                "model": MODEL_NAME,
                "device": DEVICE,
                "compute_type": COMPUTE_TYPE,
                "whisper": WhisperModel is not None,
                "ytdlp": yt_dlp is not None,
                "summarizer": summarizer_available(),
                "tagger": _importable("spacy") or _importable("keybert"),
            })
            return

        if self.path == "/logs":
            self._json(200, {"status": "ok", "logs": list(LOG_BUFFER)})
            return

        if match := re.fullmatch(r"/jobs/([0-9a-f]{32})", self.path):
            job = get_job(match.group(1))
            self._json(200 if job else 404, job or {"error": "unknown job"})
            return

        tail, _, query = self.path.partition("?")
        if tail == "/worker/jobs":
            kinds = set(urllib.parse.parse_qs(query).get("kind", [""])[0].split(","))
            self._json(200, {"jobs": list_worker_jobs(kinds)})
            return

        if match := re.fullmatch(r"/worker/jobs/([0-9a-f]{32})/stop-requested", self.path):
            if get_job(match.group(1)) is None:
                self._json(404, {"error": "unknown job"})
                return
            self._json(200, {"stop": stop_requested(match.group(1))})
            return

        self._json(404, {"error": "not found"})

    def _handle_stop(self, job_id: str) -> None:
        if get_job(job_id) is None:
            self._json(404, {"error": "unknown job"})
            return
        _stop_flags.setdefault(job_id, threading.Event()).set()
        set_job(job_id, status="Stopping…")
        self._json(200, {"stopping": True})

    def do_POST(self) -> None:
        if not self._check_auth():
            return
            
        if self.path == "/upload/init":
            body = self._read_json()
            title = body.get("title") or "File Upload"
            job_id = new_job(kind="download")
            set_job(job_id, status="Uploading (0%)", detail=title, pct=0.0)
            self._json(200, {"jobId": job_id})
            return
            
        if self.path == "/probe":
            url = (self._read_json().get("url") or "").strip()
            if not url:
                self._json(400, {"error": "missing 'url'"})
                return
            self._json(200, {"is_live": probe_is_live(url)})
            return

        if self.path == "/grab":
            body = self._read_json()
            url = (body.get("url") or "").strip()
            
            # --- UPLOAD HIJACK ---
            if url.startswith("upload://"):
                job_id = url[9:]
                self._json(202, {"jobId": job_id})
                return
            # ---------------------
                
            if not url:
                self._json(400, {"error": "missing 'url'"})
                return
            quality = body.get("quality") or "HD"
            subs = bool(body.get("subs"))
            job_id = new_job(kind="grab")
            if DELEGATE_TO_WORKER:
                set_job(job_id, request={"url": url, "quality": quality, "subs": subs})
            else:
                threading.Thread(
                    target=run_grab, args=(job_id, url, quality, subs), daemon=True,
                ).start()
            self._json(202, {"jobId": job_id})
            return

        if match := re.fullmatch(r"/jobs/([0-9a-f]{32})/stop", self.path):
            self._handle_stop(match.group(1))
            return

        if match := re.fullmatch(r"/worker/jobs/([0-9a-f]{32})/claim", self.path):
            job_id = match.group(1)
            if get_job(job_id) is None:
                self._json(404, {"error": "unknown job"})
                return
            worker_id = (self._read_json().get("workerId") or "unknown").strip()
            if not claim_job(job_id, worker_id):
                self._json(409, {"error": "already claimed or not queued"})
                return
            self._json(200, {"claimed": True})
            return

        if match := re.fullmatch(r"/worker/jobs/([0-9a-f]{32})/update", self.path):
            job_id = match.group(1)
            if get_job(job_id) is None:
                self._json(404, {"error": "unknown job"})
                return
            body = self._read_json()
            set_job(job_id, **{k: v for k, v in body.items() if k in _WORKER_UPDATE_FIELDS})
            self._json(200, {"updated": True})
            return

        if self.path == "/capture":
            body = self._read_json()
            url = (body.get("url") or "").strip()
            if not url:
                self._json(400, {"error": "missing 'url'"})
                return
            title = body.get("title") or ""
            max_minutes = float(body.get("maxMinutes") or 0.0)
            job_id = new_job(kind="capture")
            _stop_flags[job_id] = threading.Event()
            if DELEGATE_TO_WORKER:
                set_job(job_id, request={"url": url, "title": title, "maxMinutes": max_minutes})
            else:
                threading.Thread(
                    target=run_live_capture, args=(job_id, url, title, max_minutes), daemon=True,
                ).start()
            self._json(202, {"jobId": job_id})
            return

        if self.path == "/summarize":
            body = self._read_json()
            texts = body.get("texts") or []
            if not isinstance(texts, list) or not texts:
                self._json(400, {"error": "missing 'texts'"})
                return
            job_id = new_job()
            threading.Thread(
                target=run_summarize, args=(job_id, [str(t) for t in texts]), daemon=True,
            ).start()
            self._json(202, {"jobId": job_id})
            return

        if self.path == "/export":
            body = self._read_json()
            args = body.get("args") or []
            rel = (body.get("localPath") or "").strip()
            title = (body.get("title") or "Clip").strip()
            if not args or not rel:
                self._json(400, {"error": "missing 'args' or 'localPath'"})
                return
            job_id = new_job()
            threading.Thread(
                target=run_export,
                args=(job_id, [str(a) for a in args], rel, title),
                daemon=True,
            ).start()
            self._json(202, {"jobId": job_id})
            return

        if self.path == "/tag":
            body = self._read_json()
            text_or_path = str(body.get("text") or "")
            path_val = (body.get("path") or body.get("local_path") or "").strip()
            
            if text_or_path.endswith((".mp4", ".mov", ".mkv", ".mp3", ".wav", ".m4a")):
                path_val = text_or_path
                text_or_path = ""
                
            extra = [str(x) for x in (body.get("extra") or [])]
            if not text_or_path and not path_val:
                self._json(400, {"error": "missing 'text' or 'path'"})
                return
            job_id = new_job()
            threading.Thread(target=run_tagging, args=(job_id, path_val, text_or_path, extra), daemon=True).start()
            self._json(202, {"jobId": job_id})
            return
            
        if self.path == "/transcribe/continue":
            body = self._read_json()
            job_id = body.get("jobId")
            rel = body.get("path")
            language = body.get("language") or DEFAULT_LANGUAGE
            threading.Thread(
                target=run_transcribe, 
                args=(job_id, "", rel, 0.0, language), 
                daemon=True
            ).start()
            self._json(202, {"jobId": job_id})
            return

        if self.path == "/transcribe":
            body = self._read_json()
            url = (body.get("url") or "").strip()
            rel = (body.get("path") or "").strip()
            start_seconds = max(0.0, float(body.get("startSeconds") or 0.0))
            if not url and not rel:
                self._json(400, {"error": "missing 'url' or 'path'"})
                return
            
            language = body.get("language") or DEFAULT_LANGUAGE
            
            # Use provided jobId if transitioning from upload, else create new
            job_id = body.get("jobId") or new_job()
            if job_id not in _jobs:
                with _jobs_lock:
                    _jobs[job_id] = {
                        "status": "Queued", "pct": 0.0, "detail": "", "result": None, "error": "",
                        "kind": "transcribe", "claimed_by": None, "claimed_at": None,
                    }

            threading.Thread(
                target=run_transcribe, 
                args=(job_id, url, rel, start_seconds, language), 
                daemon=True
            ).start()
            
            self._json(202, {"jobId": job_id})
            return

        self._json(404, {"error": "not found"})

    def log_message(self, fmt: str, *args) -> None:
        log(f"{self.address_string()} {fmt % args}")


class Server(ThreadingHTTPServer):
    def handle_error(self, request, client_address) -> None:
        exc_type = sys.exc_info()[0]
        if exc_type in (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            return
        super().handle_error(request, client_address)


def main() -> None:
    server = Server(("127.0.0.1", PORT), Handler)
    print(f"Basiq agent listening on http://127.0.0.1:{PORT}")
    print(f"  whisper: {'ready' if WhisperModel else 'NOT INSTALLED'}   "
          f"yt-dlp: {'ready' if yt_dlp else 'NOT INSTALLED'}")
    print(f"  model={MODEL_NAME} device={DEVICE} compute={COMPUTE_TYPE} beam={BEAM_SIZE} vad={VAD_FILTER}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")


if __name__ == "__main__":
    import multiprocessing
    multiprocessing.freeze_support()
    main()