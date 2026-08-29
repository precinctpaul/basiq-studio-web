"""
import_archive_items_to_library.py -- brings archive_items into the videos
table so Library shows the same real video list Archive already knows about.

WHY THIS EXISTS: Library's videos table (5,912 rows) and the archive_items
table (9,032 rows) both describe files that live in the exact same place on
the shared drive (C:\\Volumes\\md-pac\\media\\Archive\\Basiq-Studio-Hub), but
videos was never fully synced with the later archive_consolidation ingest.
Confirmed directly against production media playback (2026-08-29): 2,331
archive_items have a real video file under that folder that videos.local_path
has no row for at all -- including hundreds of missing videos for people
Library ALREADY has folders for (Elissa Slotkin alone is missing 255), not
just new "notable figures" like Donald Trump (85 missing).

This is a step toward a SINGULAR schema: archive_items keeps existing (it's
still the richer, canonical record -- transcripts, legislation links, the
full people graph), but every video with a real, playable file also gets a
first-class row in `videos`, tagged with the exact same bucket taxonomy
bulk_tag_buckets.py just applied to the rest of the library, so Library's
existing UI, search, and playback all just work on it unmodified.

SCOPE: only archive_items with a video-role file whose full_path is
literally under Archive/Basiq-Studio-Hub are eligible. Some archive_items'
only file copy lives elsewhere (an old local-only ingest folder, or the
separate "Eluvio POC" project folder) -- those aren't reachable through the
agent's media root the way lib/agent.ts's agentMediaUrl() is wired today,
so they're deliberately left out rather than importing a row that would
404. Re-run this script later (unmodified) if those files ever get copied
into Basiq-Studio-Hub too -- it will pick them up automatically.

archive_item_files itself is a point-in-time index, not a live view of the
drive, and it drifts: confirmed directly (2026-08-29), running this without
a real filesystem check produced 1,062 broken rows out of an initial 2,331
-- files the index claimed were under Basiq-Studio-Hub but had actually
been moved, renamed, or cleaned up since the index was built. choose_video_
file() now checks the real file exists on THIS machine's LucidLink mount
before ever counting an item as eligible, which is why this has to run on
a machine with that drive mounted, not just anywhere with Supabase access.

MAPPING, per eligible archive_item:
  videos.title            <- archive_items.title
  videos.local_path       <- bare filename of the chosen video file (the
                             SAME convention as every other Library video;
                             agentMediaUrl() supplies the Archive/Basiq-
                             Studio-Hub prefix at read time)
  videos.duration_seconds <- archive_items.duration_seconds (0 if null)
  videos.source_url       <- archive_items.source_url (blank if null)
  videos.source_kind      <- 'local' (matches every other drive-backed row)
  videos.status           <- 'ready'
  videos.created_at       <- archive_items.publish_date at midnight UTC,
                             so "Date: Newest/Oldest" sorts real history
                             correctly instead of everything looking brand
                             new; left at its own default (now()) on the
                             rare item with no publish_date at all
  uploader/channel        <- left blank; archive_items has no equivalent
                             field, and LibraryPanel's row label already
                             handles a blank source cleanly

  tags (kind='bucket', source='manual', matching bulk_tag_buckets.py):
    - a matched primary_person_id classifies through the SAME roster
      bulk_tag_buckets.py uses (MB and Bench Members.txt, imported
      directly from there rather than re-typed) plus the person's own
      chamber column: Majority Democrats > The Bench > House > Senate >
      Notable Figures (catch-all), identical priority order.
    - no primary_person_id but is_institutional -> "Institutional".
    - neither -> no tag at all, same as every other Uncategorized video.
  tags (kind='person'): the matched person's full_name, when there is one.

  transcripts: OPT-IN via --with-transcripts. archive_item_transcripts.
  full_text, when present, copied into a transcripts row (source=
  'imported-srt') against the new video id, so the imported video doesn't
  regress to "no transcript" when Archive already had one. Off by default
  because full_text is large enough per row (some C-SPAN floor sessions
  run hours) that fetching it hits Supabase's own statement timeout unless
  filtered down to a small id list per request -- confirmed directly
  (2026-08-29): even 50-100 unfiltered rows took 50-90+ seconds each, so
  copying transcripts for a large batch is a real, separate time cost, not
  a free add-on. Segment-level timing is never copied either way: the
  archive_consolidation export never pushed transcript_segments to
  Supabase in the first place (2.7M+ rows, a separate project), so there's
  nothing to copy at that granularity regardless.

DEDUPE / IDEMPOTENCY: videos.local_path has a unique index (0005_local_
media.sql) -- the same physical file cannot produce two rows. This script
computes "eligible and not yet in videos" fresh every run, so it's safe to
re-run any time (after new files land in Basiq-Studio-Hub, for instance)
without creating duplicates. A handful of archive_items share the exact
same video file (a duplicate ingest of the same program); the first one
processed claims that filename, the rest are skipped and logged.

Run from the tools folder:
    python import_archive_items_to_library.py                       (dry run)
    python import_archive_items_to_library.py --limit 25 --apply    (small real test)
    python import_archive_items_to_library.py --apply                (the full run, videos + tags only)
    python import_archive_items_to_library.py --apply --with-transcripts   (also carries transcripts; slower)
"""

import argparse
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path, PureWindowsPath

from supabase import create_client, Client

import bulk_tag_buckets as buckets

SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "https://tijwokimlrglufjqiwok.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
if not SUPABASE_KEY:
    raise SystemExit("SUPABASE_SERVICE_ROLE_KEY must be set in the environment (see .env.local).")

HUB_PREFIX = (r"C:\Volumes\md-pac\media\Archive\Basiq-Studio-Hub" + "\\").lower()
HUB_DIR = Path(r"C:\Volumes\md-pac\media\Archive\Basiq-Studio-Hub")

PAGE_SIZE = 1000
WRITE_CHUNK = 500


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


def build_md_bench_lookup() -> dict:
    """{normalized_name: bucket_label} for exactly the two flat rosters in
    MB and Bench Members.txt -- the same file bulk_tag_buckets.py reads, so
    a person classifies identically here and there."""
    lookup = {}
    for bucket_label, names in buckets.parse_member_list(buckets.MEMBERS_TXT).items():
        for name in names:
            lookup[buckets.normalize_name(name)] = bucket_label
    return lookup


def classify_person(full_name: str, chamber: str | None, md_bench: dict) -> str:
    norm = buckets.normalize_name(full_name)
    if norm in md_bench:
        return md_bench[norm]
    if chamber == "House":
        return "House"
    if chamber == "Senate":
        return "Senate"
    return "Notable Figures"


def choose_video_file(candidates: list) -> str | None:
    """candidates: [(basename, quality_guess), ...], each claiming to live
    under Archive/Basiq-Studio-Hub per archive_item_files -- but that table
    is a point-in-time index, not a live view, and drifts: confirmed
    directly (2026-08-29), 1,062 of an initial 2,331-item import batch
    turned out to point at files no longer actually there (moved, renamed,
    or cleaned up since the index was built). This checks the real
    filesystem rather than trusting the row, and skips any candidate that
    isn't actually there. Among the ones that ARE, prefers a master over a
    proxy; otherwise just takes the first one found."""
    real_candidates = [(b, q) for b, q in candidates if (HUB_DIR / b).is_file()]
    for basename, quality in real_candidates:
        if quality == "master":
            return basename
    return real_candidates[0][0] if real_candidates else None


_thread_local = threading.local()


def _thread_client() -> Client:
    """A separate Supabase client per worker thread. The shared client's
    underlying httpx connection pool isn't safe for concurrent use here --
    confirmed directly (2026-08-29): sharing one client across
    ThreadPoolExecutor workers crashed with 'httpx.ReadError: [WinError
    10035] A non-blocking socket operation could not be completed
    immediately' partway through a real run. A client per thread sidesteps
    the shared connection pool entirely."""
    client = getattr(_thread_local, "client", None)
    if client is None:
        client = create_client(SUPABASE_URL, SUPABASE_KEY)
        _thread_local.client = client
    return client


def fetch_transcripts_parallel(
    archive_item_ids: list, chunk_size: int = 25, workers: int = 6, retries: int = 3
) -> dict:
    """{archive_item_id: full_text} for whichever of these ids have a
    non-empty transcript. Each request is filtered to a small id list --
    an unfiltered page of archive_item_transcripts hits Supabase's own
    statement timeout (confirmed directly, 2026-08-29: even 50-100
    unfiltered rows took 50-90+ seconds), because some rows (an hours-long
    floor session) carry a LOT of text. Chunking keeps each request's
    total payload small enough to finish quickly; running several chunks
    concurrently overlaps their network round-trips instead of paying
    that latency once per chunk in sequence. A chunk that still fails
    after retries is skipped and logged rather than crashing the run --
    re-running the whole script later picks up anything missed, since a
    video that ends up with no transcript row just looks like any other
    not-yet-backfilled one next time."""
    chunks = [archive_item_ids[i : i + chunk_size] for i in range(0, len(archive_item_ids), chunk_size)]
    result = {}
    done = 0
    failed_chunks = 0

    def fetch_chunk(chunk_ids):
        last_err = None
        for attempt in range(retries):
            try:
                res = (
                    _thread_client()
                    .table("archive_item_transcripts")
                    .select("archive_item_id, full_text")
                    .in_("archive_item_id", chunk_ids)
                    .execute()
                )
                return res.data or []
            except Exception as e:
                last_err = e
                time.sleep(1.5 * (attempt + 1))
        print(f"  chunk failed after {retries} attempts, skipping ({len(chunk_ids)} items): {last_err!r}")
        return None

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(fetch_chunk, c): c for c in chunks}
        for future in as_completed(futures):
            rows = future.result()
            done += 1
            if rows is None:
                failed_chunks += 1
            else:
                for row in rows:
                    if row.get("full_text"):
                        result[row["archive_item_id"]] = row["full_text"]
            print(f"  {done}/{len(chunks)} transcript batches fetched...")

    if failed_chunks:
        print(f"  {failed_chunks}/{len(chunks)} chunks failed even after retries -- re-run to pick those up.")

    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="actually insert rows (default: dry run, counts only)")
    parser.add_argument("--limit", type=int, default=0, help="only import the first N eligible items (for a small test run)")
    parser.add_argument("--with-transcripts", action="store_true",
                         help="also carry over archive_item_transcripts.full_text (much slower -- see docstring)")
    args = parser.parse_args()

    print("Connecting to Supabase...")
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

    print("Loading videos, archive_items, archive_item_files, people, transcripts...")
    videos = fetch_all(supabase, "videos", "id, local_path")
    existing_basenames = {(v.get("local_path") or "").split("/")[-1].split("\\")[-1].lower() for v in videos}
    video_id_by_basename = {
        (v.get("local_path") or "").split("/")[-1].split("\\")[-1].lower(): v["id"] for v in videos
    }
    transcribed_video_ids = {t["video_id"] for t in fetch_all(supabase, "transcripts", "video_id")}

    files = fetch_all(supabase, "archive_item_files", "archive_item_id, full_path, role, quality_guess")
    item_to_hub_files: dict = {}
    for f in files:
        if f.get("role") != "video":
            continue
        fp = f.get("full_path") or ""
        if fp.lower().startswith(HUB_PREFIX):
            item_to_hub_files.setdefault(f["archive_item_id"], []).append(
                (PureWindowsPath(fp).name, f.get("quality_guess"))
            )

    items = fetch_all(
        supabase, "archive_items",
        "id, title, publish_date, duration_seconds, source_url, is_institutional, primary_person_id",
    )
    people = fetch_all(supabase, "people", "id, full_name, chamber")
    people_by_id = {p["id"]: p for p in people}

    md_bench = build_md_bench_lookup()

    claimed_basenames = set(existing_basenames)
    plan = []
    skipped_duplicate_basename = 0
    skipped_no_basename = 0
    # archive_item_id -> video_id, for items already imported (in a previous
    # run, or earlier today) whose video has no transcript row yet. Only
    # acted on when --with-transcripts is passed.
    backfill_candidates: dict = {}

    for it in items:
        hub_files = item_to_hub_files.get(it["id"])
        if not hub_files:
            continue
        already_basename = next((b for b, _q in hub_files if b.lower() in existing_basenames), None)
        if already_basename:
            video_id = video_id_by_basename.get(already_basename.lower())
            if video_id and video_id not in transcribed_video_ids:
                backfill_candidates[it["id"]] = video_id
            continue

        basename = choose_video_file(hub_files)
        if not basename:
            skipped_no_basename += 1
            continue
        if basename.lower() in claimed_basenames:
            skipped_duplicate_basename += 1
            continue
        claimed_basenames.add(basename.lower())

        person = people_by_id.get(it["primary_person_id"]) if it.get("primary_person_id") else None
        if person:
            bucket_label = classify_person(person["full_name"], person.get("chamber"), md_bench)
        elif it.get("is_institutional"):
            bucket_label = "Institutional"
        else:
            bucket_label = None

        plan.append({
            "archive_item_id": it["id"],
            "title": it.get("title") or "Untitled",
            "local_path": basename,
            "duration_seconds": it.get("duration_seconds") or 0,
            "source_url": it.get("source_url") or "",
            "publish_date": it.get("publish_date"),
            "person_name": person["full_name"] if person else None,
            "bucket_label": bucket_label,
            "transcript_text": None,
        })

    if args.limit:
        plan = plan[: args.limit]
        backfill_candidates = dict(list(backfill_candidates.items())[: args.limit])

    backfill_transcript_inserts = []
    if args.with_transcripts:
        new_ids = [p["archive_item_id"] for p in plan]
        backfill_ids = list(backfill_candidates.keys())
        print(
            f"\nFetching transcripts for {len(new_ids)} new + {len(backfill_ids)} already-imported items "
            f"(parallelized, {len(new_ids) + len(backfill_ids)} total)..."
        )
        transcript_by_item = fetch_transcripts_parallel(new_ids + backfill_ids)
        for p in plan:
            p["transcript_text"] = transcript_by_item.get(p["archive_item_id"])
        for archive_item_id, video_id in backfill_candidates.items():
            text = transcript_by_item.get(archive_item_id)
            if text:
                backfill_transcript_inserts.append({
                    "video_id": video_id,
                    "source": "imported-srt",
                    "full_text": text,
                    "status": "ready",
                })

    print(f"\n{len(plan)} archive_items ready to import as new Library videos.")
    print(f"  skipped (duplicate filename within this batch): {skipped_duplicate_basename}")
    print(f"  skipped (no usable filename): {skipped_no_basename}")
    with_person = sum(1 for p in plan if p["person_name"])
    institutional = sum(1 for p in plan if not p["person_name"] and p["bucket_label"] == "Institutional")
    uncategorized = sum(1 for p in plan if not p["person_name"] and p["bucket_label"] is None)
    with_transcript = sum(1 for p in plan if p["transcript_text"])
    no_publish_date = sum(1 for p in plan if not p["publish_date"])
    print(f"  with a matched person: {with_person}")
    print(f"  institutional: {institutional}")
    print(f"  uncategorized: {uncategorized}")
    print(f"  carrying a transcript over: {with_transcript}")
    print(f"  with no publish_date (created_at will default to now()): {no_publish_date}")

    from collections import Counter
    bucket_counts = Counter(p["bucket_label"] for p in plan if p["bucket_label"])
    print("\n  by bucket:")
    for label, count in sorted(bucket_counts.items()):
        print(f"    {label}: {count}")

    if args.with_transcripts:
        print(f"\n{len(backfill_transcript_inserts)} already-imported videos will get a backfilled transcript.")

    if not args.apply:
        print("\nDry run -- re-run with --apply (add --limit N first for a small real test) to actually insert rows.")
        return

    print(f"\nInserting {len(plan)} videos in batches of {WRITE_CHUNK}...")
    inserted_videos = 0
    tag_rows = []
    transcript_inserts = []

    for i in range(0, len(plan), WRITE_CHUNK):
        chunk = plan[i : i + WRITE_CHUNK]
        video_records = []
        for p in chunk:
            record = {
                "title": p["title"],
                "local_path": p["local_path"],
                "duration_seconds": p["duration_seconds"],
                "source_url": p["source_url"],
                "source_kind": "local",
                "status": "ready",
            }
            if p["publish_date"]:
                record["created_at"] = f"{p['publish_date']}T00:00:00Z"
            video_records.append(record)

        res = supabase.table("videos").insert(video_records).execute()
        inserted_rows = res.data or []
        if len(inserted_rows) != len(chunk):
            raise SystemExit(
                f"Expected {len(chunk)} inserted video rows back, got {len(inserted_rows)} -- stopping "
                f"rather than risk mismatched tag/transcript rows. Nothing after this batch was written."
            )
        inserted_videos += len(inserted_rows)

        for p, row in zip(chunk, inserted_rows):
            video_id = row["id"]
            if p["bucket_label"]:
                tag_rows.append({"video_id": video_id, "label": p["bucket_label"], "source": "manual", "kind": "bucket"})
            if p["person_name"]:
                tag_rows.append({"video_id": video_id, "label": p["person_name"], "source": "manual", "kind": "person"})
            if p["transcript_text"]:
                transcript_inserts.append({
                    "video_id": video_id,
                    "source": "imported-srt",
                    "full_text": p["transcript_text"],
                    "status": "ready",
                })

        print(f"  inserted {inserted_videos}/{len(plan)} videos so far...")

    print(f"\nWriting {len(tag_rows)} bucket/person tags...")
    for i in range(0, len(tag_rows), WRITE_CHUNK):
        supabase.table("tags").insert(tag_rows[i : i + WRITE_CHUNK]).execute()

    all_transcript_inserts = transcript_inserts + backfill_transcript_inserts
    print(f"Writing {len(all_transcript_inserts)} transcripts ({len(transcript_inserts)} new, "
          f"{len(backfill_transcript_inserts)} backfilled onto already-imported videos)...")
    for i in range(0, len(all_transcript_inserts), WRITE_CHUNK):
        supabase.table("transcripts").insert(all_transcript_inserts[i : i + WRITE_CHUNK]).execute()

    print(f"\nDone. {inserted_videos} videos, {len(tag_rows)} tags, {len(all_transcript_inserts)} transcripts inserted.")


if __name__ == "__main__":
    main()
