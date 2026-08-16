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
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Sequence
from urllib.parse import urlparse

# Must precede the huggingface_hub import that faster_whisper pulls in. hf_xet,
# its newer Rust download backend, hit a real "Access is denied (os error 5)"
# writing its own log under %USERPROFILE% on Windows and aborted the model
# download outright rather than degrading. Disabling it falls back to plain
# HTTP and is a no-op once the model is cached.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

try:
    from faster_whisper import WhisperModel
except ImportError:
    WhisperModel = None  # type: ignore[assignment]

try:
    import yt_dlp
except ImportError:
    yt_dlp = None  # type: ignore[assignment]

HERE = Path(__file__).resolve().parent
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


def upload_to_signed(signed_url: str, file_path: str, content_type: str) -> None:
    """PUT the finished file straight to storage. Doing this from the agent
    rather than handing bytes back through the browser keeps a multi-GB
    hearing off the operator's tab entirely."""
    size = os.path.getsize(file_path)
    with open(file_path, "rb") as fh:
        req = urllib.request.Request(signed_url, data=fh, method="PUT")
        req.add_header("Content-Type", content_type)
        req.add_header("Content-Length", str(size))
        req.add_header("x-upsert", "true")
        with urllib.request.urlopen(req, timeout=1800) as resp:
            if resp.status not in (200, 201):
                raise RuntimeError(f"upload failed with HTTP {resp.status}")


def run_grab(job_id: str, url: str, quality: str, subs: bool, signed_url: str) -> None:
    if yt_dlp is None:
        set_job(job_id, status="Error", error="yt-dlp is not installed", pct=None)
        return

    workdir = tempfile.mkdtemp(prefix="basiq_grab_")
    try:
        set_job(job_id, status="Resolving source…", pct=0.0)

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

        set_job(job_id, status="Uploading…", pct=99.0)
        content_type = "audio/mpeg" if media_file.suffix.lower() == ".mp3" else "video/mp4"
        upload_to_signed(signed_url, str(media_file), content_type)

        set_job(job_id, status="Complete", pct=100.0, result={
            "title": title,
            "sizeBytes": media_file.stat().st_size,
            "ext": media_file.suffix.lstrip("."),
            "uploader": (result.get("uploader") or result.get("channel") or "") if result else "",
            "uploadDate": (result.get("upload_date") or "") if result else "",
            "sourceUrl": url,
        })
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
    signed_url: str,
) -> None:
    workdir = tempfile.mkdtemp(prefix="basiq_capture_")
    partial = str(Path(workdir) / "capture.part.ts")
    final = str(Path(workdir) / "capture.mp4")
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

        set_job(job_id, status="Connecting…", detail=title)

        max_seconds = max(0.0, float(max_minutes or 0.0)) * 60.0
        cmd = build_capture_cmd(stream_url, kind, partial, max_seconds, headers)

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

        if not os.path.exists(partial) or os.path.getsize(partial) == 0:
            raise RuntimeError(err or "the capture produced no data — is that stream actually live?")
        if code != 0:
            # Non-zero but bytes on disk: keep them. This is exactly the case
            # the TS-first design exists for.
            set_job(job_id, detail=f"ffmpeg exited {code}; keeping the recording")

        set_job(job_id, status="Finalising (remux to MP4)…")
        remux = subprocess.run(build_remux_cmd(partial, final), capture_output=True, text=True, timeout=1800)
        upload_path = final
        if remux.returncode != 0 or not os.path.exists(final) or os.path.getsize(final) == 0:
            # Leave the .ts alone on failure — a playable-but-awkward file beats
            # a deleted one, which is the whole reason this records to TS.
            set_job(job_id, detail="remux failed; uploading the raw .ts instead")
            upload_path = partial

        seconds = (get_job(job_id) or {}).get("seconds", 0.0)
        set_job(job_id, status="Uploading…")
        upload_to_signed(
            signed_url, upload_path,
            "video/mp4" if upload_path.endswith(".mp4") else "video/mp2t",
        )

        set_job(job_id, status="Complete", pct=100.0, result={
            "title": title,
            "sizeBytes": os.path.getsize(upload_path),
            "ext": "mp4" if upload_path.endswith(".mp4") else "ts",
            "uploader": "",
            "uploadDate": "",
            "sourceUrl": url,
            "durationSeconds": seconds,
            "isLive": True,
        })
    except Exception as exc:
        set_job(job_id, status="Error", error=str(exc), pct=None)
    finally:
        _stop_flags.pop(job_id, None)
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

    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(200, {
                "status": "ok",
                "model": MODEL_NAME,
                "device": DEVICE,
                "compute_type": COMPUTE_TYPE,
                "whisper": WhisperModel is not None,
                "ytdlp": yt_dlp is not None,
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
            signed_url = (body.get("signedUrl") or "").strip()
            if not url or not signed_url:
                self._json(400, {"error": "missing 'url' or 'signedUrl'"})
                return
            job_id = new_job()
            threading.Thread(
                target=run_grab,
                args=(job_id, url, body.get("quality") or "HD", bool(body.get("subs")), signed_url),
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
            signed_url = (body.get("signedUrl") or "").strip()
            if not url or not signed_url:
                self._json(400, {"error": "missing 'url' or 'signedUrl'"})
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
                    signed_url,
                ),
                daemon=True,
            ).start()
            self._json(202, {"jobId": job_id})
            return

        if self.path == "/transcribe":
            body = self._read_json()
            url = (body.get("url") or "").strip()
            if not url:
                self._json(400, {"error": "missing 'url'"})
                return
            language = body.get("language") or DEFAULT_LANGUAGE
            tmp_path = None
            try:
                model = get_model()
                tmp_path = download_to_temp(url)
                segments_iter, info = model.transcribe(
                    tmp_path,
                    beam_size=BEAM_SIZE,
                    vad_filter=VAD_FILTER,
                    language=language,
                    condition_on_previous_text=False,
                )
                segments = [
                    {"start": float(s.start), "end": float(s.end), "text": (s.text or "").strip()}
                    for s in segments_iter
                ]
                segments = [s for s in segments if s["text"]]
                if not segments:
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
