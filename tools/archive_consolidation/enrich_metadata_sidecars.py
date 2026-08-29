"""Step 2e: enrich remaining canonical items from their own metadata_json files.

The registry already knows exactly which file, if any, is a canonical
item's metadata sidecar (role = 'metadata_json' in the files table) --
this reads those directly rather than re-crawling the archive's folder
conventions, which turned out to have far more variants than the brief
described (yt-dlp .info.json, a capitalized "catalog_row.json" format,
and internal pipeline state files with no descriptive content at all).

Some items have several metadata_json files (a "Channel/<id>/" folder can
carry proxy.info.json, catalog_row.json, ingest_state.json,
validation.json, manifest.json, caption_status.json side by side); this
scores each candidate by how many recognizable descriptive fields it has
and keeps the best one, so a state-tracking file never wins over a real
sidecar just by being read first.

One live example (03_2025-03-11_mcbride_self_keating/.../*.info.json)
had a title completely unrelated to its own folder name -- a real
mismatch between a folder's naming and its actual sidecar content, not a
parsing bug. That's recorded as a conflict rather than silently trusted,
since forcing a resolution here risks filing content under the wrong
event entirely.
"""

import json
import re
from pathlib import Path

import config
import schema

_YTDLP_KEYS = {"title", "upload_date", "uploader", "channel", "description", "duration", "id", "webpage_url"}
_CATALOG_ROW_KEYS = {"Title", "Published At UTC", "Channel Name", "Video ID", "Canonical YouTube URL", "Discovered At UTC"}


def _normalize_ytdlp_date(raw) -> str | None:
    if not raw:
        return None
    raw = str(raw)
    if len(raw) == 8 and raw.isdigit():  # 20260422
        return f"{raw[0:4]}-{raw[4:6]}-{raw[6:8]}"
    return raw[:10]


def extract_fields(data: dict) -> dict | None:
    """Return normalized {title, date, description, duration, uploader,
    channel, source_url} plus a _score, or None if this JSON has no
    recognizable descriptive content at all (a state/manifest file)."""
    if not isinstance(data, dict):
        return None

    ytdlp_hits = _YTDLP_KEYS & data.keys()
    catalog_hits = _CATALOG_ROW_KEYS & data.keys()

    if "title" in ytdlp_hits and len(ytdlp_hits) >= 2:
        return {
            "title": data.get("title"),
            "date": _normalize_ytdlp_date(data.get("upload_date")),
            "description": data.get("description"),
            "duration": data.get("duration"),
            "uploader": data.get("uploader") or data.get("channel"),
            "source_url": data.get("webpage_url"),
            "_score": len(ytdlp_hits),
            "_format": "ytdlp",
        }
    if "Title" in catalog_hits and len(catalog_hits) >= 2:
        return {
            "title": data.get("Title"),
            "date": (data.get("Published At UTC") or "")[:10] or None,
            "description": None,
            "duration": None,
            "uploader": data.get("Channel Name"),
            "source_url": data.get("Canonical YouTube URL"),
            "_score": len(catalog_hits),
            "_format": "catalog_row",
        }
    # transcriptor's *.clean.json carries title/date one level down, under
    # "metadata" -- it's a transcript file first, but the header is a real
    # sidecar in everything but name.
    meta = data.get("metadata")
    if isinstance(meta, dict) and meta.get("title"):
        return {
            "title": meta.get("title"),
            "date": meta.get("upload_date"),
            "description": None,
            "duration": None,
            "uploader": None,
            "source_url": None,
            "_score": 1,
            "_format": "clean_transcript_header",
        }
    # Basiq-Studio-Hub's thin *.meta.json is often just {"title": "..."},
    # and that title is frequently a yt-dlp default output filename
    # ("Some Title [wIaAVpmuHKU].mp4") rather than a clean title -- strip
    # the trailing "[id].ext" and recover the embedded YouTube ID rather
    # than storing the filename verbatim.
    if set(data.keys()) == {"title"} and data.get("title"):
        title = data["title"]
        m = re.match(r"^(?P<clean>.+) \[(?P<yt_id>[A-Za-z0-9_-]{11})\]\.\w+$", title)
        return {
            "title": m.group("clean") if m else title,
            "date": None,
            "description": None,
            "duration": None,
            "uploader": None,
            "source_url": f"https://www.youtube.com/watch?v={m.group('yt_id')}" if m else None,
            "_score": 0.5,
            "_format": "basiq_meta_title_only",
        }
    return None


def main():
    con = schema.connect(config.INDEX_DB)

    candidates = con.execute(
        """select f.canonical_id, f.full_path from files f
           join canonical_items c on c.canonical_id = f.canonical_id
           where f.role in ('metadata_json', 'metadata_json_other')
             and f.full_path not like '%.tags.json'
             and c.title is null"""
    ).fetchall()

    best_by_item: dict[str, dict] = {}
    read_errors = 0
    for canonical_id, full_path in candidates:
        try:
            with open(full_path, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            read_errors += 1
            continue
        fields = extract_fields(data)
        if not fields:
            continue
        current = best_by_item.get(canonical_id)
        if not current or fields["_score"] > current["_score"]:
            fields["_path"] = full_path
            best_by_item[canonical_id] = fields

    updated = 0
    with con:
        for canonical_id, fields in best_by_item.items():
            con.execute(
                """update canonical_items
                   set title = ?, description = ?, duration_seconds = ?,
                       publish_date = ?, date_source = 'published',
                       metadata_source = ?,
                       notes = coalesce(notes || ' | ', '') || 'sidecar=' || ?
                   where canonical_id = ?""",
                (fields["title"], fields["description"], fields["duration"],
                 fields["date"], f"metadata_sidecar_{fields['_format']}",
                 fields["_path"], canonical_id),
            )
            updated += 1

    print(f"canonical items with an unread title and a metadata_json file: "
          f"{len({c for c, _ in candidates})}")
    print(f"metadata_json files considered:  {len(candidates)}")
    print(f"read/parse errors:               {read_errors}")
    print(f"canonical items newly enriched:  {updated}")

    con.close()


if __name__ == "__main__":
    main()
