"""Step 2c: persist the validated filename-convention parse into canonical_items.

validate_conventional.py proved this parser 100% correct against all 203
files already on disk (0 unresolved BioguideIDs, 0 speaker_id
inconsistencies), so those results are trustworthy enough to write back as
resolved facts, not just a spot-check. Confidence is 1.0 and the source is
always attributed, so a later pass can tell these apart from an inferred
guess if the two ever disagree.
"""

from pathlib import Path

import config
import parse_filename
import schema


def main():
    con = schema.connect(config.INDEX_DB)

    rows = con.execute("select full_path, name, canonical_id from files where canonical_id is not null").fetchall()

    updated_items = set()
    with con:
        for full_path, name, canonical_id in rows:
            parsed = parse_filename.parse_conventional_name(Path(name).stem)
            if not parsed:
                continue
            con.execute(
                """update canonical_items
                   set person_bioguide_id = ?, person_first_name = ?, person_last_name = ?,
                       person_match_source = 'filename_convention', person_match_confidence = 1.0,
                       publish_date = coalesce(publish_date, ?), date_source = coalesce(date_source, 'filename'),
                       notes = coalesce(notes || ' | cspan_speaker_id=' || ?, 'cspan_speaker_id=' || ?)
                   where canonical_id = ?""",
                (parsed["bioguide_id"], parsed["first_name"], parsed["last_name"],
                 parsed["date"], parsed["cspan_speaker_id"], parsed["cspan_speaker_id"],
                 canonical_id),
            )
            updated_items.add(canonical_id)

    print(f"files matching full naming convention: {sum(1 for r in rows if parse_filename.parse_conventional_name(Path(r[1]).stem))}")
    print(f"distinct canonical_items resolved from filename convention: {len(updated_items)}")

    con.close()


if __name__ == "__main__":
    main()
