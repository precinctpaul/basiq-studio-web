"""One-off: transcribe the 275 Library videos confirmed to genuinely need it
(2026-09-08) -- already excludes the 90 long-recording (4hr+) and 127
"no speech detected" (likely audio-extraction bug) videos from that day's
audit, so this only touches the population expected to complete cleanly.

Imports basiq_agent.py directly and calls its own run_transcribe() -- same
approach as the 2026-08-31 backfill (see HANDOFF.md): does its own direct
Supabase writes (transcript + segments + tags), no droplet/HTTP involved,
runs on this machine instead of the resource-constrained droplet.

Benchmarked config from that same prior run, reused as-is: WHISPER_NUM_WORKERS=4,
WHISPER_CPU_THREADS=2 (matches this machine's 8 physical cores), concurrency=4 --
51s/video average on similar-length files. basiq_agent.py's own
MAX_CONCURRENT_TRANSCRIBES=2 still caps actual whisper inference at 2 genuinely
concurrent jobs; the extra worker threads just keep the queue fed so a slot
never sits idle between jobs.

Usage:
    python transcribe_remaining.py --limit 5          (small real test)
    python transcribe_remaining.py                    (the full 275)
"""

import argparse
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

os.environ.setdefault("WHISPER_NUM_WORKERS", "4")
os.environ.setdefault("WHISPER_CPU_THREADS", "2")

# Crashed the whole batch overnight (2026-09-08) on video #47: this console's
# default cp1252 encoding can't represent every character a real video title
# can contain (an em-dash, a smart quote, ...), and print() raising mid-batch
# took the entire process down with it -- 46 good transcriptions lost their
# runner for no reason related to transcription at all. Force UTF-8 with a
# safe fallback so one unprintable title never kills the run again.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).parent))
import basiq_agent as agent

# Default paths point at a Claude session's temp scratchpad, which is
# ephemeral and can disappear once that session ends (this is why the
# 2026-09-08 run's own list/log had to get copied into
# tools/session-2026-09-08/ to survive) -- pass --list/--log/--progress to
# point at a durable location for any run meant to outlive one session.
LOG_PATH = Path(r"C:\Users\plcon\AppData\Local\Temp\claude\C--dev-basiq-studio-web\da613f49-68dd-48f7-9c45-4b0b2d2c7cbc\scratchpad\transcribe-remaining.log")
LIST_PATH = Path(r"C:\Users\plcon\AppData\Local\Temp\claude\C--dev-basiq-studio-web\da613f49-68dd-48f7-9c45-4b0b2d2c7cbc\scratchpad\genuinely-remaining.json")
PROGRESS_JSON = Path(r"C:\Users\plcon\AppData\Local\Temp\claude\C--dev-basiq-studio-web\da613f49-68dd-48f7-9c45-4b0b2d2c7cbc\scratchpad\transcribe-remaining-progress.json")

_lock = threading.Lock()
_progress = {"total": 0, "done": 0, "ok": 0, "failed": 0, "started_at": time.time(), "current": []}


def log(line: str) -> None:
    msg = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {line}"
    print(msg, flush=True)
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(msg + "\n")
        f.flush()


def write_progress() -> None:
    with open(PROGRESS_JSON, "w", encoding="utf-8") as f:
        json.dump(_progress, f)


def transcribe_one(video: dict) -> tuple[str, bool, str]:
    video_id = video["id"]
    local_path = video.get("local_path") or ""
    with _lock:
        _progress["current"].append(video_id)
        write_progress()
    try:
        agent.run_transcribe(job_id=video_id, url="", rel=local_path, start_seconds=0.0, language=agent.DEFAULT_LANGUAGE)
        # Don't trust "no exception raised" alone -- confirmed directly
        # (2026-09-09) that a bug inside run_transcribe's own DB-write step
        # can crash, get caught by ITS OWN broad except-and-log block, and
        # never propagate here at all, while this function still returns
        # normally. Verify a transcript row genuinely landed before calling
        # it a success.
        check = agent._db_request("transcripts", method="GET", params=f"?video_id=eq.{video_id}&select=id")
        if not check:
            return video_id, False, "run_transcribe returned normally but no transcript row exists -- check basiq_agent's own [transcribe ERROR] log line for the real cause"
        return video_id, True, ""
    except Exception as e:
        return video_id, False, str(e)
    finally:
        with _lock:
            _progress["current"].remove(video_id)


def main():
    global LOG_PATH, PROGRESS_JSON

    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--list", type=Path, default=LIST_PATH)
    parser.add_argument("--log", type=Path, default=LOG_PATH)
    parser.add_argument("--progress", type=Path, default=PROGRESS_JSON)
    args = parser.parse_args()

    LOG_PATH = args.log
    PROGRESS_JSON = args.progress

    videos = json.loads(args.list.read_text(encoding="utf-8"))

    # Resume-safe: re-check who actually still needs one rather than trusting
    # last run's static list -- last run got 46 done before crashing on an
    # unrelated print() bug (see fix above), and blindly redoing those would
    # waste real compute for no reason.
    import urllib.request
    already_ids = set()
    offset = 0
    while True:
        req = urllib.request.Request(
            f"{agent.SUPABASE_URL}/rest/v1/transcripts?select=video_id&limit=1000&offset={offset}",
            headers={"apikey": agent.SUPABASE_KEY, "Authorization": f"Bearer {agent.SUPABASE_KEY}"},
        )
        batch = json.loads(urllib.request.urlopen(req).read())
        already_ids.update(row["video_id"] for row in batch)
        if len(batch) < 1000:
            break
        offset += 1000
    before = len(videos)
    videos = [v for v in videos if v["id"] not in already_ids]
    print(f"resume check: {before - len(videos)} already done since the list was built, {len(videos)} left", flush=True)

    if args.limit:
        videos = videos[: args.limit]

    _progress["total"] = len(videos)
    write_progress()
    log(f"=== starting transcription of {len(videos)} videos, concurrency={args.concurrency} ===")

    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = {pool.submit(transcribe_one, v): v for v in videos}
        for future in as_completed(futures):
            v = futures[future]
            video_id, ok, err = future.result()
            with _lock:
                _progress["done"] += 1
                if ok:
                    _progress["ok"] += 1
                else:
                    _progress["failed"] += 1
                write_progress()
            status = "OK" if ok else f"FAILED: {err}"
            log(f"[{_progress['done']}/{_progress['total']}] {video_id} ({v.get('title','')[:60]}): {status}")

    log(f"=== DONE: {_progress['ok']} ok, {_progress['failed']} failed, out of {_progress['total']} ===")


if __name__ == "__main__":
    main()
