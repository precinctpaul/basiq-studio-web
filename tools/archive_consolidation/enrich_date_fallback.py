"""Step 2i: apply the brief's own decided fallback for items with no real
publish date -- fall back to the file's LastWriteTime, explicitly flagged
as date_source='file_modified' rather than silently treated as a real
publish date. Prefers the video file (most representative of when the
content was actually acquired) over a metadata/transcript sidecar's
mtime, which can postdate the source by however long the sidecar took to
generate.
"""

from datetime import datetime

import config
import schema


def parse_last_write_time(raw: str) -> str | None:
    # Excel/openpyxl renders these as "7/11/2026 9:34:49 PM" -- not a
    # format SQLite's own date() function understands, so it's parsed
    # here rather than pushed down into SQL.
    try:
        return datetime.strptime(raw, "%m/%d/%Y %I:%M:%S %p").date().isoformat()
    except ValueError:
        return None


def main():
    con = schema.connect(config.INDEX_DB)

    candidates = con.execute(
        "select canonical_id from canonical_items where publish_date is null"
    ).fetchall()

    updated = 0
    no_file_date = 0
    with con:
        for (canonical_id,) in candidates:
            row = con.execute(
                """select last_write_time from files
                   where canonical_id = ? and last_write_time is not null
                   order by (role != 'video'), last_write_time asc
                   limit 1""",
                (canonical_id,),
            ).fetchone()
            parsed_date = parse_last_write_time(row[0]) if row else None
            if not parsed_date:
                no_file_date += 1
                continue
            con.execute(
                """update canonical_items
                   set publish_date = ?, date_source = 'file_modified'
                   where canonical_id = ?""",
                (parsed_date, canonical_id),
            )
            updated += 1

    print(f"items with no publish_date: {len(candidates)}")
    print(f"resolved via file_modified fallback: {updated}")
    print(f"no file with a write time at all (still null): {no_file_date}")

    con.close()


if __name__ == "__main__":
    main()
