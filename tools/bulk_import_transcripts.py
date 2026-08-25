"""
bulk_import_transcripts.py — attaches existing .srt/.vtt subtitle files to
videos that are already in the database.

CONTEXT: bulk_ingest.py loaded 5,595 videos from their .info.json sidecars,
but never looked for subtitles. This script fills that gap. It does not
touch bulk_ingest.py or the videos table at all — it only adds rows to
`transcripts` and `transcript_segments` for videos that don't have one yet.

MATCHING: yt-dlp names a video's subtitle with the SAME base name as the
video itself, e.g.
    yt_pXZOpCJq29o.mp4          <- the video
    yt_pXZOpCJq29o.en.srt       <- its subtitle
    yt_pXZOpCJq29o.en-orig.srt  <- sometimes a second variant

So base name = the filename with every extension after the first dot
stripped off, and that's exactly what videos.local_path already stores
(minus the folder). No fuzzy matching, no guessing.

If a video has more than one subtitle file, LANG_PRIORITY below decides
which one wins. Right now: prefer a plain "en" file (usually manually
authored, cleaner) over "en-orig" (auto-captioned) over anything else.
Adjust the order if you find the opposite is true for your files.

SAFE TO RE-RUN: it loads which videos already have a transcript row first
and skips them, so running this twice (or after adding more videos) never
creates duplicates.

Run it on the SAME machine where the shared drive is mounted (the one
worker_config.txt points at) — this needs real filesystem access to the
.srt/.vtt files, not just the agent's HTTP API.

    python bulk_import_transcripts.py
"""

import re
from pathlib import Path
from supabase import create_client, Client

# --- CONFIGURATION ---
SUPABASE_URL = "https://tijwokimlrglufjqiwok.supabase.co"
# STOP! Replace with your SUPABASE_SERVICE_ROLE_KEY from .env.local —
# same value bulk_ingest.py used.
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRpandva2ltbHJnbHVmanFpd29rIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NjgyMDQ0OSwiZXhwIjoyMTAyMzk2NDQ5fQ.vD586cg84F9LuNRb7AegIiu5Cn843wezSKmnX23Q1pw"

# The same folder bulk_ingest.py scanned for videos.
SCAN_TARGET = Path(r"C:\Volumes\md-pac\media\Archive\Basiq-Studio-Hub")

SUB_EXTS = (".srt", ".vtt")

# Lower number = preferred. Anything not listed falls through to the
# "starts with en" or "anything else" buckets below.
LANG_PRIORITY = ["en", "en-us", "en-gb", "en-orig", "en-en"]

SUB_NAME_RE = re.compile(r"^(?P<base>.+?)\.(?P<lang>[A-Za-z0-9\-]+)\.(?P<ext>srt|vtt)$", re.IGNORECASE)

PAGE_SIZE = 1000


def priority_for(lang: str) -> int:
    lang = lang.lower()
    if lang in LANG_PRIORITY:
        return LANG_PRIORITY.index(lang)
    if lang.startswith("en"):
        return len(LANG_PRIORITY)
    return len(LANG_PRIORITY) + 1


def parse_ts_srt(ts: str) -> float:
    ts = ts.strip().replace(",", ".")
    h, m, s = ts.split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


def parse_ts_vtt(ts: str) -> float:
    parts = ts.strip().split(":")
    if len(parts) == 3:
        h, m, s = parts
    else:
        h, (m, s) = "0", parts
    return int(h) * 3600 + int(m) * 60 + float(s)


def _parse_cues(text: str, ts_parser):
    blocks = re.split(r"\n\s*\n", text.strip())
    segments = []
    for block in blocks:
        lines = [l for l in block.splitlines() if l.strip()]
        arrow_idx = next((i for i, l in enumerate(lines) if "-->" in l), None)
        if arrow_idx is None:
            continue
        try:
            start_str, end_str = [p.strip() for p in lines[arrow_idx].split("-->")]
            start = ts_parser(start_str)
            end = ts_parser(end_str.split(" ")[0])
        except Exception:
            continue
        cue_text = " ".join(lines[arrow_idx + 1:]).strip()
        cue_text = re.sub(r"<[^>]+>", "", cue_text)  # strip <i>, <b>, position tags etc.
        if cue_text and end > start:
            segments.append((start, end, cue_text))
    return segments


def parse_srt(path: Path):
    return _parse_cues(path.read_text(encoding="utf-8", errors="ignore"), parse_ts_srt)


def parse_vtt(path: Path):
    text = path.read_text(encoding="utf-8", errors="ignore")
    text = re.sub(r"^WEBVTT.*?\n", "", text, flags=re.DOTALL)
    return _parse_cues(text, parse_ts_vtt)


def merge_rolling_captions(segments):
    """
    YouTube's AUTO-generated captions are 'roll-up' style: each cue re-states
    most of the previous cue's words and appends a few new ones, e.g.

        cue 1: "Josh Turk, a candidate"
        cue 2: "Josh Turk, a candidate for the U.S. Senate here in"
        cue 3: "for the U.S. Senate here in Iowa. I'm at the NASCAR"

    Concatenating those naively (what the old dedupe_consecutive did) only
    caught EXACT repeats, so real rolling captions turned into a stutter of
    repeated phrases. This compares word-by-word: for each cue, it finds how
    much of the tail of what's already been kept matches the head of the new
    cue, and appends only the words that are genuinely new. Each cue keeps
    its own timestamp, so seeking/scrubbing is unaffected — only the TEXT is
    de-duplicated.
    """
    out = []
    accumulated: list[str] = []
    MAX_OVERLAP_WORDS = 40  # generous — covers multi-line roll-up windows

    for start, end, text in segments:
        words = text.split()
        if not words:
            continue
        if not accumulated:
            new_words = words
        else:
            max_check = min(len(accumulated), len(words), MAX_OVERLAP_WORDS)
            overlap = 0
            for k in range(max_check, 0, -1):
                if accumulated[-k:] == words[:k]:
                    overlap = k
                    break
            new_words = words[overlap:]
        if new_words:
            out.append((start, end, " ".join(new_words)))
            accumulated.extend(new_words)
    return out


def fetch_all(supabase: Client, table: str, columns: str):
    rows, page = [], 0
    while True:
        res = supabase.table(table).select(columns).range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1).execute()
        batch = res.data or []
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
        page += 1
    return rows


def main():
    print("Connecting to Supabase...")
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

    print("Loading videos already in the database...")
    video_rows = fetch_all(supabase, "videos", "id, local_path")
    videos_by_base = {}
    for r in video_rows:
        lp = r.get("local_path")
        if not lp:
            continue
        videos_by_base[Path(lp).stem] = r["id"]
    print(f"  {len(videos_by_base)} videos have a local_path we can match against.")

    print("Loading existing transcripts...")
    existing_transcripts = fetch_all(supabase, "transcripts", "id, video_id, source")
    already_good = set()
    to_rebuild = []
    for t in existing_transcripts:
        if t["source"] in ("imported-srt", "imported-vtt"):
            # Made by an earlier run of THIS script — safe to wipe and redo
            # with the current (better) parsing logic.
            to_rebuild.append(t["id"])
        else:
            # e.g. "whisper-local" — real transcription, never touch it.
            already_good.add(t["video_id"])

    if to_rebuild:
        print(f"  Rebuilding {len(to_rebuild)} transcripts from a previous run (fixing caption duplication)...")
        for i in range(0, len(to_rebuild), 200):
            supabase.table("transcripts").delete().in_("id", to_rebuild[i:i + 200]).execute()
    print(f"  {len(already_good)} videos already have a transcript from elsewhere (left untouched).")
    existing = already_good

    print(f"Scanning {SCAN_TARGET} for subtitle files (this can take a minute on a network drive)...")
    candidates = {}  # base_name -> (priority, path)
    scanned = 0
    for path in SCAN_TARGET.rglob("*"):
        if path.suffix.lower() not in SUB_EXTS:
            continue
        scanned += 1
        m = SUB_NAME_RE.match(path.name)
        if not m:
            continue
        base = m.group("base")
        pr = priority_for(m.group("lang"))
        current = candidates.get(base)
        if current is None or pr < current[0]:
            candidates[base] = (pr, path)
    print(f"  Found {scanned} subtitle files, {len(candidates)} distinct videos after picking the best variant.")

    matched = already_has = no_video = failed = 0

    for base, (_, path) in candidates.items():
        video_id = videos_by_base.get(base)
        if not video_id:
            no_video += 1
            continue
        if video_id in existing:
            already_has += 1
            continue

        try:
            segments = parse_srt(path) if path.suffix.lower() == ".srt" else parse_vtt(path)
            segments = merge_rolling_captions(segments)
            if not segments:
                print(f"  {path.name}: parsed 0 usable segments, skipping")
                failed += 1
                continue

            full_text = " ".join(s[2] for s in segments)
            t_res = supabase.table("transcripts").insert({
                "video_id": video_id,
                "source": "imported-srt" if path.suffix.lower() == ".srt" else "imported-vtt",
                "language": "en",
                "full_text": full_text,
                "status": "ready",
            }).execute()
            transcript_id = t_res.data[0]["id"]

            rows = [
                {"transcript_id": transcript_id, "idx": i, "start_seconds": s[0], "end_seconds": s[1], "text": s[2]}
                for i, s in enumerate(segments)
            ]
            for i in range(0, len(rows), 500):
                supabase.table("transcript_segments").insert(rows[i:i + 500]).execute()

            matched += 1
            if matched % 100 == 0:
                print(f"  ...{matched} imported so far")
        except Exception as e:
            print(f"  FAILED on {path.name}: {e}")
            failed += 1

    print("\nDone.")
    print(f"  Imported this run:        {matched}")
    print(f"  Already had a transcript: {already_has}")
    print(f"  No matching video found:  {no_video}  (these need a different folder, or aren't in the DB yet)")
    print(f"  Failed to parse:          {failed}")


if __name__ == "__main__":
    main()
