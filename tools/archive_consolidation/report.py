"""Coverage report + CSV export for human review.

Run any time to see where Phase 1 stands. Also writes
output/canonical_items_review.csv -- one row per canonical item, sorted
to put the lowest-confidence / least-resolved items first, since those
are the ones a human actually needs to look at.
"""

import csv

import config
import schema


def main():
    con = schema.connect(config.INDEX_DB)

    total = con.execute("select count(*) from canonical_items").fetchone()[0]

    print(f"=== Phase 1 coverage: {total} canonical items ===\n")
    print(f"{'id_type':10s} {'total':>6s} {'title':>6s} {'date':>6s} {'person':>6s} {'institutional':>13s}")
    for id_type, n, title, date, person, inst in con.execute(
        """select id_type, count(*), sum(title is not null), sum(publish_date is not null),
                  sum(person_folder_key is not null), sum(is_institutional)
           from canonical_items group by id_type"""
    ):
        print(f"{id_type:10s} {n:6d} {title or 0:6d} {date or 0:6d} {person or 0:6d} {inst or 0:13d}")

    print("\nperson_match_source breakdown:")
    for source, n in con.execute(
        "select coalesce(person_match_source,'(none)'), count(*) from canonical_items group by 1 order by 2 desc"
    ):
        print(f"  {source:35s} {n}")

    print("\nmetadata_source breakdown:")
    for source, n in con.execute(
        "select coalesce(metadata_source,'(none)'), count(*) from canonical_items group by 1 order by 2 desc"
    ):
        print(f"  {source:35s} {n}")

    (needs_review,) = con.execute("select count(*) from unmatched_content_files").fetchone()
    print(f"\nfiles still needing manual review (no filename pattern resolved them): {needs_review}")

    print("\ntranscript_status breakdown:")
    for status, n in con.execute(
        "select transcript_status, count(*) from canonical_items group by 1 order by 2 desc"
    ):
        print(f"  {status:15s} {n}")
    print("transcript_source breakdown:")
    for source, n in con.execute(
        "select coalesce(transcript_source,'(none)'), count(*) from canonical_items group by 1 order by 2 desc"
    ):
        print(f"  {source:30s} {n}")

    out_path = config.OUTPUT_DIR / "canonical_items_review.csv"
    cols = [
        "canonical_id", "id_type", "title", "publish_date", "date_source",
        "person_bioguide_id", "person_first_name", "person_last_name",
        "person_match_source", "person_match_confidence", "is_institutional",
        "metadata_source", "file_count", "total_size_mb", "notes",
    ]
    rows = con.execute(
        f"select {', '.join(cols)} from canonical_items "
        f"order by (person_bioguide_id is not null), (title is not null), canonical_id"
    ).fetchall()
    try:
        with open(out_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(cols)
            writer.writerows(rows)
        print(f"\nwrote {out_path} ({len(rows)} rows)")
    except PermissionError:
        # Likely open in Excel for review -- don't let that block the rest
        # of the report, just land the refresh somewhere else.
        fallback = out_path.with_stem(out_path.stem + "_latest")
        with open(fallback, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(cols)
            writer.writerows(rows)
        print(f"\n{out_path} is locked (open elsewhere?) -- wrote {fallback} instead ({len(rows)} rows)")

    con.close()


if __name__ == "__main__":
    main()
