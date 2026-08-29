"""Step 6: push the enriched SQLite index into the real Supabase schema
(supabase/migrations/0007_archive_consolidation.sql). Run this AFTER that
migration has been applied (paste it into Supabase Dashboard -> SQL Editor
-> Run, same as every other migration in this repo).

Transcript SEGMENTS (timed cue-by-cue rows, 3.2M+ across the archive) are
still deliberately not pushed by this pass -- that's a much heavier,
separate load with no UI consumer yet. Full transcript TEXT (one row per
item, for search and display) is pushed via archive_item_transcripts.
Re-run safely; every write is an upsert on a natural key.
"""

import csv
import sqlite3

from supabase import create_client

import config
import schema
import transcript_formats as tf

_ID_TYPE_TO_PLATFORM = {"CSPAN": "cspan", "YouTube": "youtube", "BasiqUUID": "basiq"}
_OPENSTATES_EXTERNAL_IDS = {
    "nc_talarico_james": {"openstates_id": "ocd-person/5e4e2fd2-e8a9-46f3-aab5-ffbc782afa8b", "role": "TX House District 50"},
    "nc_mcmorrow_mallory": {"openstates_id": "ocd-person/dc6ff9c0-f2b1-433d-a96b-292cf05bcb50", "role": "MI Senate District 8"},
}


def load_env(path) -> dict[str, str]:
    env = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def chunks(items: list, size: int):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def build_people_rows(con, sb) -> dict[str, str]:
    """Upserts public.people and returns {folder_key: person uuid}.

    The id must be STABLE across re-runs: archive_items and
    archive_item_people reference it by FK, so generating a fresh random
    uuid every run would either orphan those references (Postgres would
    reject the update outright, since nothing here cascades) or silently
    duplicate the person on conflict. Existing rows are looked up first by
    their natural key (bioguide_id or name_slug) and their real id reused;
    only genuinely new people get a freshly generated uuid.

    bioguide_id and name_slug are two SEPARATE unique constraints, so this
    upserts in two passes -- a single upsert can only target one
    on_conflict column.
    """
    import uuid as uuidlib

    # GROUP BY (not DISTINCT over every column): the same folder_key has
    # occasionally picked up two different name spellings across different
    # enrichment passes (e.g. V000136 has both "Gabe Vasquez" from a
    # filename/title match and "Gabriel (Gabe) Vasquez" from the reference
    # CSV's own formatting via the honorific-match pass) -- min() just
    # picks one consistently rather than erroring on the duplicate.
    rows = con.execute(
        """select person_folder_key, person_identifier_type, person_bioguide_id,
                  min(person_first_name), min(person_last_name)
           from canonical_items where person_folder_key is not null
           group by person_folder_key, person_identifier_type, person_bioguide_id"""
    ).fetchall()

    bioguide_meta = {}
    with open(config.BIOGUIDE_CSV, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            bioguide_meta[r["bioguide_id"]] = r

    current_ids = set()
    try:
        import people as people_mod
        current_ids = people_mod.load_current_bioguide_ids()
    except Exception:
        pass

    existing = sb.table("people").select("id, bioguide_id, name_slug").execute().data
    existing_by_bioguide = {r["bioguide_id"]: r["id"] for r in existing if r["bioguide_id"]}
    existing_by_slug = {r["name_slug"]: r["id"] for r in existing if r["name_slug"]}

    bioguide_rows, name_slug_rows = [], []
    folder_key_to_uuid = {}
    for folder_key, id_type, bioguide_id, first, last in rows:
        if id_type == "bioguide":
            pid = existing_by_bioguide.get(bioguide_id) or str(uuidlib.uuid4())
        else:
            pid = existing_by_slug.get(folder_key) or str(uuidlib.uuid4())
        folder_key_to_uuid[folder_key] = pid

        meta = bioguide_meta.get(bioguide_id, {})
        payload = {
            "id": pid,
            "identifier_type": id_type,
            "bioguide_id": bioguide_id,
            "name_slug": folder_key if id_type == "name_slug" else None,
            "first_name": first or "",
            "last_name": last or "",
            "full_name": f"{first or ''} {last or ''}".strip(),
            "chamber": meta.get("latest_chamber"),
            "state": meta.get("latest_state"),
            "party": meta.get("latest_party"),
            "is_current": bioguide_id in current_ids,
            "external_ids": _OPENSTATES_EXTERNAL_IDS.get(folder_key, {}),
        }
        (bioguide_rows if id_type == "bioguide" else name_slug_rows).append(payload)

    for batch in chunks(bioguide_rows, 500):
        sb.table("people").upsert(batch, on_conflict="bioguide_id").execute()
    for batch in chunks(name_slug_rows, 500):
        sb.table("people").upsert(batch, on_conflict="name_slug").execute()

    return folder_key_to_uuid


def main():
    env = load_env(config.TOOL_DIR.parent.parent / ".env.local")
    sb = create_client(env["NEXT_PUBLIC_SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"])
    con = schema.connect(config.INDEX_DB)

    print("-- people --")
    folder_key_to_uuid = build_people_rows(con, sb)
    print(f"upserted {len(folder_key_to_uuid)} people")

    print("-- archive_items --")
    item_rows = con.execute(
        """select canonical_id, id_type, title, description, publish_date, date_source,
                  duration_seconds, is_institutional, video_completeness,
                  person_folder_key, person_match_source, person_match_confidence,
                  transcript_status, transcript_source, transcript_segment_count, notes,
                  source_url
           from canonical_items"""
    ).fetchall()
    items_payload = []
    for row in item_rows:
        (cid, id_type, title, desc, pub_date, date_source, duration, is_inst, video_complete,
         folder_key, match_source, match_conf, t_status, t_source, t_count, notes, source_url) = row
        items_payload.append({
            "id": cid,
            "source_platform": _ID_TYPE_TO_PLATFORM[id_type],
            "title": title,
            "description": desc,
            "publish_date": pub_date,
            "date_source": date_source,
            "duration_seconds": duration,
            "is_institutional": bool(is_inst),
            "video_completeness": video_complete,
            "primary_person_id": folder_key_to_uuid.get(folder_key),
            "person_match_source": match_source,
            "person_match_confidence": match_conf,
            "transcript_status": t_status,
            "transcript_source": t_source,
            "transcript_segment_count": t_count,
            "notes": notes,
            "source_url": source_url,
        })
    for batch in chunks(items_payload, 500):
        sb.table("archive_items").upsert(batch).execute()
    print(f"upserted {len(items_payload)} archive_items")

    print("-- archive_item_transcripts (full text, not segments) --")
    srt_dir = config.OUTPUT_DIR / "transcripts_srt"
    transcript_rows = con.execute(
        "select canonical_id, transcript_source, transcript_segment_count "
        "from canonical_items where transcript_status = 'available'"
    ).fetchall()
    transcript_payload = []
    missing_srt = 0
    for cid, t_source, t_count in transcript_rows:
        path = srt_dir / f"{cid}.srt"
        if not path.exists():
            missing_srt += 1
            continue
        segments = tf.parse_srt(path)
        # Postgres text columns reject a literal NUL byte outright (some
        # source captions carry one, likely from a bad encoding upstream);
        # strip it rather than let one bad transcript fail the whole batch.
        full_text = " ".join(s.text.strip() for s in segments if s.text.strip()).replace("\x00", "")
        transcript_payload.append({
            "archive_item_id": cid,
            "source": t_source or "unknown",
            "full_text": full_text,
            "segment_count": t_count or len(segments),
        })
    # Small batches -- unlike tags/files rows, a transcript's full_text can
    # run tens of KB each, and a 200-row batch of those was enough to trip
    # Supabase's statement timeout.
    for batch in chunks(transcript_payload, 20):
        sb.table("archive_item_transcripts").upsert(batch, on_conflict="archive_item_id").execute()
    print(f"upserted {len(transcript_payload)} archive_item_transcripts (missing srt: {missing_srt})")

    print("-- archive_item_people (graph edges) --")
    edge_rows = [
        {"archive_item_id": cid, "person_id": folder_key_to_uuid[folder_key],
         "role": "primary_subject", "match_source": match_source, "match_confidence": match_conf}
        for cid, folder_key, match_source, match_conf in con.execute(
            "select canonical_id, person_folder_key, person_match_source, person_match_confidence "
            "from canonical_items where person_folder_key is not null"
        ).fetchall()
    ]
    for batch in chunks(edge_rows, 500):
        sb.table("archive_item_people").upsert(batch, on_conflict="archive_item_id,person_id,role").execute()
    print(f"upserted {len(edge_rows)} archive_item_people edges")

    print("-- archive_item_files --")
    file_rows = [
        {"archive_item_id": cid, "full_path": path, "role": role, "extension": ext,
         "size_mb": size, "project": project, "quality_guess": quality, "last_write_time": lwt}
        for cid, path, role, ext, size, project, quality, lwt in con.execute(
            "select canonical_id, full_path, role, extension, size_mb, project, quality_guess, last_write_time "
            "from files where canonical_id is not null"
        ).fetchall()
    ]
    for batch in chunks(file_rows, 1000):
        sb.table("archive_item_files").upsert(batch, on_conflict="archive_item_id,full_path").execute()
    print(f"upserted {len(file_rows)} archive_item_files")

    print("-- archive_item_tags --")
    tag_rows = [
        {"archive_item_id": cid, "label": label, "kind": kind, "source": source}
        for cid, label, kind, source in con.execute(
            "select canonical_id, label, kind, source from item_tags"
        ).fetchall()
    ]
    for batch in chunks(tag_rows, 1000):
        sb.table("archive_item_tags").upsert(batch, on_conflict="archive_item_id,label").execute()
    print(f"upserted {len(tag_rows)} archive_item_tags")

    print("-- legislation --")
    cspan_con = sqlite3.connect(config.CSPAN_DISCOVERY_DB)
    legislation_rows = cspan_con.execute(
        "select distinct congress, bill_type, bill_number, title, display from legislation"
    ).fetchall()
    leg_payload = [
        {"congress": c, "bill_type": bt, "bill_number": bn, "title": t, "display": d}
        for c, bt, bn, t, d in legislation_rows
    ]
    for batch in chunks(leg_payload, 500):
        sb.table("legislation").upsert(batch, on_conflict="congress,bill_type,bill_number").execute()
    print(f"upserted {len(leg_payload)} legislation rows")

    leg_id_map = {
        (r["congress"], r["bill_type"], r["bill_number"]): None for r in leg_payload
    }
    resp = sb.table("legislation").select("id, congress, bill_type, bill_number").execute()
    for r in resp.data:
        leg_id_map[(r["congress"], r["bill_type"], r["bill_number"])] = r["id"]

    link_rows = []
    for program_id, congress, bill_type, bill_number, _t, _d in cspan_con.execute(
        "select program_id, congress, bill_type, bill_number, title, display from legislation"
    ).fetchall():
        leg_id = leg_id_map.get((congress, bill_type, bill_number))
        if leg_id:
            link_rows.append({"archive_item_id": str(program_id), "legislation_id": leg_id})
    for batch in chunks(link_rows, 500):
        sb.table("archive_item_legislation").upsert(batch, on_conflict="archive_item_id,legislation_id").execute()
    print(f"upserted {len(link_rows)} archive_item_legislation links")

    con.close()
    cspan_con.close()
    print("\ndone.")


if __name__ == "__main__":
    main()
