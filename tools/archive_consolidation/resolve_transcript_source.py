"""Step 4a: decide, per canonical item, which single transcript source wins.

A canonical item routinely has several redundant transcript exports on
disk at once (the 6vJX0MIo7fk sample has a .json3, two near-identical
.csv exports, and a .timestamped.txt all for the same content) -- this
picks one per item by priority, cheaply (file paths and DB membership
only, no file contents opened yet), so normalize_transcripts.py's actual
parsing pass only ever touches the winner.

Priority, richest/most-precise first:
  1. cspan_discovery DB            (922 CSPAN items, speaker-labeled)
  2. cspan-youtube-indexer DB      (921 YouTube items)
  3. Supabase transcripts table    (BasiqUUID items with a ready transcript)
  4. file: transcript_csv          (millisecond precision, clean text)
  5. file: caption .srt
  6. file: caption .vtt
  7. file: caption .json3
  8. file: transcript_json         (Basiq *.transcript.json or *.clean.json)
  9. file: transcript_text         (*.timestamped.txt; title.txt is not a
                                     transcript despite sharing the role)
"""

import sqlite3

import config
import schema


def main():
    con = schema.connect(config.INDEX_DB)

    cspan_discovery_ids = {
        str(r[0]) for r in sqlite3.connect(config.CSPAN_DISCOVERY_DB).execute(
            "select program_id from programs where program_id in (select program_id from transcript_segments)"
        )
    }
    yt_indexer_db = sqlite3.connect(config.CSPAN_YOUTUBE_INDEXER_DB)
    yt_indexer_ids = {
        r[0] for r in yt_indexer_db.execute(
            "select distinct video_id from segments"
        )
    }

    registry_ids = {r[0] for r in con.execute("select canonical_id from canonical_items")}

    counts = {"cspan_discovery_db": 0, "cspan_youtube_indexer_db": 0}
    with con:
        for cid in cspan_discovery_ids & registry_ids:
            con.execute(
                "update canonical_items set transcript_source='cspan_discovery_db', transcript_status='available' where canonical_id=?",
                (cid,),
            )
            counts["cspan_discovery_db"] += 1
        for cid in yt_indexer_ids & registry_ids:
            con.execute(
                """update canonical_items set transcript_source='cspan_youtube_indexer_db', transcript_status='available'
                   where canonical_id=? and transcript_source is null""",
                (cid,),
            )
            counts["cspan_youtube_indexer_db"] += 1

    # File-based candidates, one row per (canonical_id, role, extension),
    # for items the DB sources didn't already claim.
    file_rows = con.execute(
        """select f.canonical_id, f.role, f.extension, f.full_path, f.name from files f
           join canonical_items c on c.canonical_id = f.canonical_id
           where c.transcript_source is null
             and (f.role in ('transcript_csv', 'caption', 'transcript_json', 'transcript_text'))
             and f.name != 'title.txt'"""
    ).fetchall()

    def priority(role: str, ext: str, name: str) -> int:
        # *.transcript.json (Basiq's own Whisper output, few-second cues) and
        # *.clean.json (transcriptor's ~40s chunks) share role/extension but
        # not granularity -- broken out explicitly so the finer one always
        # wins instead of whichever the filesystem happened to list first.
        if role == "transcript_json" and ext == ".json":
            return 8 if name.endswith(".clean.json") else 7.5
        order = {
            ("transcript_csv", ".csv"): 4,
            ("caption", ".srt"): 5,
            ("caption", ".vtt"): 6,
            ("caption", ".json3"): 7,
            ("transcript_text", ".txt"): 9,
        }
        return order.get((role, ext), 99)

    best: dict[str, tuple] = {}
    for canonical_id, role, ext, full_path, name in file_rows:
        p = priority(role, ext, name)
        if canonical_id not in best or p < best[canonical_id][0]:
            best[canonical_id] = (p, role, ext, full_path)

    source_label = {
        4: "file_transcript_csv", 5: "file_caption_srt", 6: "file_caption_vtt",
        7: "file_caption_json3", 7.5: "file_transcript_json", 8: "file_transcript_json",
        9: "file_transcript_text",
    }
    file_counts: dict[str, int] = {}
    with con:
        for canonical_id, (p, role, ext, full_path) in best.items():
            label = source_label[p]
            file_counts[label] = file_counts.get(label, 0) + 1
            con.execute(
                """update canonical_items
                   set transcript_source = ?, transcript_source_path = ?, transcript_status = 'available'
                   where canonical_id = ?""",
                (label, full_path, canonical_id),
            )

    with con:
        con.execute(
            "update canonical_items set transcript_status = 'missing' where transcript_source is null"
        )

    print("DB sources:")
    for k, v in counts.items():
        print(f"  {k}: {v}")
    print("file sources:")
    for k, v in sorted(file_counts.items(), key=lambda kv: -kv[1]):
        print(f"  {k}: {v}")
    (missing,) = con.execute("select count(*) from canonical_items where transcript_status='missing'").fetchone()
    (available,) = con.execute("select count(*) from canonical_items where transcript_status='available'").fetchone()
    print(f"\ntotal available: {available}")
    print(f"total missing:   {missing}  <- brief says ~2860 with no transcript at all")

    con.close()


if __name__ == "__main__":
    main()
