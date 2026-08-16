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
    POST /transcribe       -> {segments, ...}    (synchronous)
    GET  /jobs/<id>        -> {status, pct, detail, result, error}

Download behaviour is a faithful port of DownloadTask in app/tasks.py — same
format ladder, same vertical-aware caps, same mp4 merge, same subtitle opts —
so a file grabbed here matches one grabbed by the desktop build.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Sequence
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent

# ---- Hugging Face cache setup. MUST precede every HF-backed import below. ----
#
# Two separate Windows failures, both of which abort a model download outright
# rather than degrading, and both fixed here once for every model the agent
# uses (Whisper, distilbart, MiniLM, spaCy's HF-hosted pieces):
#
#   1. hf_xet, the newer Rust download backend, fails with "Access is denied
#      (os error 5)" writing its own log under %USERPROFILE%.
#   2. huggingface_hub's default cache, %USERPROFILE%\.cache\huggingface, is
#      itself unwritable on this machine — "[WinError 5] Access is denied".
#      Whisper only ever worked because it was given an explicit download_root.
#
# Pointing every cache at a directory beside the agent sidesteps both, keeps
# all downloaded weights in one place the operator can delete, and is a no-op
# once the models are cached.
# ---- Shared media root (LucidLink, a NAS, Dropbox — any mounted folder) ----
#
# When set, masters land HERE instead of in Supabase storage. A hearing is
# hours long and hundreds of MB; the team already shares a drive, and putting
# the bytes there costs nothing and puts the file straight into the editing
# workflow. Supabase keeps the row that describes the file, so transcripts,
# tags, key moments and search all keep working unchanged — and exported
# clips still go to the bucket, because a share link has to work for someone
# with no agent and no drive access.
#
# Unset falls back to a folder beside the agent, so a solo install with no
# shared drive still works exactly as before.
MEDIA_ROOT = Path(os.environ.get("MEDIA_ROOT", "") or (HERE / "media")).expanduser()
MEDIA_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".m4v", ".ts", ".mp3", ".m4a", ".wav"}

HF_CACHE = HERE / "hf_cache"
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
CACHE_DIR = HERE / "whisper_cache"

# Mirrors app/config.py Settings defaults so a transcript matches the desktop's.
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
    """Is a package installed, without paying its import cost or triggering
    any model download? Used only to report capability on /health."""
    import importlib.util
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False

# jobId -> {status, pct, detail, result, error}
_jobs: dict[str, dict[str, Any]] = {}
_jobs_lock = threading.Lock()
# jobId -> Event. Set by POST /jobs/<id>/stop. Only live captures have one:
# stopping a capture is how it succeeds, so this is a separate concept from
# cancelling, which no job here supports.
_stop_flags: dict[str, threading.Event] = {}


# --------------------------------------------------------------------------- #
# Whisper
# --------------------------------------------------------------------------- #
def get_model():
    """Load once, reuse forever — init costs seconds and hundreds of MB."""
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
    """Pull a signed storage URL down locally. Transcription must decode the
    ENTIRE audio track, so unlike the crop/export paths there is no way to
    Range-request only part of it."""
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
def new_job() -> str:
    job_id = uuid.uuid4().hex
    with _jobs_lock:
        _jobs[job_id] = {"status": "Queued", "pct": 0.0, "detail": "", "result": None, "error": ""}
    return job_id


def set_job(job_id: str, **fields: Any) -> None:
    with _jobs_lock:
        if job_id in _jobs:
            _jobs[job_id].update(fields)


def get_job(job_id: str) -> dict[str, Any] | None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        return dict(job) if job else None


# --------------------------------------------------------------------------- #
# Download — port of DownloadTask (app/tasks.py:160-300)
# --------------------------------------------------------------------------- #
def format_string(quality: str, is_vertical: bool) -> str:
    """Verbatim port of DownloadTask._format_string. The vertical-aware caps
    matter: a 1080-tall cap on a portrait video would fetch a much smaller
    frame than intended, so the axis flips with orientation."""
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
        # Not optional in practice: YouTube's default web client returns
        # "HTTP Error 403: Forbidden" on the actual media fetch even when
        # format resolution succeeds — confirmed live against this exact
        # build. The android client still serves those URLs. Verified by
        # downloading a real video before this line was added.
        "extractor_args": {"youtube": {"player_client": ["android", "web"]}},
    }
    # Same escape hatch as Settings.cookies_from_browser in the desktop app
    # ("", "firefox", "chrome", "edge", "brave"). Needed for age-gated or
    # members-only sources; a wrong/absent browser raises inside yt-dlp, so
    # it stays opt-in rather than a default.
    if browser := os.environ.get("COOKIES_FROM_BROWSER", "").strip():
        opts["cookiesfrombrowser"] = (browser,)
    return opts


class _NullLogger:
    def debug(self, msg): pass
    def info(self, msg): pass
    def warning(self, msg): pass
    def error(self, msg): pass


def probe_is_live(url: str) -> bool:
    """Best-effort liveness check — the second tier of ingest_bar's scheme.
    Only yt-dlp knows whether an ambiguous watch page is live right now."""
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
    """Shared naming rule for both store_in_media_root and reserve_media_path:
    sanitise the title, then de-duplicate with a " (2)" suffix so two grabs of
    the same hearing don't overwrite each other. Does not touch the
    filesystem beyond the directory itself, so callers decide how the file
    at the returned path comes into existence."""
    root = (MEDIA_ROOT / subdir) if subdir else MEDIA_ROOT
    root.mkdir(parents=True, exist_ok=True)
    clean = _ILLEGAL_NAME.sub(" ", title or "").strip()
    clean = re.sub(r"\s+", " ", clean)[:120] or "Untitled"
    dest = root / f"{clean}{suffix}"
    counter = 2
    while dest.exists():
        dest = root / f"{clean} ({counter}){suffix}"
        counter += 1
    return dest


def store_in_media_root(src: Path, title: str, subdir: str = "") -> str:
    """Move a finished download/export onto the shared drive.

    Returns the path RELATIVE to MEDIA_ROOT, which is what the library row
    stores — an absolute path would be wrong on every other machine, since
    the same LucidLink volume mounts at a different letter or mount point per
    operator. `subdir` files clip renders under MEDIA_ROOT/clips instead of
    cluttering the top level with hundreds of short exports.
    """
    dest = _free_media_path(title, src.suffix, subdir)
    # Same-volume rename where possible; copy+delete across volumes, which is
    # the normal case when temp is on C: and the drive is mounted elsewhere.
    shutil.move(str(src), str(dest))
    return dest.relative_to(MEDIA_ROOT).as_posix()


def reserve_media_path(title: str, suffix: str, subdir: str = "") -> Path:
    """Pick a free path under MEDIA_ROOT for a file that does not exist yet —
    same naming rule as store_in_media_root, but for a destination FFmpeg
    will create and write to directly (a live capture), rather than a
    finished file being moved in afterwards. Touching an empty placeholder
    immediately closes the race between choosing the name and FFmpeg opening
    it, so a second reservation started a moment later can't pick the same
    name.
    """
    dest = _free_media_path(title, suffix, subdir)
    dest.touch()
    return dest


# Grabbing several URLs in quick succession gets throttled — the extractor
# starts refusing, and the same URL works fine a minute later. That is a wait,
# not a failure, so the job waits instead of reporting an error the operator
# has to notice and redo by hand.
RETRY_DELAYS = (60, 300)  # 1 minute, then 5 minutes


def _retryable(message: str) -> bool:
    """Is this the kind of failure that a wait actually fixes?

    Deliberately narrow. A private video or a dead link fails identically no
    matter how long we wait, and retrying those for six minutes before saying
    so is worse than failing immediately.
    """
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
    """Count the wait down in the queue so it reads as progress, not a hang."""
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
    """One download attempt. Raises on failure so run_grab can decide whether
    a wait would help."""
    workdir = tempfile.mkdtemp(prefix="basiq_grab_")
    try:
        suffix = f"  ·  attempt {attempt + 1} of {total_attempts}" if attempt else ""
        set_job(job_id, status=f"Resolving source…{suffix}", pct=0.0)

        # Probe first for the title and orientation, exactly as DownloadTask
        # does — orientation feeds the format ladder's cap.
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
            "outtmpl": str(Path(workdir) / "%(title).120B.%(ext)s"),
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
        local_path = store_in_media_root(media_file, title)
        # store_in_media_root() moves media_file out of workdir — its path
        # (and stat()) is stale from here on.

        set_job(job_id, status="Complete", pct=100.0, result={
            "title": title,
            "sizeBytes": size_bytes,
            "ext": media_file.suffix.lstrip("."),
            "uploader": (result.get("uploader") or result.get("channel") or "") if result else "",
            "uploadDate": (result.get("upload_date") or "") if result else "",
            "sourceUrl": url,
            "localPath": local_path,
        })
    # Deliberately no except here: run_grab owns failure, because only it can
    # tell a rate-limit (wait and retry) from a dead link (report it now).
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
# Live capture — port of app/livecapture.py
#
# Three decisions from that module carry over verbatim, because each one was
# paid for in lost recordings:
#
#   1. Record MPEG-TS, remux to MP4 afterwards. MP4 keeps its index at the END
#      of the file, so an MP4 that was never closed cleanly is not a partial
#      video, it is an unplayable one. TS carries timing inline: every byte
#      already written stays playable no matter how the process dies.
#   2. Stop is not cancel. Stopping a capture is how it SUCCEEDS. FFmpeg exits
#      cleanly when it reads 'q' on stdin, which is why the capture command
#      must NOT pass -nostdin (the remux command does).
#   3. -flush_packets 1. Without it FFmpeg buffers writes and a hard kill loses
#      everything buffered — measured as a zero-byte file in the desktop app's
#      own tests before the flag was added.
# --------------------------------------------------------------------------- #
MANIFEST_EXTS = (".m3u8", ".mpd", ".f4m", ".ism")
STREAM_SCHEMES = ("rtmp", "rtmps", "rtmpe", "rtsp", "srt", "udp", "rtp", "tcp")
_LISTEN_HOSTS = {"0.0.0.0", "127.0.0.1", "localhost", "::", "[::]"}

KIND_MANIFEST = "manifest"   # direct .m3u8/.mpd — hand straight to FFmpeg
KIND_PROTOCOL = "protocol"   # rtmp/srt/... — hand straight to FFmpeg
KIND_LISTENER = "listener"   # we are the server; OBS connects to us
KIND_PAGE = "page"           # a watch page — yt-dlp has to find the stream


# --------------------------------------------------------------------------- #
# Shared media library
# --------------------------------------------------------------------------- #
def safe_media_path(rel: str) -> Path:
    """Resolve a client-supplied relative path INSIDE the media root.

    The agent listens on localhost, but a browser tab on any site can still
    reach it, so a traversal here would hand out arbitrary files from the
    operator's disk. Resolving and then re-checking containment is the only
    reliable guard — string prefix checks miss symlinks and "..\\" on Windows.
    """
    root = MEDIA_ROOT.resolve()
    target = (root / rel.lstrip("/\\")).resolve()
    if target != root and root not in target.parents:
        raise ValueError("path escapes the media root")
    return target


def probe_media(path: Path) -> dict[str, Any]:
    """ffprobe one file. Returns {} rather than raising — a folder of mixed
    media should not fail to list because one file is unreadable."""
    exe = shutil.which("ffprobe")
    if not exe:
        cand = HERE.parent / "node_modules" / "ffprobe-static" / "bin" / "win32" / "x64" / "ffprobe.exe"
        exe = str(cand) if cand.is_file() else None
    if not exe:
        return {}
    try:
        out = subprocess.run(
            [exe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
            capture_output=True, text=True, timeout=60,
        )
        if out.returncode != 0:
            return {}
        info = json.loads(out.stdout or "{}")
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


# Probing every file on every scan would re-read a whole shared drive; keyed
# on (path, size, mtime) so an edited file re-probes and an untouched one
# doesn't.
_probe_cache: dict[tuple[str, int, int], dict[str, Any]] = {}


def scan_media() -> list[dict[str, Any]]:
    """Every media file under MEDIA_ROOT, with probe data.

    This is what makes the library SHARED: each teammate's agent points at the
    same mounted folder and therefore reports the same files.
    """
    root = MEDIA_ROOT
    if not root.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*")):
        try:
            if not path.is_file() or path.suffix.lower() not in MEDIA_EXTS:
                continue
            # ".part" marks a capture still being written — the desktop app's
            # scan_dir skips these for the same reason.
            if ".part" in path.name:
                continue
            stat = path.stat()
            rel = path.relative_to(root).as_posix()
            key = (rel, stat.st_size, int(stat.st_mtime))
            info = _probe_cache.get(key)
            if info is None:
                info = probe_media(path)
                _probe_cache[key] = info
            out.append({
                "path": rel,
                "name": path.stem,
                "sizeBytes": stat.st_size,
                "modified": int(stat.st_mtime),
                **info,
            })
        except OSError:
            continue
    return out


def find_ffmpeg() -> str:
    """PATH first, then the ffmpeg-static binary the web app already depends on
    — no reason to make the operator install a second copy."""
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
    """(kind, url) with no network access at all — the free first tier of the
    GRAB/GO LIVE decision. A manifest or wire protocol is knowably live from
    the string alone; anything else is a page yt-dlp has to resolve."""
    raw = (url or "").strip()
    if not raw:
        return KIND_PAGE, ""
    parsed = urlparse(raw)
    scheme = (parsed.scheme or "").lower()
    path_lower = (parsed.path or "").lower()
    low = raw.lower()

    if scheme in STREAM_SCHEMES:
        host = (parsed.hostname or "").lower()
        # A local/wildcard host means the operator wants us to RECEIVE a stream
        # (OBS pushing here) rather than pull one.
        return (KIND_LISTENER if host in _LISTEN_HOSTS else KIND_PROTOCOL), raw

    if scheme in ("http", "https") or not scheme:
        if any(path_lower.endswith(ext) for ext in MANIFEST_EXTS):
            return KIND_MANIFEST, raw
        # Some CDNs bury the extension before the query string.
        if any(f"{ext}?" in low for ext in MANIFEST_EXTS):
            return KIND_MANIFEST, raw
        if any(low.endswith(ext) for ext in MANIFEST_EXTS):
            return KIND_MANIFEST, raw
    return KIND_PAGE, raw


def best_stream_url(info: dict) -> str:
    """Prefer an HLS/DASH manifest; fall back to the best single format URL.
    yt-dlp orders worst->best, so walk backwards — and prefer a rendition that
    carries audio, since a video-only one would capture silence."""
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
    """Watch page -> (stream_url, title, headers). Only called for KIND_PAGE."""
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
    """Open-ended capture into MPEG-TS. `-c copy` throughout: no re-encode, so
    this is nearly free on CPU and the recording is bit-for-bit what the
    broadcaster sent. Deliberately NO -nostdin — the runner needs stdin open to
    deliver 'q' for a clean stop."""
    cmd = [find_ffmpeg(), "-hide_banner", "-loglevel", "error", "-y"]

    if headers:
        cmd += ["-headers", "".join(f"{k}: {v}\r\n" for k, v in headers.items())]

    scheme = (urlparse(stream_url).scheme or "").lower()
    if scheme in ("http", "https"):
        # A newsroom wifi blip should not end a 40-minute capture.
        cmd += ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "10"]
    if kind == KIND_LISTENER:
        cmd += ["-listen", "1"]

    cmd += ["-i", stream_url]
    if max_seconds and max_seconds > 0:
        cmd += ["-t", f"{float(max_seconds):.3f}"]
    cmd += [
        "-c", "copy",
        "-f", "mpegts",
        "-flush_packets", "1",   # see the module note above — load-bearing
        "-progress", "pipe:1",
        dest,
    ]
    return cmd


def build_remux_cmd(src: str, dest: str) -> list[str]:
    """Lossless MPEG-TS -> MP4. +faststart so the result seeks instantly in the
    player; +genpts because a live TS often starts mid-GOP. -nostdin IS correct
    here, unlike the capture command."""
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
    """Run an open-ended capture, reporting elapsed/size rather than a
    percentage (a live stream has no total to divide by).

    Returns (returncode, stderr tail). A stopped capture reports 0 even if
    FFmpeg's own code is non-zero, because an operator-requested stop is the
    normal way this ends."""
    proc = subprocess.Popen(
        list(cmd),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.PIPE,      # required for the graceful 'q'
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
        code = 0   # operator asked it to end; that is not a failure
    return code, "\n".join(err_tail[-12:])


def graceful_stop(proc: subprocess.Popen) -> None:
    """'q' on stdin closes the muxer properly. Falls back to terminate/kill if
    FFmpeg is wedged — safe here ONLY because the target is MPEG-TS, which
    survives an abrupt end."""
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
    """Record straight onto the shared drive from the first byte.

    The .ts is written directly under MEDIA_ROOT rather than a temp dir —
    that is the whole point of drive-only storage: the recording is durable
    (and clippable — see /transcribe's startSeconds) the moment FFmpeg starts
    writing, not after the stream ends and something gets uploaded. The
    destination NAME is reserved (an empty placeholder touched into
    existence) as soon as the title is known and reported on the job via
    `local_path` immediately, so the caller can create the library row and
    start polling for a transcript before a single second has recorded.
    """
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

        ts_path = reserve_media_path(title, ".ts")
        rel_ts = ts_path.relative_to(MEDIA_ROOT).as_posix()
        set_job(job_id, status="Connecting…", detail=title, local_path=rel_ts)

        max_seconds = max(0.0, float(max_minutes or 0.0)) * 60.0
        cmd = build_capture_cmd(stream_url, kind, str(ts_path), max_seconds, headers)

        def on_tick(seconds: float, written: int) -> None:
            # Matches the desktop readout exactly, two spaces around the middot.
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
            # Non-zero but bytes on disk: keep them. This is exactly the case
            # the TS-first design exists for.
            set_job(job_id, detail=f"ffmpeg exited {code}; keeping the recording")

        set_job(job_id, status="Finalising (remux to MP4)…")
        mp4_path = reserve_media_path(title, ".mp4")
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
            # Leave the .ts alone on failure — a playable-but-awkward file
            # beats a deleted one, which is the whole reason this records to
            # TS. The empty .mp4 placeholder never became real; drop it.
            set_job(job_id, detail="remux failed; the .ts recording is the final file")
            try:
                mp4_path.unlink()
            except OSError:
                pass
            final_path, ext = ts_path, "ts"

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
        # A reservation with nothing ever recorded into it is litter, not a
        # recording — remove the empty placeholder rather than leaving a
        # phantom file an operator has to notice and clean up by hand.
        if ts_path is not None and ts_path.exists() and ts_path.stat().st_size == 0:
            try:
                ts_path.unlink()
            except OSError:
                pass
        set_job(job_id, status="Error", error=str(exc), pct=None)
    finally:
        _stop_flags.pop(job_id, None)


# --------------------------------------------------------------------------- #
# Summaries — port of app/summarize.py
#
# Turns a stretch of transcript into a HEADLINE an editor can scan — the point
# of Key Moments is to replace reading the transcript, so a summary that
# restates it has done nothing.
#
# EXTRACTIVE, NOT ABSTRACTIVE — and that is a correctness decision, not a
# performance one.
#
# Both abstractive models were tried on real transcript and both FABRICATED:
#
#   distilbart-XSUM   "...to the US House of Representatives Intelligence
#                      Committee"          (it was Judiciary)
#                     "Facebook has announced..."   (wrong company entirely)
#
#   distilbart-CNN    'President Obama: "It is an honor to be with you..."'
#                     "President Sans has led Virginia Tech for over a decade"
#                     — on a Governor Spanberger commencement address. Neither
#                     "Obama" nor "Sans" appears anywhere in the transcript.
#                     Also "Senator Kenny said to Senator Kenny that..."
#
# Both are fine-tuned on news wire, so they reproduce its conventions —
# including attributing quotes to whichever public figure the training data
# featured most. For a political media tool, a Key Moment that puts words in
# the wrong politician's mouth is not a quality problem, it is a liability.
#
# So the summary is now the most REPRESENTATIVE REAL SENTENCE from the
# section, chosen by embedding every sentence and taking the one closest to
# the section's centroid. Every word is verbatim from the transcript, so
# hallucination is impossible by construction rather than by tuning. It is
# also far faster (a 90MB embedder, already loaded for tagging, instead of a
# 1.2GB generator) and fully deterministic.
#
# ABSTRACTIVE_SUMMARIES=1 restores the generative path for anyone who wants
# it, with the above as the documented reason not to.
# --------------------------------------------------------------------------- #
# OFF BY DEFAULT, AND THAT IS NOT AN OVERSIGHT. Both abstractive models
# fabricate on this material — measured, not theorised: distilbart-CNN put
# 'President Obama: "It is an honor to be with you..."' on a Spanberger
# commencement address, and on a Gabe Vasquez interview it invented a
# "Rep. Ruben Navarrette" and attributed a direct quote to him. A written
# sentence is nicer to read than a verbatim one; a fabricated quote attributed
# to a named member of Congress is a liability. Opt in with
# ABSTRACTIVE_SUMMARIES=1 only if every summary will be checked by a human.
USE_ABSTRACTIVE = os.environ.get("ABSTRACTIVE_SUMMARIES", "").lower() in ("1", "true", "yes")
SUMMARY_MODEL = os.environ.get("SUMMARY_MODEL", "sshleifer/distilbart-cnn-12-6")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "all-MiniLM-L6-v2")
MAX_INPUT_CHARS = 3500
MIN_INPUT_WORDS = 25
SUMMARY_MAX_TOKENS = int(os.environ.get("SUMMARY_MAX_TOKENS", "40"))
SUMMARY_MIN_TOKENS = 8

# A headline sentence. Below the floor it says nothing ("Good morning."),
# above the ceiling it is a paragraph the operator has to read rather than
# scan.
HEADLINE_MIN_WORDS = 7
HEADLINE_MAX_WORDS = 38

# Openers and courtesies carry no information about what a section is ABOUT,
# but they are frequent and short, so pure centrality can land on them.
_FILLER_STARTS = (
    "good morning", "good afternoon", "good evening", "thank you", "thanks",
    "welcome", "hello", "hi ", "okay", "all right", "alright",
    "yes ", "no ", "sure ", "please ", "excuse me",
)

# A sentence opening on a conjunction or a hedge is the MIDDLE of a thought.
# It may sit dead-centre of the section's meaning and still read as a
# fragment: "And I kept sort of walking through it." was a real pick before
# this penalty existed.
_WEAK_STARTS = (
    "and ", "but ", "so ", "or ", "then ", "then,", "also ", "plus ",
    "that means", "that is", "that's", "this is", "it is", "it's",
    "i mean", "you know", "well ", "right ", "now ", "because ",
    "which ", "who ", "there's", "there is", "there are",
)

# Where a headline reads best. Long enough to carry a claim, short enough to
# scan in one pass.
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
    """Whether Key Moments can be given written headlines at all.

    The extractive path needs only sentence-transformers (and degrades to the
    first substantive sentence without even that), so this reports on the
    embedder rather than on torch/transformers. Must stay instant and must
    never trigger a download — it gates a UI decision.
    """
    if USE_ABSTRACTIVE:
        return _importable("torch") and _importable("transformers")
    return _importable("sentence_transformers")


def load_summarizer() -> bool:
    """Build the pipeline, downloading the model on first use. Slow; callers
    must be off the request path. A failure is remembered so a broken install
    doesn't re-attempt a 1.2GB download on every transcript."""
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
            # Half the cores: a background nicety must not starve an export or
            # a live capture the operator is actually waiting on.
            torch.set_num_threads(max(1, (torch.get_num_threads() or 2) // 2))
            print(f"Loading summariser {SUMMARY_MODEL} (first run downloads ~1.2GB)…")
            _sum_tokenizer = AutoTokenizer.from_pretrained(SUMMARY_MODEL)
            _sum_model = AutoModelForSeq2SeqLM.from_pretrained(SUMMARY_MODEL)
            # BART decodes from a forced beginning-of-sequence token; the
            # shipped config omits it and transformers warns on every call.
            # Setting it explicitly keeps the log clean and the decoding
            # deterministic across transformers versions.
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
    """Whisper output carries filler the model would otherwise faithfully
    summarise ("The speaker said 'um' repeatedly")."""
    text = re.sub(r"\b(?:uh|um|er|ah)\b[,.]?\s*", "", text, flags=re.IGNORECASE)
    return re.sub(r"\s+", " ", text).strip()


# Titles and abbreviations whose full stop does NOT end a sentence. Without
# this, "Mr. Pichai is the CEO of Google. Your written statement..." splits at
# "Mr." and the whole three-sentence summary survives — which is exactly the
# regurgitation the first-sentence rule exists to prevent.
_ABBREVIATIONS = {
    "mr", "mrs", "ms", "dr", "prof", "sen", "rep", "gov", "gen", "lt", "sgt",
    "col", "capt", "st", "jr", "sr", "vs", "etc", "inc", "ltd", "co", "corp",
    "no", "fig", "approx", "dept", "univ", "asst", "atty", "supt", "hon",
}


def _first_sentence(text: str) -> str:
    """The leading sentence, respecting abbreviations and initials.

    A full stop only ends a sentence when the token before it isn't a known
    abbreviation or a single initial, and what follows looks like a new
    sentence (an opening quote or a capital letter).
    """
    for match in re.finditer(r"[.!?]", text):
        end = match.end()
        head = text[:end]
        # "U.S." / "J. R." — a dotted initial or acronym, not a sentence end.
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
    """Raw generation -> a single scannable headline."""
    text = re.sub(r"\s+", " ", text).strip()
    # CNN/DailyMail formatting bleeds through the fine-tune as a space before
    # sentence punctuation ("...families directly ."), which reads as a typo.
    text = re.sub(r"\s+([.,;:!?])", r"\1", text)

    # KEEP ONLY THE LEADING SENTENCE. This is what turns a summary into a
    # headline: the model front-loads the topic sentence and then elaborates,
    # and the elaboration is precisely the transcript restatement Key Moments
    # exists to replace. Anything after the first full stop is dropped.
    first = _first_sentence(text)
    # Must actually END a sentence — _first_sentence falls back to the whole
    # string when it finds no terminator, and that case still needs the
    # truncation handling below.
    if first and first[-1] in ".!?" and len(first.split()) >= 5:
        text = first
    elif text and text[-1] not in ".!?":
        # Truncated mid-clause at the token cap: trim back to the last full
        # stop if enough survives, otherwise mark it as continuing rather than
        # throwing the substance away for a clean edge.
        cut = max(text.rfind("."), text.rfind("!"), text.rfind("?"))
        if cut >= len(text) * 0.6:
            text = text[: cut + 1]
        else:
            text = text.rstrip(" ,;:-") + "…"

    if text and text[0].islower():
        text = text[0].upper() + text[1:]
    return text


def load_embedder():
    """The sentence embedder used to rank candidate headline sentences.
    Same 90MB model KeyBERT already loads, so this is usually free."""
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
    """Sentences, using spaCy when present and an abbreviation-aware regex
    otherwise. Transcripts are punctuated by Whisper, so this is reliable."""
    text = re.sub(r"\s+", " ", text or "").strip()
    if not text:
        return []
    nlp = load_spacy()
    if nlp is not None:
        try:
            # Only the sentence boundaries are needed; skipping NER and the
            # parser makes this cheap on a long section.
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
    """The most representative REAL sentence in a section.

    Every candidate is a verbatim sentence from the transcript, so the result
    cannot invent a name, a committee, or an attribution — which is exactly
    what both generative models did.

    Ranking is cosine similarity to the section centroid (how well a sentence
    stands in for the whole passage), with two adjustments that matter on
    speech transcript: courtesies are demoted, because "Thank you very much"
    is short and frequent enough to look central while saying nothing, and
    very early sentences get a small nudge, because speakers state the point
    before elaborating.
    """
    sentences = [s for s in _split_sentences(text)]
    candidates = [
        s for s in sentences
        if HEADLINE_MIN_WORDS <= len(s.split()) <= HEADLINE_MAX_WORDS
    ]
    if not candidates:
        # Nothing the right length: fall back to the longest sentence that is
        # at least a clause, trimmed, rather than returning nothing at all.
        longest = max(sentences, key=lambda s: len(s.split()), default="")
        words = longest.split()
        if len(words) < 4:
            return None
        return _polish(" ".join(words[:HEADLINE_MAX_WORDS]))

    model = load_embedder()
    if model is None:
        # No embedder: first substantive sentence is a decent signpost and is
        # still verbatim.
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

            # Centrality: how well this sentence stands in for the passage.
            score = float(scores[i])
            # Courtesies are short and frequent enough to look central while
            # saying nothing about the subject.
            if _is_filler(s):
                score -= 0.30
            # Mid-thought openers read as fragments however central they are.
            if low.startswith(_WEAK_STARTS):
                score -= 0.18
            # A sentence that is mostly pronouns names nothing.
            pronouns = sum(1 for w in low.split() if w.strip(".,;:") in
                           {"it", "he", "she", "they", "this", "that", "them", "we", "i"})
            if words and pronouns / words > 0.22:
                score -= 0.12
            # Prefer headline length over merely-acceptable length.
            score += 0.14 * (1 - min(1.0, abs(words - IDEAL_WORDS) / IDEAL_WORDS))
            # Small positional nudge: speakers state the point before
            # elaborating on it.
            score += max(0.0, 0.06 * (1 - i / max(1, len(candidates) - 1)))

            if score > best_score:
                best_i, best_score = i, score
        return _polish(candidates[best_i])
    except Exception as exc:
        print(f"headline selection failed: {exc}")
        return _polish(candidates[0])


def summarize_one(text: str) -> str | None:
    """One section of transcript -> one headline sentence, or None."""
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
                do_sample=False,   # the same clip must summarise the same way twice
                num_beams=4,       # output is short now, so the better search is cheap
                # XSum models will happily repeat a phrase to fill the length;
                # blocking repeated trigrams is the standard guard.
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
#
# Two complementary signals, because either alone is weak on political video:
#
#   NAMED ENTITIES (spaCy) — who and what this is about. "Sundar Pichai",
#   "Judiciary Committee", "Ohio". These are the tags somebody actually
#   searches for, and pure keyword statistics rarely surface them cleanly
#   because a name is usually rare rather than frequent.
#
#   KEYPHRASES (KeyBERT) — what it is about. Semantic rather than
#   frequency-based, so it finds "data privacy" in a passage that never says
#   those two words together, which TF-IDF cannot do.
#
# Both degrade independently: no spaCy still gives keyphrases, no KeyBERT
# still gives entities, neither still leaves the caller free to derive tags
# from metadata.
# --------------------------------------------------------------------------- #
SPACY_MODEL = "en_core_web_sm"
KEYBERT_MODEL = "all-MiniLM-L6-v2"
MAX_TAGS = 14
# Entity types worth tagging. Deliberately excludes DATE/TIME/CARDINAL/etc —
# "three" and "today" are noise, not subjects.
ENTITY_LABELS = {"PERSON", "ORG", "GPE", "LOC", "NORP", "EVENT", "LAW", "FAC", "PRODUCT"}
# spaCy's entity types collapsed into the handful of groups an operator
# actually files things under. The UI shows these as folders, so the names are
# user-facing, not internal.
ENTITY_GROUP = {
    "PERSON": "people",
    "ORG": "organizations",
    "NORP": "organizations",   # nationalities/religious/political groups
    "GPE": "places",
    "LOC": "places",
    "FAC": "places",
    "EVENT": "events",
    "LAW": "policy",
    "PRODUCT": "topics",
}
# A noun chunk made only of these is a pronoun or a filler phrase ("we", "this
# thing", "a lot"), never a subject worth tagging.
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
    """spaCy pipeline, downloading the small English model on first use."""
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
                # Not downloaded yet. Fetch it once rather than making the
                # operator run a second install command they'd have to know about.
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
    """Collapse whitespace, drop possessives and leading articles."""
    t = re.sub(r"\s+", " ", (text or "").strip())
    t = re.sub(r"['']s$", "", t)
    t = re.sub(r"^(the|a|an)\s+", "", t, flags=re.IGNORECASE)
    t = t.strip(" ,-—\n\t")
    # Keep the dots on a dotted acronym: stripping the trailing one turns
    # "U.S." into "U.S", which reads as a typo everywhere it's displayed.
    if re.fullmatch(r"(?:[A-Za-z]\.){2,}", t):
        return t                      # already well-formed: "U.S."
    if re.fullmatch(r"(?:[A-Za-z]\.)+[A-Za-z]", t):
        return t + "."                # spaCy dropped the final dot: "U.S"
    return t.rstrip(".")


def _subsumed(label: str, others: list[str]) -> bool:
    """Is this label just a fragment of a fuller one already kept?

    "Pichai" alongside "Sundar Pichai" is noise — the specific name is
    strictly more useful and the short one adds nothing to a tag list.
    """
    words = set(label.lower().split())
    if not words:
        return True
    for other in others:
        ow = set(other.lower().split())
        if words < ow:   # proper subset
            return True
    return False


def extract_tags(text: str, extra: list[str] | None = None) -> list[dict[str, Any]]:
    """Transcript -> ranked tags, each {label, kind}. Never raises: a tagger
    that fails to load simply contributes nothing.

    Entities and keyphrases are collected separately and merged under QUOTAS.
    Collecting them into one capped list let entities crowd keyphrases out
    entirely on a name-dense hearing transcript — measured as 14 entities and
    zero topics, which is exactly half the point of the feature missing.
    """
    text = (text or "").strip()
    entities: list[str] = []
    topics: list[str] = []
    # label -> folder ("people" / "organizations" / "places" / ...), so the UI
    # can group without re-deriving what spaCy already determined.
    entity_kinds: dict[str, str] = {}

    noun_chunks: list[str] = []
    if text:
        nlp = load_spacy()
        if nlp is not None:
            try:
                # spaCy's small model has a 1M character ceiling; a long
                # hearing can exceed it, and the opening carries the subjects.
                doc = nlp(text[:400_000])

                counts: dict[str, int] = {}
                for ent in doc.ents:
                    if ent.label_ not in ENTITY_LABELS:
                        continue
                    name = _tidy_entity(ent.text)
                    if name and 2 < len(name) <= 40:
                        counts[name] = counts.get(name, 0) + 1
                        # First type wins; spaCy occasionally labels the same
                        # string two ways across a long transcript.
                        entity_kinds.setdefault(name, ENTITY_GROUP.get(ent.label_, "topics"))
                # Most-mentioned first: a name said once in passing is rarely
                # what the clip is about.
                ordered = [n for n, _ in sorted(counts.items(), key=lambda kv: (-kv[1], -len(kv[0])))]
                # Drop fragments against the WHOLE candidate set, not just
                # what's been kept so far: "Pichai" is usually said more often
                # than "Sundar Pichai" and therefore comes first, so checking
                # only the already-kept list never removes it.
                entities = [n for n in ordered if not _subsumed(n, ordered)]

                # Noun phrases become the candidate pool for keyphrase ranking.
                # Left to its own n-grams KeyBERT happily returns "examined
                # data privacy" and "asked search ranking" — verb-led fragments
                # that read badly as tags. Ranking real noun chunks instead
                # keeps the semantic scoring and drops the grammatical junk.
                chunk_counts: dict[str, int] = {}
                for nc in doc.noun_chunks:
                    p = _tidy_entity(nc.text.lower())
                    words = p.split()
                    if not (2 < len(p) <= 40) or not words:
                        continue
                    if all(w in _CHUNK_STOP for w in words):
                        continue
                    # "25 years", "three months" — a duration, not a subject.
                    if _DURATION_RE.fullmatch(p):
                        continue
                    chunk_counts[p] = chunk_counts.get(p, 0) + 1
                ranked_chunks = sorted(chunk_counts.items(), key=lambda kv: (-kv[1], -len(kv[0])))
                # Multi-word phrases make far better tags than bare nouns:
                # "data privacy" and "american manufacturing" say something,
                # "information" and "work" do not. Single words are kept only
                # as a backstop for a transcript too sparse to yield phrases.
                # Capped at 4 words: beyond that a "chunk" is a whole clause
                # and stops working as a tag.
                multi = [c for c, _ in ranked_chunks if 2 <= len(c.split()) <= 4]
                single = [c for c, n in ranked_chunks if len(c.split()) == 1 and n > 2]
                noun_chunks = (multi if len(multi) >= 8 else multi + single)[:400]
            except Exception as exc:
                print(f"entity extraction failed: {exc}")

        kw = load_keybert()
        if kw is not None:
            try:
                # use_mmr penalises near-duplicates so the list isn't five
                # rewordings of one idea.
                common = {"top_n": 12, "use_mmr": True, "diversity": 0.6}
                if noun_chunks:
                    # keyphrase_ngram_range is REQUIRED alongside candidates.
                    # KeyBERT builds its candidate matrix with a CountVectorizer
                    # whose vocabulary is the candidate list but whose n-gram
                    # range still defaults to (1,1) — so every multi-word
                    # candidate matches nothing and the call returns an empty
                    # list with no error. Measured: 0 results with 106 good
                    # candidates until this was passed.
                    pairs = kw.extract_keywords(
                        text[:20_000], candidates=noun_chunks,
                        keyphrase_ngram_range=(1, 4), **common,
                    )
                else:
                    # No spaCy: fall back to raw n-grams rather than no topics.
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

    # Roughly 60/40 in favour of entities — on political video the "who" is
    # what people search for — but never at the cost of all the topics.
    entity_quota = max(1, int((MAX_TAGS - len(tags)) * 0.6))
    topic_quota = MAX_TAGS - len(tags) - entity_quota

    kept_e = [e for e in entities if not _subsumed(e, [t["label"] for t in tags])][:entity_quota]
    for e in kept_e:
        add(e, entity_kinds.get(e, "topics"))
    kept_t = [t for t in topics if not _subsumed(t, [x["label"] for x in tags])][:topic_quota]
    for t in kept_t:
        add(t, "topics")

    # Backfill from whichever side had spare capacity, so a video with few
    # entities still comes back with a full, useful tag list.
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
    """Render a clip from a master on the shared drive, then file it there too.

    The ARGUMENTS ARE BUILT BY THE WEB APP and passed in whole — this only
    substitutes the real input and output paths and runs FFmpeg. That is
    deliberate: the filter graphs are parity-tested against the desktop app in
    TypeScript, and a second graph builder here would be free to drift, which
    would mean exported video quietly differing depending on where the master
    happened to live.

    The source can still be RECORDING when this runs — clipping while live is
    the point of writing captures straight to the drive. FFmpeg reading a
    growing file for a bounded, already-elapsed time range works the same as
    reading a finished one; nothing here needs to know the difference.
    """
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
        # Clips live in their own subfolder — the top level is masters, and a
        # busy operator can produce dozens of short exports per hearing.
        local_path = store_in_media_root(Path(out_path), title, subdir="clips")
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


def run_tagging(job_id: str, text: str, extra: list[str]) -> None:
    try:
        set_job(job_id, status="Reading transcript…", pct=10.0)
        tags = extract_tags(text, extra)
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
        # THE LOAD-BEARING HEADER. Chrome treats 127.0.0.1 as a private network
        # target; when the calling page is HTTPS it sends a preflight and needs
        # this back before the real request is allowed through at all. Without
        # it every call from a deployed app fails silently, with no request
        # ever reaching this process.
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

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _serve_media(self, rel: str, download: bool = False) -> None:
        """Stream a file from the shared drive, honouring Range.

        Range is not optional: without a 206 the browser cannot seek, and a
        two-hour hearing becomes unusable — every scrub would restart the
        download from byte zero.

        `download` sends Content-Disposition: attachment, which is what makes
        a share link's DOWNLOAD button actually save the file instead of just
        opening it — a plain navigation to a video/mp4 response otherwise
        plays inline, same as clicking PLAY would.
        """
        try:
            path = safe_media_path(urllib.parse.unquote(rel))
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
                # "bytes=-500" means the LAST 500 bytes, not the first.
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
            # Normal: the browser closed the connection on a seek.
            pass

    def do_GET(self) -> None:
        if self.path.startswith("/media/"):
            tail = self.path[len("/media/"):]
            rel, _, query = tail.partition("?")
            download = urllib.parse.parse_qs(query).get("download", ["0"])[0] not in ("0", "", "false")
            self._serve_media(rel, download=download)
            return

        if self.path == "/library":
            self._json(200, {
                "root": str(MEDIA_ROOT),
                "exists": MEDIA_ROOT.is_dir(),
                "files": scan_media(),
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
                # Advertised so the UI can say "keyword labels" honestly
                # instead of promising sentences it can't produce.
                "summarizer": summarizer_available(),
                "tagger": _importable("spacy") or _importable("keybert"),
            })
            return
        if match := re.fullmatch(r"/jobs/([0-9a-f]{32})", self.path):
            job = get_job(match.group(1))
            self._json(200 if job else 404, job or {"error": "unknown job"})
            return
        self._json(404, {"error": "not found"})

    def _handle_stop(self, job_id: str) -> None:
        """Stop is the SUCCESS path for a capture, not an abort: FFmpeg is told
        to close the file properly and the recording is kept, remuxed and
        uploaded exactly as if a time limit had expired."""
        if get_job(job_id) is None:
            self._json(404, {"error": "unknown job"})
            return
        _stop_flags.setdefault(job_id, threading.Event()).set()
        set_job(job_id, status="Stopping…")
        self._json(200, {"stopping": True})

    def do_POST(self) -> None:
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
            if not url:
                self._json(400, {"error": "missing 'url'"})
                return
            job_id = new_job()
            threading.Thread(
                target=run_grab,
                args=(job_id, url, body.get("quality") or "HD", bool(body.get("subs"))),
                daemon=True,
            ).start()
            self._json(202, {"jobId": job_id})
            return

        if match := re.fullmatch(r"/jobs/([0-9a-f]{32})/stop", self.path):
            self._handle_stop(match.group(1))
            return

        if self.path == "/capture":
            body = self._read_json()
            url = (body.get("url") or "").strip()
            if not url:
                self._json(400, {"error": "missing 'url'"})
                return
            job_id = new_job()
            _stop_flags[job_id] = threading.Event()
            threading.Thread(
                target=run_live_capture,
                args=(
                    job_id,
                    url,
                    body.get("title") or "",
                    float(body.get("maxMinutes") or 0.0),
                ),
                daemon=True,
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
            text = str(body.get("text") or "")
            extra = [str(x) for x in (body.get("extra") or [])]
            if not text and not extra:
                self._json(400, {"error": "missing 'text'"})
                return
            job_id = new_job()
            threading.Thread(target=run_tagging, args=(job_id, text, extra), daemon=True).start()
            self._json(202, {"jobId": job_id})
            return

        if self.path == "/transcribe":
            body = self._read_json()
            url = (body.get("url") or "").strip()
            # A master on the shared drive is read straight off disk. Fetching
            # it over HTTP from ourselves would copy gigabytes to a temp file
            # for no reason.
            rel = (body.get("path") or "").strip()
            # >0 means "incremental": only the audio AFTER this point is new
            # since the last poll. Live captures write straight to the drive,
            # so a still-recording file can be sliced the same way a finished
            # one is probed — re-whispering everything from zero every ~20s
            # would get slower as the recording gets longer, for no benefit.
            start_seconds = max(0.0, float(body.get("startSeconds") or 0.0))
            if not url and not rel:
                self._json(400, {"error": "missing 'url' or 'path'"})
                return
            language = body.get("language") or DEFAULT_LANGUAGE
            tmp_path = None
            slice_path = None
            local_source = None
            try:
                model = get_model()
                if rel:
                    local_source = str(safe_media_path(rel))
                    if not os.path.isfile(local_source):
                        self._json(404, {"error": f"not on the shared drive: {rel}"})
                        return
                else:
                    tmp_path = download_to_temp(url)

                source_for_whisper = local_source or tmp_path
                if start_seconds > 0:
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
                    # Polling ahead of what has actually recorded is normal,
                    # not an error — the caller just tries again next tick.
                    if extract.returncode != 0 or os.path.getsize(slice_path) < 1024:
                        self._json(200, {"segments": [], "duration": 0.0, "language": language or ""})
                        return
                    source_for_whisper = slice_path

                segments_iter, info = model.transcribe(
                    source_for_whisper,
                    beam_size=BEAM_SIZE,
                    vad_filter=VAD_FILTER,
                    language=language,
                    condition_on_previous_text=False,
                )
                segments = [
                    {
                        "start": float(s.start) + start_seconds,
                        "end": float(s.end) + start_seconds,
                        "text": (s.text or "").strip(),
                    }
                    for s in segments_iter
                ]
                segments = [s for s in segments if s["text"]]
                if not segments and start_seconds == 0:
                    self._json(422, {"error": "no speech detected"})
                    return
                self._json(200, {
                    "segments": segments,
                    "duration": float(getattr(info, "duration", 0.0) or 0.0),
                    "language": getattr(info, "language", language) or "",
                })
            except Exception as exc:  # noqa: BLE001 — always answer, never hang
                self._json(500, {"error": str(exc)})
            finally:
                if tmp_path and os.path.exists(tmp_path):
                    os.remove(tmp_path)
                if slice_path and os.path.exists(slice_path):
                    os.remove(slice_path)
            return

        self._json(404, {"error": "not found"})

    def log_message(self, fmt: str, *args) -> None:
        print(f"[basiq-agent] {self.address_string()} {fmt % args}")


def main() -> None:
    # 127.0.0.1 only, deliberately — this agent downloads media and holds
    # decoded audio; it should never be reachable from anywhere but this
    # machine's own browser.
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Basiq agent listening on http://127.0.0.1:{PORT}")
    print(f"  whisper: {'ready' if WhisperModel else 'NOT INSTALLED'}   "
          f"yt-dlp: {'ready' if yt_dlp else 'NOT INSTALLED'}")
    print(f"  model={MODEL_NAME} device={DEVICE} compute={COMPUTE_TYPE} beam={BEAM_SIZE} vad={VAD_FILTER}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")


if __name__ == "__main__":
    main()
