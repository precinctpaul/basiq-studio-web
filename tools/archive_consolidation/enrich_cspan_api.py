"""Step 2n: live C-SPAN Archives API backfill for CSPAN-numeric items with
no local metadata at all -- the C-SPAN counterpart to enrich_youtube_api.py.

Same shape as that pass, different constraint: the C-SPAN Archives API
(api.c-spanarchives.org/2.0) has no batch endpoint like YouTube's
videos.list -- it's one program per request (programs/{program_id}), so
this is throttled to one request every 1.2s rather than done in bulk.
Auth style and rate-limit convention both mirror
C:\\dev\\cspan_discovery\\backfill_cspan_official.py, which already uses
this same API successfully for its 922 programs.

The site's own /video/?<id> and /program/... pages are client-rendered
(confirmed by hand -- no title, meta tags, or embedded JSON in the raw
HTML), so this API is the only real way in short of full browser
automation per item.
"""

import argparse
import time

import requests

import config
import schema

API_ROOT = "https://api.c-spanarchives.org/2.0"


def load_api_key() -> str:
    env_path = config.TOOL_DIR.parent.parent / ".env.local"
    with open(env_path, encoding="utf-8") as f:
        for line in f:
            if line.startswith("CSPAN_API_KEY="):
                return line.split("=", 1)[1].strip()
    raise RuntimeError("CSPAN_API_KEY not found in .env.local")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--delay", type=float, default=1.2)
    args = parser.parse_args()

    headers = {
        "Accept": "application/json",
        "User-Agent": "basiq-archive-consolidation/1.0",
        "X-API-Key": load_api_key(),
    }

    con = schema.connect(config.INDEX_DB)
    program_ids = [
        r[0] for r in con.execute(
            "select canonical_id from canonical_items where title is null and id_type = 'CSPAN'"
        ).fetchall()
    ]
    if args.limit:
        program_ids = program_ids[: args.limit]

    found = 0
    not_found = []
    errors = []

    with con:
        for i, program_id in enumerate(program_ids):
            try:
                resp = requests.get(f"{API_ROOT}/programs/{program_id}", headers=headers, timeout=20)
            except requests.RequestException as e:
                errors.append((program_id, str(e)))
                continue

            if resp.status_code == 404:
                not_found.append(program_id)
            elif resp.status_code != 200:
                errors.append((program_id, f"HTTP {resp.status_code}"))
            else:
                data = resp.json()
                con.execute(
                    """update canonical_items
                       set title = ?, description = ?, duration_seconds = ?,
                           publish_date = date(?), date_source = 'published',
                           metadata_source = 'cspan_api_live',
                           notes = coalesce(notes || ' | ', '') || 'source_url=' || ?
                       where canonical_id = ?""",
                    (data.get("title"), data.get("description"), data.get("videoDuration"),
                     data.get("date"), data.get("videoLink"), program_id),
                )
                found += 1

            if i < len(program_ids) - 1:
                time.sleep(args.delay)

    print(f"program IDs queried: {len(program_ids)}")
    print(f"found:               {found}")
    print(f"not found (404):     {len(not_found)}  {not_found[:10]}")
    print(f"errors:              {len(errors)}  {errors[:5]}")

    con.close()


if __name__ == "__main__":
    main()
