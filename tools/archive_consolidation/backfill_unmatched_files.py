"""Step 2d: try to resolve the registry's own "unmatched" files by filename.

The registry's ID-extraction missed at least one file whose embedded
C-SPAN ID matches an *existing* canonical item exactly (confirmed by hand:
"...Auchincloss Jake_A000148_127594_2025-01-15_654494.mp4" embeds
654494, and canonical item 654494 already exists from other copies). This
checks all 133 files the registry flagged as needing review against the
three known filename conventions, and links any whose embedded ID matches
an existing canonical_id -- shrinking the real "needs a human" pile before
anyone looks at it, not just re-deriving what the registry already knew.
"""

from pathlib import Path

import config
import parse_filename
import schema


def resolve_ids(name: str) -> tuple[str, str] | None:
    """Return (canonical_id, id_type) if any known pattern extracts one."""
    stem = Path(name).stem
    full = parse_filename.parse_conventional_name(stem)
    if full:
        return full["source_id"], "CSPAN"
    yt = parse_filename.parse_yt_slug_name(stem)
    if yt:
        return yt["youtube_id"], "YouTube"
    cspan = parse_filename.parse_cspan_bare_name(stem)
    if cspan:
        return cspan["cspan_id"], "CSPAN"
    return None


def main():
    con = schema.connect(config.INDEX_DB)

    unmatched = con.execute(
        "select id, full_path, name from unmatched_content_files"
    ).fetchall()

    existing_ids = {
        (r[0], r[1]) for r in con.execute("select canonical_id, id_type from canonical_items")
    }

    linked = 0
    linked_new_id = 0
    still_unresolved = 0

    with con:
        for file_id, full_path, name in unmatched:
            resolved = resolve_ids(name)
            if not resolved:
                still_unresolved += 1
                continue
            canonical_id, id_type = resolved
            if (canonical_id, id_type) in existing_ids:
                con.execute(
                    "update files set canonical_id = ?, id_type = ? where id = ?",
                    (canonical_id, id_type, file_id),
                )
                linked += 1
            else:
                # Embedded an ID the registry never saw at all -- flag it
                # rather than silently inventing a new canonical item, since
                # that decision (is this really a new item, or a typo/variant
                # ID) belongs to whoever reviews the remaining unmatched pile.
                con.execute(
                    "update files set notes = ? where id = ?",
                    (f"filename implies unregistered {id_type} id {canonical_id}", file_id),
                )
                linked_new_id += 1

    print(f"unmatched files checked:                         {len(unmatched)}")
    print(f"linked to an existing canonical_id via filename:  {linked}")
    print(f"embed an ID the registry never registered at all: {linked_new_id}")
    print(f"still fully unresolved (no pattern matched):      {still_unresolved}")

    con.close()


if __name__ == "__main__":
    main()
