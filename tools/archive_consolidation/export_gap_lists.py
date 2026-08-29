"""Export file-level CSVs for the two open gaps: items with zero metadata
anywhere, and items with a real title/non-institutional but still no
resolved person. One row per physical file (not per canonical item), so
the actual files can be opened/reviewed directly.
"""

import csv

import config
import schema

COLS = [
    "canonical_id", "id_type", "title", "description", "publish_date",
    "is_institutional", "metadata_source",
    "full_path", "role", "extension", "size_mb", "project", "quality_guess",
]


def export(con, where_clause: str, out_name: str) -> int:
    rows = con.execute(
        f"""select
              c.canonical_id, c.id_type, c.title, c.description, c.publish_date,
              c.is_institutional, c.metadata_source,
              f.full_path, f.role, f.extension, f.size_mb, f.project, f.quality_guess
            from files f
            join canonical_items c on c.canonical_id = f.canonical_id
            where {where_clause}
            order by c.canonical_id, f.role, f.full_path"""
    ).fetchall()

    out_path = config.OUTPUT_DIR / out_name
    try:
        with open(out_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(COLS)
            writer.writerows(rows)
    except PermissionError:
        out_path = out_path.with_stem(out_path.stem + "_latest")
        with open(out_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(COLS)
            writer.writerows(rows)

    n_items = len({r[0] for r in rows})
    print(f"{out_path.name}: {n_items} canonical items, {len(rows)} file rows -> {out_path}")
    return n_items


def main():
    con = schema.connect(config.INDEX_DB)

    export(con, "c.title is null", "gap_zero_metadata_file_detail.csv")
    export(
        con,
        "c.title is not null and c.is_institutional = 0 and c.person_folder_key is null",
        "gap_unresolved_titled_file_detail.csv",
    )

    con.close()


if __name__ == "__main__":
    main()
