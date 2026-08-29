"""Re-queries the items enrich_youtube_api.py already resolved, this time
keeping snippet.channelId/channelTitle -- the first pass threw those away,
but they're exactly the signal needed to attribute a video like "In Floor
Speech, Bennet Speaks On His Bill..." to Michael Bennet when the title
alone doesn't spell out his full name: if it's uploaded to his own
official channel, that's very strong evidence regardless of title wording.
"""

from googleapiclient.discovery import build

import config
import schema


def batched(items: list, size: int):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def load_api_key() -> str:
    env_path = config.TOOL_DIR.parent.parent / ".env.local"
    with open(env_path, encoding="utf-8") as f:
        for line in f:
            if line.startswith("YOUTUBE_API_KEY="):
                return line.split("=", 1)[1].strip()
    raise RuntimeError("YOUTUBE_API_KEY not found in .env.local")


def main():
    youtube = build("youtube", "v3", developerKey=load_api_key())
    con = schema.connect(config.INDEX_DB)

    video_ids = [
        r[0] for r in con.execute(
            "select canonical_id from canonical_items "
            "where id_type = 'YouTube' and metadata_source = 'youtube_api_live' "
            "and youtube_channel_id is null"
        ).fetchall()
    ]

    updated = 0
    api_calls = 0
    with con:
        for batch in batched(video_ids, 50):
            resp = youtube.videos().list(part="snippet", id=",".join(batch)).execute()
            api_calls += 1
            for item in resp.get("items", []):
                snippet = item["snippet"]
                con.execute(
                    "update canonical_items set youtube_channel_id = ?, youtube_channel_title = ? where canonical_id = ?",
                    (snippet.get("channelId"), snippet.get("channelTitle"), item["id"]),
                )
                updated += 1

    print(f"video IDs targeted: {len(video_ids)}")
    print(f"API calls made:     {api_calls}")
    print(f"channel info stored: {updated}")

    print("\ntop channels by video count:")
    for row in con.execute(
        "select youtube_channel_title, count(*) from canonical_items "
        "where youtube_channel_title is not null group by 1 order by 2 desc limit 20"
    ):
        print(f"  {row[1]:4d}  {row[0]}")

    con.close()


if __name__ == "__main__":
    main()
