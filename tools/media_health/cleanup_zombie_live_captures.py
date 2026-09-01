"""
cleanup_zombie_live_captures.py -- one-off cleanup for the videos_local_path_key
bug (fixed in app/api/videos/route.ts + page.tsx): before that fix, every live
capture created TWO video rows sharing the same job_id-derived filename stem --
one made by the frontend the moment recording started (status='recording',
local_path='<jobid>.ts'), one made by basiq_agent.py's run_live_capture when
the capture finished (status='ready', local_path='<jobid>.mp4'). Any tags or
transcript generated during the live capture landed on the FIRST (stale) row,
while the SECOND (real, "ready") row -- the one you'd actually select in the
library -- has none of it.

This script finds those stale/ready pairs, moves the stale row's tags and
transcript (with its segments, automatically -- they key off transcript_id,
not video_id) onto the ready row, then deletes the stale row.

SAFETY PROPERTIES:
  - Dry-run by default. Nothing is written unless you pass --apply.
  - Only ever touches rows whose local_path basename matches a bare
    32-hex-char job-id filename (e.g. "702daa20318a4f0c90ffabb6f60377fd.ts").
    Grabbed videos, clips, and anything else (cspan_*.mp4, yt_*.mp4,
    clips/*.mp4, sanitized-title filenames) never match this pattern and are
    never touched, regardless of what else is going on in the library.
  - Only touches a "recording" row if it's older than --min-age-minutes
    (default 30) -- a capture that's *actually* still recording right now
    will never be mistaken for a zombie.
  - If MEDIA_ROOT is available, cross-checks the physical files before
    touching anything: the .ts must be GONE (remux deleted it) and the .mp4
    must EXIST. If that doesn't hold -- e.g. a failed remux left the .ts as
    the real final file -- the pair is skipped and reported, never guessed at.
    Without MEDIA_ROOT, this check is skipped entirely unless you pass
    --allow-unverified to explicitly accept that reduced safety margin.
  - If both rows in a pair already have their own transcript (should be
    rare -- the whole bug is that the ready row normally has none), the
    conflict is reported and left completely alone rather than auto-picked.
  - Tags are merged by label: a stale tag whose label already exists on the
    ready row is simply dropped (not duplicated); everything else is
    reassigned, never copied+left-behind.
  - Credentials come from SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in the
    environment only -- never hardcoded here.

Usage:
    python cleanup_zombie_live_captures.py                    (dry run, report only)
    python cleanup_zombie_live_captures.py --apply             (actually merge + delete)
    python cleanup_zombie_live_captures.py --min-age-minutes 5 --apply
"""
import argparse
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from supabase import create_client, Client

PAGE_SIZE = 1000
JOBID_STEM_RE = re.compile(r"^([0-9a-fA-F]{32})\.(ts|mp4)$")


def fetch_all(supabase: Client, table: str, columns: str) -> list:
    rows, page = [], 0
    while True:
        res = (
            supabase.table(table)
            .select(columns)
            .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
            .execute()
        )
        batch = res.data or []
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
        page += 1
    return rows


def find_pairs(videos: list, min_age_minutes: int) -> tuple[list, list]:
    """Groups videos by job-id filename stem. Returns (pairs, ambiguous),
    where each pair is (stale_row, ready_row) and ambiguous is a list of
    (stem, rows) that matched the filename pattern but didn't cleanly
    resolve to one stale + one ready row."""
    by_stem: dict[str, list] = {}
    for v in videos:
        local_path = v.get("local_path") or ""
        m = JOBID_STEM_RE.match(os.path.basename(local_path))
        if m:
            by_stem.setdefault(m.group(1), []).append(v)

    cutoff = datetime.now(timezone.utc) - timedelta(minutes=min_age_minutes)
    pairs, ambiguous = [], []

    for stem, rows in by_stem.items():
        if len(rows) != 2:
            ambiguous.append((stem, rows))
            continue

        ts_rows = [r for r in rows if (r.get("local_path") or "").endswith(".ts")]
        mp4_rows = [r for r in rows if (r.get("local_path") or "").endswith(".mp4")]
        if len(ts_rows) != 1 or len(mp4_rows) != 1:
            ambiguous.append((stem, rows))
            continue

        stale, ready = ts_rows[0], mp4_rows[0]
        if stale.get("status") != "recording" or ready.get("status") != "ready":
            ambiguous.append((stem, rows))
            continue

        created_at = stale.get("created_at") or ""
        try:
            created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        except ValueError:
            ambiguous.append((stem, rows))
            continue
        if created > cutoff:
            ambiguous.append((stem, rows))  # too recent -- could be a live capture right now
            continue

        pairs.append((stale, ready))

    return pairs, ambiguous


def verify_on_disk(media_root: str | None, stale: dict, ready: dict, allow_unverified: bool) -> str | None:
    """Returns None if safe to proceed, or a reason string if not."""
    if not media_root:
        if allow_unverified:
            return None
        return "no MEDIA_ROOT set -- pass --allow-unverified to proceed without checking disk"

    ts_path = Path(media_root) / stale["local_path"]
    mp4_path = Path(media_root) / ready["local_path"]

    if ts_path.exists():
        return f".ts still exists on disk ({ts_path}) -- remux may have failed; not a zombie, leaving alone"
    if not mp4_path.exists():
        return f".mp4 does not exist on disk ({mp4_path}) -- unexpected; leaving alone for manual review"
    return None


def merge_tags(supabase: Client, stale_id: str, ready_id: str, apply: bool) -> tuple[int, int]:
    stale_tags = (
        supabase.table("tags").select("id, label, kind").eq("video_id", stale_id).execute().data or []
    )
    ready_labels = {
        t["label"] for t in (
            supabase.table("tags").select("label").eq("video_id", ready_id).execute().data or []
        )
    }

    moved, dropped = 0, 0
    for tag in stale_tags:
        if tag["label"] in ready_labels:
            dropped += 1
            if apply:
                supabase.table("tags").delete().eq("id", tag["id"]).execute()
        else:
            moved += 1
            ready_labels.add(tag["label"])
            if apply:
                supabase.table("tags").update({"video_id": ready_id}).eq("id", tag["id"]).execute()
    return moved, dropped


def merge_transcript(supabase: Client, stale_id: str, ready_id: str, apply: bool) -> str:
    stale_t = (
        supabase.table("transcripts").select("id").eq("video_id", stale_id).execute().data or []
    )
    ready_t = (
        supabase.table("transcripts").select("id").eq("video_id", ready_id).execute().data or []
    )

    if not stale_t:
        return "no transcript on the stale row -- nothing to move"
    if ready_t:
        return "CONFLICT: both rows already have a transcript -- left both untouched, needs manual review"

    if apply:
        supabase.table("transcripts").update({"video_id": ready_id}).eq("id", stale_t[0]["id"]).execute()
    return "moved (segments follow automatically -- they key off transcript_id, not video_id)"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="actually write changes (default: dry run)")
    parser.add_argument("--min-age-minutes", type=int, default=30,
                         help="only touch a 'recording' row older than this (default 30)")
    parser.add_argument("--media-root", default=os.environ.get("MEDIA_ROOT"),
                         help="defaults to $MEDIA_ROOT; used to verify .ts is gone and .mp4 exists")
    parser.add_argument("--allow-unverified", action="store_true",
                         help="proceed even without a MEDIA_ROOT to check against (not recommended)")
    args = parser.parse_args()

    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not supabase_key:
        sys.exit("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.")

    supabase: Client = create_client(supabase_url, supabase_key)

    print("Fetching videos...")
    videos = fetch_all(supabase, "videos", "id, local_path, status, created_at, title")
    print(f"  {len(videos)} rows total.\n")

    pairs, ambiguous = find_pairs(videos, args.min_age_minutes)

    print(f"Found {len(pairs)} clean stale/ready pair(s), "
          f"{len(ambiguous)} job-id-shaped group(s) skipped as ambiguous.\n")

    if ambiguous:
        print("Skipped (ambiguous -- not touched):")
        for stem, rows in ambiguous:
            statuses = ", ".join(f"{r['id']}={r.get('status')}" for r in rows)
            print(f"  {stem}: {len(rows)} row(s) -- {statuses}")
        print()

    if not pairs:
        print("Nothing to clean up.")
        return

    for stale, ready in pairs:
        print(f"--- {stale.get('title')!r} ---")
        print(f"  stale (recording): {stale['id']}  {stale['local_path']}  created {stale.get('created_at')}")
        print(f"  ready:             {ready['id']}  {ready['local_path']}")

        disk_problem = verify_on_disk(args.media_root, stale, ready, args.allow_unverified)
        if disk_problem:
            print(f"  SKIPPED: {disk_problem}\n")
            continue

        moved, dropped = merge_tags(supabase, stale["id"], ready["id"], args.apply)
        print(f"  tags: {moved} moved, {dropped} dropped as duplicates of existing ready-row tags")

        transcript_result = merge_transcript(supabase, stale["id"], ready["id"], args.apply)
        print(f"  transcript: {transcript_result}")

        if "CONFLICT" in transcript_result:
            print("  NOT deleting stale row -- resolve the transcript conflict by hand first.\n")
            continue

        if args.apply:
            supabase.table("videos").delete().eq("id", stale["id"]).execute()
            print("  stale row deleted.\n")
        else:
            print("  (dry run -- stale row NOT deleted; re-run with --apply to actually clean this up)\n")

    if not args.apply:
        print("This was a dry run. Re-run with --apply to actually merge and delete.")


if __name__ == "__main__":
    main()
