"""Step 4e: collapse YouTube-style rolling-caption duplication out of every
SRT this project has already generated.

Every transcript sourced from a native YouTube .srt/.vtt caption file
(role file_caption_srt / file_caption_vtt in the resolver) inherits
YouTube's own rolling-caption format: each cue re-states most of the
previous cue's words and appends a few new ones, so a straight cue-by-cue
parse produces a transcript that's nearly 2x longer than the real text
and reads as constant repetition. tools/basiq_agent.py already solved
this for the live product's own import path (merge_rolling_captions,
used by /grab and bulk_import_transcripts.py) -- this applies the exact
same function here, on files this project already wrote, since the fix
was never wired into transcript_formats.py's own parsing.

Per that function's own docstring, running it on every SRT regardless of
source is safe: a transcript with no cue-to-cue overlap (Whisper, the
cspan_discovery DB, the youtube-indexer DB) has nothing for it to remove.
Rewrites SRT files in place and updates transcript_segment_count in the
index to match the cleaned cue count.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import basiq_agent  # noqa: E402

import config
import schema
import transcript_formats as tf


def main():
    con = schema.connect(config.INDEX_DB)
    srt_dir = config.OUTPUT_DIR / "transcripts_srt"

    rows = con.execute(
        "select canonical_id from canonical_items where transcript_status = 'available'"
    ).fetchall()

    changed, unchanged, missing = 0, 0, 0
    with con:
        for (canonical_id,) in rows:
            path = srt_dir / f"{canonical_id}.srt"
            if not path.exists():
                missing += 1
                continue

            segments = tf.parse_srt(path)
            before = len(segments)
            merged = basiq_agent.merge_rolling_captions(
                [{"start": s.start, "end": s.end, "text": s.text} for s in segments]
            )
            if len(merged) == before:
                unchanged += 1
                continue

            cleaned = [tf.Segment(m["start"], m["end"], m["text"]) for m in merged]
            n_cues = tf.write_srt(cleaned, path)
            con.execute(
                "update canonical_items set transcript_segment_count = ? where canonical_id = ?",
                (n_cues, canonical_id),
            )
            changed += 1

    print(f"items with a transcript: {len(rows)}")
    print(f"rewritten (had rolling-caption duplication): {changed}")
    print(f"unchanged (no overlap found -- Whisper/DB sources etc.): {unchanged}")
    print(f"srt file missing on disk: {missing}")

    con.close()


if __name__ == "__main__":
    main()
