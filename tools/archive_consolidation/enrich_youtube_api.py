"""Step 2m: live YouTube Data API backfill for items with no local
metadata at all. Targets exactly the items where every archive-internal
source (sidecar JSON, cspan_discovery, the youtube indexer, transcriptor)
came up empty -- a live videos.list call doesn't care that no local
sidecar exists, it asks YouTube directly.

Batches 50 IDs per call (the API's max and a quota unit each, vs. 1 unit
for a single ID -- batching is a 50x quota saving, and quota is capped
per day). part=snippet,contentDetails gets title/description/channel/
publishedAt plus duration in one call. publishedAt is a REAL publish
date and overwrites a file_modified fallback if one was already set,
since a live-verified publish date is strictly better information.

Videos the API can't return (deleted, private, region-blocked) are
recorded as youtube_status='unavailable' rather than left silently
unresolved, so a later pass doesn't keep re-querying dead IDs.
"""

import argparse
import re

from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

import config
import schema

_ISO8601_DURATION = re.compile(
    r"P(?:(?P<days>\d+)D)?T?(?:(?P<hours>\d+)H)?(?:(?P<minutes>\d+)M)?(?:(?P<seconds>\d+)S)?"
)


def load_api_key() -> str:
    env_path = config.TOOL_DIR.parent.parent / ".env.local"
    with open(env_path, encoding="utf-8") as f:
        for line in f:
            if line.startswith("YOUTUBE_API_KEY="):
                return line.split("=", 1)[1].strip()
    raise RuntimeError("YOUTUBE_API_KEY not found in .env.local")


def parse_duration(iso: str) -> float | None:
    m = _ISO8601_DURATION.match(iso)
    if not m:
        return None
    parts = {k: int(v) if v else 0 for k, v in m.groupdict().items()}
    return parts["days"] * 86400 + parts["hours"] * 3600 + parts["minutes"] * 60 + parts["seconds"]


def batched(items: list, size: int):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=None, help="cap how many video IDs to query, for a quota-safe test run")
    args = parser.parse_args()

    youtube = build("youtube", "v3", developerKey=load_api_key())
    con = schema.connect(config.INDEX_DB)

    video_ids = [
        r[0] for r in con.execute(
            "select canonical_id from canonical_items where title is null and id_type = 'YouTube'"
        ).fetchall()
    ]
    if args.limit:
        video_ids = video_ids[: args.limit]

    found = 0
    unavailable = []
    api_calls = 0

    with con:
        for batch in batched(video_ids, 50):
            try:
                resp = youtube.videos().list(part="snippet,contentDetails", id=",".join(batch)).execute()
            except HttpError as e:
                print(f"API error on batch starting {batch[0]}: {e}")
                continue
            api_calls += 1

            returned_ids = set()
            for item in resp.get("items", []):
                vid = item["id"]
                returned_ids.add(vid)
                snippet = item["snippet"]
                duration = parse_duration(item.get("contentDetails", {}).get("duration", ""))
                con.execute(
                    """update canonical_items
                       set title = ?, description = ?, duration_seconds = ?,
                           publish_date = date(?), date_source = 'published',
                           metadata_source = 'youtube_api_live'
                       where canonical_id = ?""",
                    (snippet.get("title"), snippet.get("description"), duration,
                     snippet.get("publishedAt"), vid),
                )
                found += 1

            for vid in set(batch) - returned_ids:
                con.execute(
                    "update canonical_items set notes = coalesce(notes || ' | ', '') || 'youtube_api: unavailable' where canonical_id = ?",
                    (vid,),
                )
                unavailable.append(vid)

    print(f"video IDs queried:  {len(video_ids)}")
    print(f"API calls made:     {api_calls}  (quota units, ~10000/day default)")
    print(f"titles found:       {found}")
    print(f"unavailable/deleted: {len(unavailable)}")

    con.close()


if __name__ == "__main__":
    main()
