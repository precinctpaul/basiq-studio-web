"""Step 5: write the approved per-item metadata.json shape to
output/metadata_json/<canonical_id>.metadata.json for every canonical item.

Schema locked in with the user (see conversation): title/date/person/
source/transcript/legislation/provenance/files, nulls left in place for
anything genuinely unknown rather than omitted, since a null is itself
informative ("we looked, it isn't there") in a maximalist,
knowledge-graph-ready record.

source_url isn't its own column anywhere upstream -- for CSPAN/BasiqUUID
items it was captured as free text inside `notes` by whichever enrichment
pass found it (cspan_discovery_db writes "canonical_url=...",
basiq/notable-figure passes write "source_url=..."), so it's pulled back
out here with a regex rather than re-running those passes to add a proper
column for a value this export is the only consumer of.
"""

import json
import re
import sqlite3

import config
import schema

_URL_IN_NOTES = re.compile(r"(?:canonical_url|source_url)=(\S+)")


def source_url_for(canonical_id: str, id_type: str, notes: str | None) -> str | None:
    if id_type == "YouTube":
        return f"https://www.youtube.com/watch?v={canonical_id}"
    if notes:
        m = _URL_IN_NOTES.search(notes)
        if m and m.group(1) not in ("None", ""):
            return m.group(1)
    return None


def load_legislation(cspan_con) -> dict[str, list[dict]]:
    by_program: dict[str, list[dict]] = {}
    for program_id, display, title, congress, bill_type, bill_number in cspan_con.execute(
        "select program_id, display, title, congress, bill_type, bill_number from legislation"
    ):
        by_program.setdefault(str(program_id), []).append(
            {"display": display, "title": title, "congress": congress, "bill_type": bill_type, "bill_number": bill_number}
        )
    return by_program


def main():
    con = schema.connect(config.INDEX_DB)
    cspan_con = sqlite3.connect(config.CSPAN_DISCOVERY_DB)
    legislation_by_program = load_legislation(cspan_con)

    out_dir = config.OUTPUT_DIR / "metadata_json"
    out_dir.mkdir(parents=True, exist_ok=True)

    items = con.execute("select * from canonical_items").fetchall()
    col_names = [d[0] for d in con.execute("select * from canonical_items limit 0").description]

    written = 0
    for row in items:
        item = dict(zip(col_names, row))
        canonical_id = item["canonical_id"]

        files = con.execute(
            "select full_path, role, extension, size_mb, quality_guess from files where canonical_id = ? order by role",
            (canonical_id,),
        ).fetchall()

        doc = {
            "canonical_id": canonical_id,
            "id_type": item["id_type"],
            "title": item["title"],
            "description": item["description"],
            "publish_date": item["publish_date"],
            "date_source": item["date_source"],
            "duration_seconds": item["duration_seconds"],
            "source": {
                "platform": item["id_type"],
                "source_id": canonical_id,
                "url": source_url_for(canonical_id, item["id_type"], item["notes"]),
            },
            "person": {
                "identifier_type": item["person_identifier_type"],
                "folder_key": item["person_folder_key"],
                "bioguide_id": item["person_bioguide_id"],
                "first_name": item["person_first_name"],
                "last_name": item["person_last_name"],
                "match_source": item["person_match_source"],
                "match_confidence": item["person_match_confidence"],
            } if item["person_folder_key"] else None,
            "is_institutional": bool(item["is_institutional"]),
            "video_completeness": item["video_completeness"],
            "legislation": legislation_by_program.get(canonical_id, []),
            "transcript": {
                "status": item["transcript_status"],
                "source": item["transcript_source"],
                "segment_count": item["transcript_segment_count"],
            },
            "provenance": {
                "projects": (item["projects"] or "").split("; "),
                "file_count": item["file_count"],
                "total_size_mb": item["total_size_mb"],
                "is_duplicate_across_projects": bool(item["is_duplicate_across_projects"]),
            },
            "files": [
                {"path": f[0], "role": f[1], "extension": f[2], "size_mb": f[3], "quality_guess": f[4]}
                for f in files
            ],
        }

        safe_name = re.sub(r'[<>:"/\\|?*]', "_", canonical_id)
        with open(out_dir / f"{safe_name}.metadata.json", "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=2, ensure_ascii=False)
        written += 1

    print(f"metadata.json files written: {written}")
    print(f"output dir: {out_dir}")

    con.close()
    cspan_con.close()


if __name__ == "__main__":
    main()
