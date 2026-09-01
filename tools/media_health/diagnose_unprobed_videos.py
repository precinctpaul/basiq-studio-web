"""
diagnose_unprobed_videos.py -- read-only diagnostic for the "354-video
staging pile": videos in the `videos` table with no probe data
(duration_seconds still 0/null), which basiq_agent.py's own probe pipeline
was supposed to fill in automatically but hasn't, for one of two very
different reasons:

  1. The file sits in a SUBFOLDER of MEDIA_ROOT (e.g.
     media-intelligence/high-res/, low-res/) -- scan_media() in
     basiq_agent.py only globs the TOP LEVEL of MEDIA_ROOT
     (root.glob("*"), not root.rglob("*")), so a file living in a
     subfolder is never even discovered by the scan that queues background
     probing. No amount of waiting fixes this -- it's structurally
     unreachable until the file is moved to the flat root, scan_media()
     is made recursive, or something probes it directly instead.

  2. The file sits in the FLAT ROOT and should be reachable, but hasn't
     been probed yet -- the agent's probe worker is single-threaded (one
     background thread, one ffprobe subprocess at a time) and its cache
     lives only in memory, wiped clean by every agent restart. A large or
     recently-restarted library can genuinely take a long time to catch
     up, especially over a network-mounted drive like LucidLink, where
     each ffprobe call pays real round-trip latency.

This script reports the SHAPE of the pile, not just its size, by splitting
unprobed videos into those two buckets -- plus a third, if --media-root is
given: rows whose local_path doesn't resolve to a real file on disk at all,
a different and more concerning problem than either of the above.

SAFETY: read-only throughout. Never writes to Supabase or touches any file.

Usage:
    python diagnose_unprobed_videos.py
    python diagnose_unprobed_videos.py --media-root "C:\\Volumes\\md-pac\\media\\Archive\\Basiq-Studio-Hub"
"""
import argparse
import os
import sys
from pathlib import Path

from supabase import create_client, Client

PAGE_SIZE = 1000


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


def classify_reachability(local_path: str) -> str:
    """A forward slash means the path has a directory component --
    scan_media() only globs the top level of MEDIA_ROOT, so anything with
    a "/" in it (media-intelligence/high-res/..., clips/..., etc.) is
    never discovered by that scan at all."""
    return "subfolder" if "/" in local_path else "flat_root"


def sample(rows: list, n: int = 8) -> None:
    for v in rows[:n]:
        print(f"    {v['id']}  {(v.get('title') or '')!r:50}  {v['local_path']}")
    if len(rows) > n:
        print(f"    ... and {len(rows) - n} more")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--media-root", default=os.environ.get("MEDIA_ROOT"),
                         help="if given, also checks whether each file actually exists on disk")
    args = parser.parse_args()

    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not supabase_key:
        sys.exit("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.")

    supabase: Client = create_client(supabase_url, supabase_key)

    print("Fetching videos...")
    videos = fetch_all(
        supabase, "videos",
        "id, title, local_path, status, duration_seconds, width, height, vcodec, acodec, size_bytes, created_at",
    )
    print(f"  {len(videos)} rows total.\n")

    unprobed = [
        v for v in videos
        if not v.get("duration_seconds") and (v.get("local_path") or "").strip()
    ]
    print(f"Unprobed (duration_seconds is 0/null, has a local_path): {len(unprobed)}\n")

    flat_root = [v for v in unprobed if classify_reachability(v["local_path"]) == "flat_root"]
    subfolder = [v for v in unprobed if classify_reachability(v["local_path"]) == "subfolder"]

    print(f"  Flat root (reachable by the agent's scan, just not probed yet): {len(flat_root)}")
    print(f"  In a subfolder (NOT reachable by scan_media() at all):          {len(subfolder)}")

    missing_on_disk = []
    if args.media_root:
        media_root = Path(args.media_root)
        print(f"\nChecking against disk at {media_root} ...")
        for v in unprobed:
            full_path = media_root / v["local_path"]
            if not full_path.is_file():
                missing_on_disk.append(v)
        print(f"  Checked {len(unprobed)} files.")
        print(f"  Missing on disk entirely (dangling DB row, a different problem): {len(missing_on_disk)}")
    else:
        print("\n  (pass --media-root to also check whether these files exist on disk at all)")

    if subfolder:
        print("\nSample of subfolder-stuck videos (structurally unreachable until moved/fixed):")
        sample(subfolder)

    if flat_root:
        print("\nSample of flat-root videos (should self-heal with a faster/rescanned probe worker):")
        sample(flat_root)

    if missing_on_disk:
        print("\nSample of videos whose local_path doesn't exist on disk at all:")
        sample(missing_on_disk)

    print(f"\n{'=' * 70}")
    print("SUMMARY — nothing was modified")
    print(f"{'=' * 70}")
    print(f"  Total unprobed          : {len(unprobed)}")
    print(f"  Flat root (self-healing) : {len(flat_root)}")
    print(f"  Subfolder (stuck)        : {len(subfolder)}")
    if args.media_root:
        print(f"  Missing on disk          : {len(missing_on_disk)}")


if __name__ == "__main__":
    main()
