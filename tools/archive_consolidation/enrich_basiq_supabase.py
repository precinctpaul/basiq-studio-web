"""Step 2g: enrich BasiqUUID canonical items from Supabase's videos table.

Basiq Studio Hub's own database (public.videos) already has real title/
uploader/channel/source_url for a meaningful slice of the 92 Basiq-
internal-only canonical items -- confirmed by hand earlier (35/92
matched). Many of these turn out to be non-congressional social clips
(X/Twitter reaction posts, Instagram reels, live-test captures), which is
exactly why this only fills in title/description/source_url and never
guesses a person from it.
"""

import os

from supabase import create_client

import config
import schema


def to_uuid(raw: str) -> str:
    return "-".join([raw[0:8], raw[8:12], raw[12:16], raw[16:20], raw[20:]])


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


def main():
    env = load_env(config.TOOL_DIR.parent.parent / ".env.local")
    supabase = create_client(env["NEXT_PUBLIC_SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"])

    con = schema.connect(config.INDEX_DB)
    raw_ids = [
        r[0] for r in con.execute(
            "select canonical_id from canonical_items where id_type = 'BasiqUUID' and title is null"
        )
    ]
    uuid_map = {to_uuid(r): r for r in raw_ids}

    resp = supabase.table("videos").select(
        "id, title, uploader, channel, source_url, duration_seconds, created_at"
    ).in_("id", list(uuid_map.keys())).execute()

    updated = 0
    with con:
        for row in resp.data:
            canonical_id = uuid_map[row["id"]]
            title = row.get("title")
            if not title or title == "Untitled":
                continue
            con.execute(
                """update canonical_items
                   set title = ?, duration_seconds = nullif(?, 0),
                       publish_date = date(?), date_source = 'basiq_ingested_at',
                       metadata_source = 'basiq_supabase_videos',
                       notes = coalesce(notes || ' | ', '') || 'uploader=' || coalesce(?, '') || ' source_url=' || coalesce(?, '')
                   where canonical_id = ?""",
                (title, row.get("duration_seconds"), row.get("created_at"),
                 row.get("uploader"), row.get("source_url"), canonical_id),
            )
            updated += 1

    print(f"BasiqUUID items still needing a title: {len(raw_ids)}")
    print(f"matched in Supabase videos table:      {len(resp.data)}")
    print(f"newly enriched (had a real title):     {updated}")

    con.close()


if __name__ == "__main__":
    main()
