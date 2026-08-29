"""
fix_cspan_titles.py -- backfills real C-SPAN program titles for the items
that never got one, using the live C-SPAN Archives API.

WHY THIS EXISTS: 482 Library videos were found with a placeholder title
identical to their raw filename or metadata id (2026-08-29). Of those, 258
already had a real title sitting unused in archive_items (a stale-export
gap, fixed separately by copying it straight across -- no API involved).
The remaining ones listed here genuinely have no real title ANYWHERE in
our data -- not in videos, not in archive_items, not even in the original
ingest's own metadata JSON sidecar (checked by hand against
cspan_632441.info.json: it says title="program.632441.tsc" too). The only
place a real title still exists is C-SPAN's own API.

Reuses tools/archive_consolidation/enrich_cspan_api.py's exact API-calling
convention (same auth header shape, same 1.2s throttle -- there's no batch
endpoint, one program per request) but targets a specific list of
canonical/archive_item ids passed in rather than that script's own
"title is null" scan, since these titles are non-null placeholders, not
nulls.

On a successful lookup this updates THREE places so nothing drifts back
out of sync:
  1. archive_items.title/description/duration_seconds/publish_date in
     Supabase (source of truth for the archive_consolidation side)
  2. videos.title in Supabase (what Library actually displays)
  3. canonical_items in the local SQLite index (so a future re-export
     doesn't undo this)

Input: a two-column TSV (video_id, archive_item_id), no header.

Run from the tools folder:
    python fix_cspan_titles.py path/to/pairs.tsv                (dry run)
    python fix_cspan_titles.py path/to/pairs.tsv --apply         (writes)
"""

import argparse
import os
import sys
import time

import requests
from supabase import create_client, Client

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "archive_consolidation"))
import config  # noqa: E402
import schema  # noqa: E402

API_ROOT = "https://api.c-spanarchives.org/2.0"

SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "https://tijwokimlrglufjqiwok.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
if not SUPABASE_KEY:
    raise SystemExit("SUPABASE_SERVICE_ROLE_KEY must be set in the environment (see .env.local).")


def load_api_key() -> str:
    env_path = config.TOOL_DIR.parent.parent / ".env.local"
    with open(env_path, encoding="utf-8") as f:
        for line in f:
            if line.startswith("CSPAN_API_KEY="):
                return line.split("=", 1)[1].strip()
    raise RuntimeError("CSPAN_API_KEY not found in .env.local")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pairs_file", help="TSV of video_id<TAB>archive_item_id, one per line")
    parser.add_argument("--apply", action="store_true", help="actually write updates (default: dry run, just queries the API and reports)")
    parser.add_argument("--delay", type=float, default=1.2)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    with open(args.pairs_file, encoding="utf-8") as f:
        pairs = [line.rstrip("\n").split("\t") for line in f if line.strip()]
    if args.limit:
        pairs = pairs[: args.limit]
    print(f"{len(pairs)} items to look up.")

    headers = {
        "Accept": "application/json",
        "User-Agent": "basiq-archive-consolidation/1.0",
        "X-API-Key": load_api_key(),
    }

    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
    con = schema.connect(config.INDEX_DB)

    found = 0
    not_found = []
    errors = []

    for i, (video_id, item_id) in enumerate(pairs):
        try:
            resp = requests.get(f"{API_ROOT}/programs/{item_id}", headers=headers, timeout=20)
        except requests.RequestException as e:
            errors.append((item_id, str(e)))
            continue

        if resp.status_code == 404:
            not_found.append(item_id)
        elif resp.status_code != 200:
            errors.append((item_id, f"HTTP {resp.status_code}"))
        else:
            data = resp.json()
            title = data.get("title")
            if not title:
                not_found.append(item_id)
            else:
                found += 1
                print(f"  {item_id} -> {title!r}")
                if args.apply:
                    supabase.table("archive_items").update({
                        "title": title,
                        "description": data.get("description"),
                        "duration_seconds": data.get("videoDuration"),
                        "publish_date": data.get("date"),
                        "date_source": "published",
                    }).eq("id", item_id).execute()
                    supabase.table("videos").update({"title": title}).eq("id", video_id).execute()
                    with con:
                        con.execute(
                            """update canonical_items
                               set title = ?, description = ?, duration_seconds = ?,
                                   publish_date = date(?), date_source = 'published',
                                   metadata_source = 'cspan_api_live',
                                   notes = coalesce(notes || ' | ', '') || 'source_url=' || ?
                               where canonical_id = ?""",
                            (title, data.get("description"), data.get("videoDuration"),
                             data.get("date"), data.get("videoLink"), item_id),
                        )

        if i < len(pairs) - 1:
            time.sleep(args.delay)

    con.close()

    print(f"\nqueried:   {len(pairs)}")
    print(f"found:     {found}")
    print(f"not found: {len(not_found)}  {not_found[:10]}")
    print(f"errors:    {len(errors)}  {errors[:5]}")
    if not args.apply:
        print("\nDry run -- re-run with --apply to write these to Supabase + the local index.")


if __name__ == "__main__":
    main()
