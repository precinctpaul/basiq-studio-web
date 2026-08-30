"""
cspan_video_ingest.py — ingests the C-SPAN video files bulk_ingest.py can
never see.

WHY THIS EXISTS: bulk_ingest.py only picks up files with a matching
.info.json sidecar (the yt-dlp download-metadata format). C-SPAN content
was acquired through a completely different pipeline (the Kaldi-based
cspan_acquisition_core / HLS capture system), which never produces a
.info.json — confirmed directly against the file inventory: every single
C-SPAN video under Basiq-Studio-Hub has zero matching .info.json files.
That's not a bug in bulk_ingest.py, just a gap it was never built to cover.

WHAT IT DOES: scans Basiq-Studio-Hub for cspan_<program_id>-style video
files, extracts the program ID from the filename, and looks up the real
title from cspan_search.db's program_metadata table (923 known titles as
of the last check) — falling back to the raw filename if no metadata
entry exists for that program. Writes a video row in the same shape
bulk_ingest.py already uses, so every downstream script
(backfill_video_metadata.js for duration/resolution, cspan_import_
transcripts.py for transcripts, bulk_tag_buckets.py for tagging) just
works against these rows with zero changes needed.

SAFE TO RE-RUN: loads existing local_path values first and skips anything
already ingested — same guard bulk_ingest.py now has.

Run from tools/, with cspan_search.db in the same folder:

    python cspan_video_ingest.py
"""
import os
import re
import sqlite3
import uuid
from pathlib import Path

from supabase import create_client, Client

SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "https://tijwokimlrglufjqiwok.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

SCAN_TARGET = Path(r"C:\Volumes\md-pac\media\Archive\Basiq-Studio-Hub")
AGENT_MEDIA_ROOT = SCAN_TARGET  # the agent's MEDIA_ROOT points directly here
CSPAN_DB_PATH = Path("cspan_search.db")

PROGRAM_ID_RE = re.compile(r"cspan_(\d{5,7})", re.IGNORECASE)
VIDEO_EXTS = {".mp4", ".mkv", ".webm", ".m4v", ".mov", ".ts"}
PAGE_SIZE = 1000
BATCH_SIZE = 500


def fetch_existing_filenames(supabase: Client) -> set:
    """SAFE-TO-RERUN GUARD — this compares by FILENAME, not exact
    local_path. The project has two different local_path conventions in
    use (bare filename vs. the full Archive/Basiq-Studio-Hub/... prefix,
    depending on which script originally ingested a given row), and the
    same physical file can be recorded either way. An exact-string
    comparison would silently let duplicates through every time this
    script runs — which is exactly what happened the first time this
    script was used. Comparing by filename only closes that gap for good."""
    names = set()
    page = 0
    while True:
        res = (
            supabase.table("videos")
            .select("local_path")
            .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
            .execute()
        )
        batch = res.data or []
        for r in batch:
            lp = r.get("local_path")
            if lp:
                names.add(lp.split("/")[-1])
        if len(batch) < PAGE_SIZE:
            break
        page += 1
    return names


def load_titles(db_path: Path) -> dict:
    if not db_path.is_file():
        print(f"  WARNING: {db_path} not found — titles will fall back to filenames.")
        return {}
    db = sqlite3.connect(str(db_path))
    try:
        rows = db.execute("SELECT program_id, title FROM program_metadata").fetchall()
        return {str(pid): title for pid, title in rows if title}
    except sqlite3.OperationalError as e:
        print(f"  WARNING: couldn't read program_metadata ({e}) — titles will fall back to filenames.")
        return {}


def main():
    if not SUPABASE_KEY:
        print("SUPABASE_SERVICE_ROLE_KEY is not set (env var or hardcode above). Stopping.")
        return

    print("Connecting to Supabase...")
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

    print("Loading already-ingested filenames (so this is safe to re-run)...")
    existing_names = fetch_existing_filenames(supabase)
    print(f"  {len(existing_names)} videos already in the database.")

    print(f"Loading known program titles from {CSPAN_DB_PATH}...")
    titles = load_titles(CSPAN_DB_PATH)
    print(f"  {len(titles)} program titles available.")

    print(f"Scanning {SCAN_TARGET} for C-SPAN video files...")
    candidates = [
        p for p in SCAN_TARGET.rglob("*")
        if p.suffix.lower() in VIDEO_EXTS and PROGRAM_ID_RE.search(p.name)
    ]
    print(f"  Found {len(candidates)} C-SPAN video files on disk.")

    records = []
    inserted = 0
    skipped_existing = 0
    no_program_id = 0
    used_fallback_title = 0

    for path in candidates:
        try:
            local_path = path.relative_to(AGENT_MEDIA_ROOT).as_posix()
        except ValueError:
            continue

        if path.name in existing_names:
            skipped_existing += 1
            continue

        m = PROGRAM_ID_RE.search(path.name)
        if not m:
            no_program_id += 1
            continue
        program_id = m.group(1)

        title = titles.get(program_id)
        if not title:
            title = path.stem
            used_fallback_title += 1

        records.append({
            "id": str(uuid.uuid4()),
            "title": title,
            "duration_seconds": 0,  # backfill_video_metadata.js fills this in next
            "uploader": "C-SPAN",
            "channel": "C-SPAN",
            "status": "ready",
            "local_path": local_path,
            # Real air date isn't available from program_metadata (it only
            # has program_id + title) — fall back to the same default
            # bulk_ingest.py already uses for unknown dates, rather than
            # None, which violates this column's NOT NULL constraint.
            "created_at": "2024-01-01T00:00:00Z",
        })

        if len(records) >= BATCH_SIZE:
            try:
                supabase.table("videos").insert(records).execute()
                inserted += len(records)
                print(f"  ...{inserted} inserted so far")
            except Exception as e:
                print(f"  Batch insert failed: {e}")
            records = []

    if records:
        try:
            supabase.table("videos").insert(records).execute()
            inserted += len(records)
        except Exception as e:
            print(f"  Final batch insert failed: {e}")

    print("\nDone.")
    print(f"  Newly inserted:              {inserted}")
    print(f"  Already in DB (skipped):     {skipped_existing}")
    print(f"  No program ID extracted:     {no_program_id}")
    print(f"  Used filename as title (no metadata match): {used_fallback_title}")


if __name__ == "__main__":
    main()
