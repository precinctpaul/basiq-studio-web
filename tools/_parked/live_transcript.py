"""PARKED, 2026-09-24 -- live transcript / live clip generation.

Not wired into basiq_agent.py's run_live_capture in any way (not imported,
not called, no env var checks left in the hot path). This is a verbatim
excerpt of code that used to live directly inside basiq_agent.py, kept here
for possible future reference only.

Per an explicit, permanent product decision (not a "for now" deprioritization):
live capture -- reliably recording a full live stream -- remains a core,
necessary feature. Live TRANSCRIPT and live CLIPPING (transcribing or
clipping a stream while it is still being recorded) are permanently out of
scope. Transcription of a live capture happens afterward, at whatever pace is
convenient, through the exact same batch pipeline (run_transcribe) an
ordinary GRAB already uses once the finished file lands in the library --
nothing about that path needs this code.

Why this was pulled out of the hot path entirely, rather than left behind an
env var gate (it previously sat behind `LIVE_TRANSCRIPT_ENABLED`, default
off): this feature has a CONFIRMED history of breaking real live captures.
2026-09-23: two real YouTube live captures both cut off within ~60-90s of
starting (requested 7-8 min) as soon as this feature started opening a
SECOND, independent, concurrent connection to the same resolved stream_url
the primary recording was reading. The working theory: YouTube's live CDN
(googlevideo) tickets a signed manifest URL to a single session, and a
duplicate simultaneous reader is the likely trigger for the CDN throttling or
invalidating the session early -- killing the PRIMARY recording along with
it. An env var is one accidental flip (a copy-pasted systemd EnvironmentFile,
a debugging session, a future deploy) away from silently reintroducing
exactly that failure on a real event. Since the feature is now permanently
unneeded, removing it from the file entirely -- not just disabling it --
removes that risk for good rather than leaving it one mistake away.

If this is ever genuinely revived, it needs real re-integration work, not a
copy-paste back in: at minimum, re-verify the second-concurrent-connection
theory above and change the architecture to avoid a second reader of the
same signed live URL (e.g. tee the primary capture's own bytes instead of
opening an independent ffmpeg/HTTP session), and re-test against a real
live source before trusting it near anything that matters.

Originally: tools/basiq_agent.py, functions `build_audio_tee_cmd` and
`stream_live_transcript_to_deepgram`, plus the `LIVE_TRANSCRIPT_ENABLED` /
`_DEEPGRAM_LIVE_URL` / `_DEEPGRAM_AUDIO_CHUNK_BYTES` module-level constants
and the `websocket-client` import. Depends on basiq_agent.py's own
`find_ffmpeg`, `KIND_LISTENER`, `get_job`, `set_job`, `log`, and
`DEEPGRAM_API_KEY` -- none of those imports are set up here, they'd need to
be re-wired if this is ever restored.
"""

import json
import subprocess
import threading
import time
from typing import Callable
from urllib.parse import urlparse

try:
    import websocket as websocket_client  # the `websocket-client` package (import name: websocket)
except ImportError:
    websocket_client = None  # type: ignore[assignment]

# Off by default, independent of DEEPGRAM_API_KEY -- confirmed 2026-09-23 real
# capture: two real YouTube live captures both cut off within ~60-90s of
# starting (requested 7-8 min) as soon as this feature started opening a
# SECOND concurrent connection to the same resolved stream_url. YouTube's live
# CDN (googlevideo) tickets a signed manifest URL to a single session; a
# duplicate simultaneous reader is the likely trigger for the CDN throttling
# or invalidating the session early, killing the PRIMARY recording along with
# it. Batch (post-capture) Deepgram transcription above never touches the
# live stream_url and is unaffected. Do not re-enable until the live-tee path
# is proven safe against a real YouTube live source (or is changed to avoid a
# second concurrent connection to the same signed URL entirely).
LIVE_TRANSCRIPT_ENABLED = False


def build_audio_tee_cmd(
    stream_url: str,
    kind: str,
    headers: dict[str, str] | None = None,
    proxy: str | None = None,
    max_seconds: float = 0.0,
) -> list[str]:
    """Audio-only, raw 16kHz mono PCM piped to stdout -- a SECOND, independent
    reader of the same live stream_url build_capture_cmd uses, not a read of
    the .ts file that capture is writing to disk. Two independent viewers of
    the same live manifest is an ordinary thing for a stream to support;
    reading a file a different process is still actively writing, on a
    LucidLink mount, is the thing that was too risky to build (see the
    2026-08-31 decision to park mid-capture clipping over exactly that
    concern). Feeding this to Deepgram's real-time API sidesteps the question
    entirely for the live-transcript feed."""
    from basiq_agent import find_ffmpeg, KIND_LISTENER  # re-wire if revived

    cmd = [find_ffmpeg(), "-hide_banner", "-loglevel", "error", "-y"]
    if proxy:
        cmd += ["-http_proxy", proxy]
    if headers:
        cmd += ["-headers", "".join(f"{k}: {v}\r\n" for k, v in headers.items())]

    scheme = (urlparse(stream_url).scheme or "").lower()
    if scheme in ("http", "https"):
        cmd += ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "10"]
    if kind == KIND_LISTENER:
        cmd += ["-listen", "1"]

    cmd += ["-i", stream_url]
    if max_seconds and max_seconds > 0:
        # The primary capture (build_capture_cmd) stops at this same boundary
        # via its OWN -t flag, not by signaling stop_event -- without a
        # matching -t here, this process would keep reading a live stream
        # forever after the real recording has already finished.
        cmd += ["-t", f"{float(max_seconds):.3f}"]
    cmd += [
        "-vn", "-map", "0:a?",
        "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        "-f", "s16le",
        "pipe:1",
    ]
    return cmd


_DEEPGRAM_LIVE_URL = (
    "wss://api.deepgram.com/v1/listen"
    "?model=nova-3&smart_format=true&punctuate=true&interim_results=false"
    "&encoding=linear16&sample_rate=16000&channels=1"
)
_DEEPGRAM_AUDIO_CHUNK_BYTES = 8000  # 0.25s of 16kHz mono 16-bit PCM


def stream_live_transcript_to_deepgram(
    job_id: str,
    stream_url: str,
    kind: str,
    headers: dict[str, str] | None,
    proxy: str | None,
    should_stop: Callable[[], bool],
    max_seconds: float = 0.0,
) -> None:
    """Runs for the duration of a live capture, in its own daemon thread,
    entirely independent of the primary capture/remux path in run_live_capture.
    Any failure here -- ffmpeg can't reach the stream, the Deepgram connection
    drops, whatever -- is caught and logged, NEVER raised: losing the live
    transcript is a degraded experience, but it must never risk the actual
    recording, which is the one thing here that genuinely can't be redone.

    Appends each finalized utterance to the job's own `live_transcript` list
    as it arrives, polled the same way `seconds`/`bytes_written` already are
    during an ordinary capture (see run_live_capture's on_tick)."""
    from basiq_agent import get_job, set_job, log, DEEPGRAM_API_KEY  # re-wire if revived

    if websocket_client is None:
        log(f"[live-transcript] websocket-client not installed; skipping for job {job_id}")
        return
    if not DEEPGRAM_API_KEY:
        return

    cmd = build_audio_tee_cmd(stream_url, kind, headers, proxy, max_seconds)
    proc: subprocess.Popen | None = None
    ws = None
    watchdog_stop = threading.Event()
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

        # ffmpeg reading a live HLS source can block inside its own demuxer
        # waiting on the next segment if the source stalls, rather than
        # honoring the -t cutoff promptly -- confirmed locally: a source that
        # stopped advancing left the read loop below blocked indefinitely,
        # well past its own -t deadline. A kill from a SEPARATE thread is the
        # only thing that reliably unblocks a stuck blocking read(). 60s
        # grace past the normal -t cutoff, or a fixed safety cap when the
        # capture itself is uncapped (MAX MINS = 0), so this side-feature can
        # never hang indefinitely even though the primary capture is allowed
        # to.
        watchdog_deadline = (max_seconds + 60.0) if max_seconds and max_seconds > 0 else 4 * 3600.0

        def _watchdog() -> None:
            deadline = time.monotonic() + watchdog_deadline
            while time.monotonic() < deadline and not watchdog_stop.is_set() and not should_stop():
                time.sleep(1.0)
            try:
                proc.kill()
            except OSError:
                pass

        threading.Thread(target=_watchdog, daemon=True).start()

        ws = websocket_client.create_connection(
            _DEEPGRAM_LIVE_URL,
            header=[f"Authorization: Token {DEEPGRAM_API_KEY}"],
            timeout=10,
        )

        def _pump_transcripts() -> None:
            while True:
                try:
                    raw = ws.recv()
                except Exception:
                    return
                if not raw:
                    return
                try:
                    msg = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                if msg.get("type") != "Results" or not msg.get("is_final"):
                    continue
                alternatives = ((msg.get("channel") or {}).get("alternatives")) or [{}]
                text = (alternatives[0].get("transcript") or "").strip()
                if not text:
                    continue
                start = float(msg.get("start") or 0.0)
                duration = float(msg.get("duration") or 0.0)
                job = get_job(job_id) or {}
                live_transcript = list(job.get("live_transcript") or [])
                live_transcript.append({"start": start, "end": start + duration, "text": text})
                set_job(job_id, live_transcript=live_transcript)

        threading.Thread(target=_pump_transcripts, daemon=True).start()

        assert proc.stdout is not None
        while not should_stop():
            chunk = proc.stdout.read(_DEEPGRAM_AUDIO_CHUNK_BYTES)
            if not chunk:
                break
            ws.send_binary(chunk)
        try:
            ws.send(json.dumps({"type": "CloseStream"}))
        except Exception:
            pass
    except Exception as exc:
        log(f"[live-transcript] Deepgram streaming failed for job {job_id}: {exc}")
    finally:
        watchdog_stop.set()
        if ws is not None:
            try:
                ws.close()
            except Exception:
                pass
        if proc is not None:
            try:
                proc.kill()
            except OSError:
                pass
