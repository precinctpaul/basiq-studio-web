"""Step 4d: transcribe items that have a resolved person/institutional tag
but no transcript anywhere in the archive -- the "video + tags, no
transcript" bucket. Reuses the exact faster-whisper setup from
tools/basiq_agent.py's /transcribe endpoint (same model, same
get_model()/extract_audio_wav()), pointed at a local archive file instead
of a fresh grab.

Scoped per the user's explicit call: skip anything over 10 minutes (a
30-hour C-SPAN session would stall the whole batch), and skip BasiqUUID
items (confirmed test uploads). Output goes through the same
transcript_formats.write_srt() as every other transcript in this project,
so downstream tooling (metadata.json export, etc.) doesn't need to know
which source produced a given item's SRT.
"""

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import basiq_agent  # noqa: E402

import config
import schema
import transcript_formats as tf

MAX_DURATION_SECONDS = 600  # 10 minutes, per the user's explicit call


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    con = schema.connect(config.INDEX_DB)
    out_dir = config.OUTPUT_DIR / "transcripts_srt"
    out_dir.mkdir(parents=True, exist_ok=True)

    is_tagged = "(person_folder_key is not null or is_institutional = 1)"
    rows = con.execute(
        f"""select canonical_id, duration_seconds from canonical_items
            where has_video = 1 and transcript_status != 'available' and {is_tagged}
              and id_type != 'BasiqUUID'
              and duration_seconds is not null and duration_seconds <= {MAX_DURATION_SECONDS}
            order by duration_seconds asc"""
    ).fetchall()
    if args.limit:
        rows = rows[: args.limit]

    model = basiq_agent.get_model()
    print(f"model ready. items to process: {len(rows)}")

    done, failed = 0, 0
    total_audio_seconds, total_wall_seconds = 0.0, 0.0

    with con:
        for canonical_id, duration in rows:
            file_row = con.execute(
                "select full_path from files where canonical_id = ? and role = 'video' order by (quality_guess != 'master') limit 1",
                (canonical_id,),
            ).fetchone()
            if not file_row:
                failed += 1
                continue
            video_path = file_row[0]

            started = time.monotonic()
            try:
                audio_path = basiq_agent.extract_audio_wav(video_path)
                segments_iter, info = model.transcribe(
                    audio_path,
                    beam_size=basiq_agent.BEAM_SIZE,
                    vad_filter=basiq_agent.VAD_FILTER,
                    language=None,
                    condition_on_previous_text=False,
                )
                segments = [
                    tf.Segment(float(s.start), float(s.end), (s.text or "").strip())
                    for s in segments_iter if (s.text or "").strip()
                ]
            except Exception as e:
                print(f"  FAILED {canonical_id}: {e}")
                con.execute(
                    "update canonical_items set transcript_status = 'failed', notes = coalesce(notes || ' | ', '') || 'whisper error: ' || ? where canonical_id = ?",
                    (str(e)[:200], canonical_id),
                )
                failed += 1
                continue

            elapsed = time.monotonic() - started
            total_audio_seconds += duration or 0
            total_wall_seconds += elapsed

            if not segments:
                con.execute(
                    "update canonical_items set transcript_status = 'failed', transcript_segment_count = 0 where canonical_id = ?",
                    (canonical_id,),
                )
                failed += 1
                continue

            n_cues = tf.write_srt(segments, out_dir / f"{canonical_id}.srt")
            con.execute(
                """update canonical_items
                   set transcript_status = 'available', transcript_source = 'whisper_local',
                       transcript_segment_count = ?
                   where canonical_id = ?""",
                (n_cues, canonical_id),
            )
            done += 1
            speed = (duration / elapsed) if elapsed else 0
            print(f"  [{done+failed}/{len(rows)}] {canonical_id} ({duration:.0f}s audio in {elapsed:.1f}s, {speed:.1f}x realtime)")

    print(f"\ndone: {done}  failed: {failed}")
    if total_wall_seconds:
        print(f"overall throughput: {total_audio_seconds/total_wall_seconds:.1f}x realtime "
              f"({total_audio_seconds/60:.1f} min audio in {total_wall_seconds/60:.1f} min wall time)")

    con.close()


if __name__ == "__main__":
    main()
