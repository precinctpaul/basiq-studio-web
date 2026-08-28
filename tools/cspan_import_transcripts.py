"""
cspan_import_transcripts.py — imports real, speaker-attributed transcripts
for the 260 C-SPAN videos already sitting in the `videos` table.

WHAT IT DOES
    1. Finds videos whose local_path looks like a C-SPAN file (see
       CSPAN_PATH_HINT below).
    2. Extracts each one's C-SPAN program ID from local_path (see
       PROGRAM_ID_RE below — this is the one part I couldn't verify against
       real filenames, see "IMPORTANT" below).
    3. Looks up that program ID's lines in cspan_search.db's
       transcript_lines table: (program_id, seconds_offset, speaker, text).
    4. Writes one `transcripts` row + N `transcript_segments` rows per
       video, skipping any video that already has a transcript.

IMPORTANT — VERIFY BEFORE WRITING ANYTHING:
    I don't have a real example of what a C-SPAN video's local_path looks
    like, so PROGRAM_ID_RE below is a best-guess: it grabs the first run of
    5-7 digits in the filename (C-SPAN program IDs, per the project notes,
    look like 538253 — 6 digits). This script ALWAYS runs in preview mode
    first and refuses to write anything unless you pass --write, specifically
    so you can eyeball the extracted program IDs against the real
    local_path values before anything touches the database:

        python cspan_import_transcripts.py              # preview only
        python cspan_import_transcripts.py --write       # actually import

    If the preview's extracted IDs look wrong, send me 2-3 real local_path
    values and I'll fix PROGRAM_ID_RE / CSPAN_PATH_HINT in one edit.

SCHEMA NOTE — transcripts.source CHECK constraint:
    The project notes flagged that `transcripts.source` may have a CHECK
    constraint that doesn't yet allow 'imported-cspan'. This script probes
    that with the FIRST video only, before touching the rest — if it's
    rejected, it prints the exact SQL to inspect and fix the constraint,
    then stops (rather than failing identically 260 times).

SCHEMA NOTE — no end_seconds in the source data:
    transcript_lines only has a start offset (seconds_offset) per line, not
    a duration. Each segment's end_seconds is set to the next line's start
    (so segments butt up against each other); the last line in a program
    gets a flat LAST_LINE_PADDING_SECONDS added instead, since there's no
    "next" line to derive it from.

SAFE TO RE-RUN: loads which videos already have a transcript first and
skips them, same convention as bulk_import_transcripts.py.

Needs cspan_search.db in the same folder (or set CSPAN_DB_PATH below).
Run from the tools folder:

    python cspan_import_transcripts.py
    python cspan_import_transcripts.py --write
"""

import os
import re
import sqlite3
import sys
from pathlib import Path

from supabase import create_client, Client

# --- CONFIGURATION ---
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "https://tijwokimlrglufjqiwok.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

CSPAN_DB_PATH = Path(r"C:\dev\cspan_discovery\cspan_search.db")

# Heuristic for "is this video a C-SPAN video" — adjust if local_path
# doesn't actually contain this substring.
CSPAN_PATH_HINT = "cspan"

# ADJUST ME if the preview shows wrong extractions: grabs the first run of
# 5-7 digits anywhere in the filename. C-SPAN program IDs are ~6 digits
# (e.g. 538253) per the project notes.
PROGRAM_ID_RE = re.compile(r"(\d{5,7})")

TRANSCRIPT_SOURCE = "imported-cspan"
LAST_LINE_PADDING_SECONDS = 5.0

PAGE_SIZE = 1000


def fetch_all(supabase: Client, table: str, columns: str) -> list:
    rows, page = [], 0
    while True:
        res = supabase.table(table).select(columns).range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1).execute()
        batch = res.data or []
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
        page += 1
    return rows


def extract_program_id(local_path: str) -> str | None:
    stem = Path(local_path or "").stem
    m = PROGRAM_ID_RE.search(stem)
    return m.group(1) if m else None


def fetch_transcript_lines(db: sqlite3.Connection, program_id: str) -> list[tuple]:
    cur = db.execute(
        "SELECT seconds_offset, speaker, text FROM transcript_lines "
        "WHERE CAST(program_id AS TEXT) = ? ORDER BY seconds_offset",
        (program_id,),
    )
    return cur.fetchall()


def build_segments(lines: list[tuple]) -> list[dict]:
    """lines is [(seconds_offset, speaker, text), ...] ordered by offset.
    Each segment's end is the next line's start; the last line gets a flat
    padding since there's no real duration in the source data."""
    segments = []
    for i, (offset, speaker, text) in enumerate(lines):
        start = float(offset)
        if i + 1 < len(lines):
            end = float(lines[i + 1][0])
        else:
            end = start + LAST_LINE_PADDING_SECONDS
        speaker = (speaker or "").strip()
        text = (text or "").strip()
        if not text:
            continue
        full = f"{speaker}: {text}" if speaker else text
        segments.append({"start": start, "end": end, "text": full})
    return segments


def main():
    write_mode = "--write" in sys.argv

    if not SUPABASE_KEY:
        print("SUPABASE_SERVICE_ROLE_KEY is not set (env var or hardcode above). Stopping.")
        return

    if not CSPAN_DB_PATH.is_file():
        print(f"Can't find {CSPAN_DB_PATH.resolve()} — put cspan_search.db next to this script "
              f"or update CSPAN_DB_PATH.")
        return

    print("Connecting to Supabase...")
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

    print("Loading videos...")
    videos = fetch_all(supabase, "videos", "id, local_path")
    candidates = [v for v in videos if CSPAN_PATH_HINT in (v.get("local_path") or "").lower()]
    print(f"  {len(videos)} videos total, {len(candidates)} match the C-SPAN path hint ('{CSPAN_PATH_HINT}').")

    print("Loading existing transcripts (so we skip videos that already have one)...")
    existing = {t["video_id"] for t in fetch_all(supabase, "transcripts", "video_id")}
    print(f"  {len(existing)} videos already have a transcript from elsewhere.")

    print(f"Opening {CSPAN_DB_PATH}...")
    db = sqlite3.connect(str(CSPAN_DB_PATH))

    # --- Preview pass: extract + look up, write nothing yet ---
    rows_to_import = []  # (video, program_id, lines)
    no_id = already_has = no_lines = 0

    for v in candidates:
        if v["id"] in existing:
            already_has += 1
            continue
        program_id = extract_program_id(v.get("local_path"))
        if not program_id:
            no_id += 1
            print(f"  [no ID extracted] {v.get('local_path')}")
            continue
        lines = fetch_transcript_lines(db, program_id)
        if not lines:
            no_lines += 1
            print(f"  [id={program_id}, 0 lines in cspan_search.db] {v.get('local_path')}")
            continue
        print(f"  [id={program_id}, {len(lines)} lines] {v.get('local_path')}")
        rows_to_import.append((v, program_id, lines))

    print("\n--- Preview summary ---")
    print(f"  Candidates:                {len(candidates)}")
    print(f"  Already had a transcript:  {already_has}")
    print(f"  No program ID extracted:   {no_id}  (check PROGRAM_ID_RE if this is high)")
    print(f"  ID extracted, 0 DB lines:  {no_lines}  (check CAST/program_id format if this is high)")
    print(f"  Ready to import:           {len(rows_to_import)}")

    if not write_mode:
        print("\nPreview only — nothing written. Re-run with --write once the IDs above look right.")
        return

    if not rows_to_import:
        print("\nNothing to import — stopping.")
        return

    # --- Probe the source CHECK constraint with just the first video ---
    first_video, first_program_id, first_lines = rows_to_import[0]
    first_segments = build_segments(first_lines)
    full_text = " ".join(s["text"] for s in first_segments)
    try:
        ts_res = supabase.table("transcripts").insert({
            "video_id": first_video["id"],
            "source": TRANSCRIPT_SOURCE,
            "language": "en",
            "full_text": full_text,
            "status": "ready",
        }).execute()
    except Exception as e:
        msg = str(e)
        if "check constraint" in msg.lower() or "violates" in msg.lower():
            print(
                "\nThe 'transcripts' table rejected source='imported-cspan' — its CHECK "
                "constraint doesn't allow this value yet. Run this in the Supabase SQL "
                "editor to see the current constraint:\n\n"
                "  SELECT conname, pg_get_constraintdef(oid)\n"
                "  FROM pg_constraint\n"
                "  WHERE conrelid = 'transcripts'::regclass AND contype = 'c';\n\n"
                "Then add 'imported-cspan' to the allowed list, e.g.:\n\n"
                "  ALTER TABLE transcripts DROP CONSTRAINT <constraint_name_from_above>;\n"
                "  ALTER TABLE transcripts ADD CONSTRAINT <constraint_name_from_above>\n"
                "    CHECK (source IN ('whisper-local','imported-srt','imported-vtt','imported-cspan'));\n\n"
                "(Adjust the allowed-value list to match whatever's actually in the constraint "
                "definition the SELECT above shows you.) Then re-run this script with --write."
            )
            return
        print(f"\nFirst insert failed for an unrelated reason: {e}")
        return

    transcript_id = ts_res.data[0]["id"]
    segment_rows = [
        {"transcript_id": transcript_id, "idx": i, "start_seconds": s["start"], "end_seconds": s["end"], "text": s["text"]}
        for i, s in enumerate(first_segments)
    ]
    for i in range(0, len(segment_rows), 500):
        supabase.table("transcript_segments").insert(segment_rows[i:i + 500]).execute()

    imported = 1
    failed = 0
    print(f"  ...1/{len(rows_to_import)} imported")

    # --- Rest of the batch ---
    for v, program_id, lines in rows_to_import[1:]:
        try:
            segments = build_segments(lines)
            full_text = " ".join(s["text"] for s in segments)
            ts_res = supabase.table("transcripts").insert({
                "video_id": v["id"],
                "source": TRANSCRIPT_SOURCE,
                "language": "en",
                "full_text": full_text,
                "status": "ready",
            }).execute()
            transcript_id = ts_res.data[0]["id"]
            segment_rows = [
                {"transcript_id": transcript_id, "idx": i, "start_seconds": s["start"], "end_seconds": s["end"], "text": s["text"]}
                for i, s in enumerate(segments)
            ]
            for i in range(0, len(segment_rows), 500):
                supabase.table("transcript_segments").insert(segment_rows[i:i + 500]).execute()
            imported += 1
            if imported % 50 == 0:
                print(f"  ...{imported}/{len(rows_to_import)} imported")
        except Exception as e:
            print(f"  FAILED on video {v['id']} (program {program_id}): {e}")
            failed += 1

    print("\nDone.")
    print(f"  Imported this run: {imported}")
    print(f"  Failed:            {failed}")


if __name__ == "__main__":
    main()
