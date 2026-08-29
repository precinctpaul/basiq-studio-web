"""Export every file belonging to a canonical item that's duplicated across
2+ project folders, one row per file, grouped by canonical_id, so the
actual copies can be compared side by side (path, project, size, mtime,
quality guess) before deciding which one becomes the kept copy.
"""

import csv

import config
import schema


def main():
    con = schema.connect(config.INDEX_DB)

    rows = con.execute(
        """select
             c.canonical_id, c.id_type, c.title, c.person_first_name, c.person_last_name,
             c.publish_date, c.project_count, c.file_count as item_file_count,
             f.project, f.full_path, f.role, f.extension, f.size_mb, f.last_write_time,
             f.quality_guess, f.quality_guess_source
           from files f
           join canonical_items c on c.canonical_id = f.canonical_id
           where c.is_duplicate_across_projects = 1
           order by c.canonical_id, f.project, f.full_path"""
    ).fetchall()

    cols = [
        "canonical_id", "id_type", "title", "person_first_name", "person_last_name",
        "publish_date", "project_count", "item_file_count",
        "project", "full_path", "role", "extension", "size_mb", "last_write_time",
        "quality_guess", "quality_guess_source",
    ]
    out_path = config.OUTPUT_DIR / "duplicate_items_file_detail.csv"
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(cols)
        writer.writerows(rows)

    n_items = len({r[0] for r in rows})
    print(f"canonical items covered: {n_items}")
    print(f"file rows written:       {len(rows)}")
    print(f"wrote {out_path}")

    con.close()


if __name__ == "__main__":
    main()
