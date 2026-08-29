"""Step 2b: enrich YouTube canonical items from cspan-youtube-indexer.

cspan-youtube-indexer tracks 2,403 videos with title/description/
published_date/duration, of which 921 overlap with registry YouTube
canonical items (checked directly). Its own copies live on a Google Drive
path (H:\\...\\CSPAN YouTube\\<id>\\proxy.mp4), which is out of scope as a
*file* source -- confirmed every one of those 921 items already has a
known video file on Lucid/dev-folders per the registry (has_video=1), so
this indexer contributes metadata only, never a file path.

video_people links are sparse (909 rows for 2,403 videos) and dominated
by non-Congress subjects (861 of 909 are Donald Trump), so this pass
records a person hit only when the linked name resolves to a real
BioguideID -- it is not a general person-tagging pass.
"""

import csv
import sqlite3

import config
import schema


def load_bioguide_by_full_name() -> dict[str, dict]:
    with open(config.BIOGUIDE_CSV, encoding="utf-8") as f:
        return {row["full_name"]: row for row in csv.DictReader(f)}


def main():
    yt_con = sqlite3.connect(config.CSPAN_YOUTUBE_INDEXER_DB)
    idx = schema.connect(config.INDEX_DB)
    bioguide_by_name = load_bioguide_by_full_name()

    registry_yt_ids = {
        r[0] for r in idx.execute("select canonical_id from canonical_items where id_type = 'YouTube'")
    }

    updated = 0
    person_hits = 0

    with idx:
        for video_id, title, description, published_date, duration_seconds in yt_con.execute(
            "select video_id, title, description, published_date, duration_seconds from videos"
        ):
            if video_id not in registry_yt_ids:
                continue

            idx.execute(
                """update canonical_items
                   set title = coalesce(title, ?), description = coalesce(description, ?),
                       duration_seconds = coalesce(duration_seconds, ?),
                       publish_date = coalesce(publish_date, ?), date_source = coalesce(date_source, 'published'),
                       metadata_source = coalesce(metadata_source, 'cspan_youtube_indexer_db')
                   where canonical_id = ?""",
                (title, description, duration_seconds, published_date, video_id),
            )
            updated += 1

            person_row = yt_con.execute(
                """select p.canonical_name, vp.confidence from video_people vp
                   join people p on p.person_id = vp.person_id
                   where vp.video_id = ? order by vp.confidence desc limit 1""",
                (video_id,),
            ).fetchone()
            if not person_row:
                continue
            canonical_name, confidence = person_row
            ref = bioguide_by_name.get(canonical_name)
            if not ref:
                continue  # e.g. Donald Trump -- not a current member, no BioguideID to file under
            idx.execute(
                """update canonical_items
                   set person_bioguide_id = coalesce(person_bioguide_id, ?),
                       person_first_name = coalesce(person_first_name, ?),
                       person_last_name = coalesce(person_last_name, ?),
                       person_match_source = coalesce(person_match_source, 'cspan_youtube_indexer_video_people'),
                       person_match_confidence = coalesce(person_match_confidence, ?)
                   where canonical_id = ?""",
                (ref["bioguide_id"], ref["first_name"], ref["last_name"], confidence, video_id),
            )
            person_hits += 1

    print(f"indexer videos overlapping registry: {len(registry_yt_ids & {r[0] for r in yt_con.execute('select video_id from videos')})}")
    print(f"canonical_items updated:              {updated}")
    print(f"person hits resolved to a BioguideID: {person_hits}")

    idx.close()
    yt_con.close()


if __name__ == "__main__":
    main()
