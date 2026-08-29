"""Step 4b: actually parse each item's chosen transcript source and write
a normalized .srt to output/transcripts_srt/<canonical_id>.srt.

Run with --limit N first to validate against a real cross-section before
committing to the full archive -- this touches ~7,000 files/DB rows, a
similar order of magnitude to the metadata sidecar scan that took several
minutes over the network mount.
"""

import argparse
import sqlite3

import config
import schema
import transcript_formats as tf

_FILE_PARSERS = {
    "file_transcript_csv": tf.parse_transcript_csv,
    "file_caption_srt": tf.parse_srt,
    "file_caption_vtt": tf.parse_vtt,
    "file_caption_json3": tf.parse_json3,
    "file_transcript_json": tf.parse_transcript_json_auto,
    "file_transcript_text": tf.parse_timestamped_txt,
}


def get_cspan_discovery_segments(cspan_con, program_id: str) -> list[tf.Segment]:
    rows = cspan_con.execute(
        "select start_seconds, end_seconds, speaker, text from transcript_segments "
        "where program_id = ? order by segment_index",
        (int(program_id),),
    ).fetchall()
    return [tf.Segment(start, end, tf.clean_text(text)) for start, end, _speaker, text in rows if text]


def get_yt_indexer_segments(yt_con, video_id: str) -> list[tf.Segment]:
    rows = yt_con.execute(
        "select start_ms, end_ms, text_display from segments where video_id = ? order by segment_number",
        (video_id,),
    ).fetchall()
    return [tf.Segment(start_ms / 1000, end_ms / 1000, tf.clean_text(text)) for start_ms, end_ms, text in rows if text]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=None, help="only process the first N items (validation runs)")
    parser.add_argument("--canonical-ids-file", default=None,
                         help="path to a text file, one canonical_id per line -- "
                              "safer than a CLI flag since YouTube IDs can start with '-'")
    args = parser.parse_args()
    canonical_ids = None
    if args.canonical_ids_file:
        with open(args.canonical_ids_file, encoding="utf-8") as f:
            canonical_ids = [line.strip() for line in f if line.strip()]

    con = schema.connect(config.INDEX_DB)
    cspan_con = sqlite3.connect(config.CSPAN_DISCOVERY_DB)
    yt_con = sqlite3.connect(config.CSPAN_YOUTUBE_INDEXER_DB)

    out_dir = config.OUTPUT_DIR / "transcripts_srt"
    out_dir.mkdir(parents=True, exist_ok=True)

    query = "select canonical_id, transcript_source, transcript_source_path from canonical_items where transcript_status = 'available'"
    if canonical_ids:
        placeholders = ",".join("?" for _ in canonical_ids)
        query += f" and canonical_id in ({placeholders})"
        rows = con.execute(query, canonical_ids).fetchall()
    else:
        rows = con.execute(query).fetchall()
    if args.limit:
        rows = rows[: args.limit]

    written = 0
    empty = 0
    failed = 0
    by_source_written: dict[str, int] = {}

    with con:
        for canonical_id, source, source_path in rows:
            try:
                if source == "cspan_discovery_db":
                    segments = get_cspan_discovery_segments(cspan_con, canonical_id)
                elif source == "cspan_youtube_indexer_db":
                    segments = get_yt_indexer_segments(yt_con, canonical_id)
                else:
                    segments = _FILE_PARSERS[source](source_path)
            except Exception as e:  # noqa: BLE001 -- one bad item must not kill a ~7000-item batch
                con.execute(
                    "update canonical_items set transcript_status='failed', notes = coalesce(notes || ' | ', '') || 'transcript error: ' || ? where canonical_id=?",
                    (str(e)[:200], canonical_id),
                )
                failed += 1
                continue

            if not segments:
                con.execute(
                    "update canonical_items set transcript_status='failed', transcript_segment_count=0 where canonical_id=?",
                    (canonical_id,),
                )
                empty += 1
                continue

            out_path = out_dir / f"{canonical_id}.srt"
            n_cues = tf.write_srt(segments, out_path)
            con.execute(
                "update canonical_items set transcript_segment_count=? where canonical_id=?",
                (n_cues, canonical_id),
            )
            written += 1
            by_source_written[source] = by_source_written.get(source, 0) + 1

    print(f"items considered: {len(rows)}")
    print(f"srt written:      {written}")
    print(f"parsed but empty (marked failed): {empty}")
    print(f"parse errors (marked failed):     {failed}")
    print("written by source:")
    for k, v in sorted(by_source_written.items(), key=lambda kv: -kv[1]):
        print(f"  {k}: {v}")

    con.close()


if __name__ == "__main__":
    main()
