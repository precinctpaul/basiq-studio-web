"""Step 2a: enrich CSPAN canonical items from cspan_discovery.sqlite3.

cspan_discovery's `programs` table is the richest structured source
available for the C-SPAN side: 922 programs, all 922 of which are already
present in the registry as CSPAN canonical items (checked directly, not
assumed). It has real titles, ISO dates, descriptions, and durations --
no filename parsing or fuzzy matching needed for this slice.

It also flags institutional content (floor sessions, daily briefings,
cabinet meetings) via is_institutional, because ~39% of programs here
have no single-person subject at all (a Senate floor session might
feature dozens of members) -- that's a real gap in the brief's
person-folder plan, not a parsing detail, and downstream person
resolution needs to know not to force a primary person onto these.
"""

import json
import re
import sqlite3

import config
import schema

_INSTITUTIONAL_PATTERNS = re.compile(
    r"(House Session|Senate Session|Morning Hour|Daily Briefing|"
    r"Cabinet Meeting|News Conference|Press Briefing|Speaks to Reporters|"
    r"Republican Agenda|Democratic Agenda|Weekly Briefing|Pen and Pad)",
    re.IGNORECASE,
)


def parse_date(raw: str) -> str | None:
    if not raw:
        return None
    # "2019-12-16T00:00:00-05:00" or plain "2022-07-13"
    return raw[:10]


def main():
    cspan_con = sqlite3.connect(config.CSPAN_DISCOVERY_DB)
    idx = schema.connect(config.INDEX_DB)

    registry_cspan_ids = {
        r[0] for r in idx.execute("select canonical_id from canonical_items where id_type = 'CSPAN'")
    }

    updated = 0
    institutional = 0
    not_in_registry = 0

    with idx:
        for program_id, title, program_date, description, duration_seconds, raw_json in cspan_con.execute(
            "select program_id, title, program_date, description, duration_seconds, raw_json from programs"
        ):
            canonical_id = str(program_id)
            if canonical_id not in registry_cspan_ids:
                not_in_registry += 1
                continue

            is_inst = bool(_INSTITUTIONAL_PATTERNS.search(title or ""))
            if is_inst:
                institutional += 1

            canonical_url = None
            try:
                canonical_url = json.loads(raw_json).get("canonical_url")
            except (TypeError, ValueError, AttributeError):
                pass

            notes = f"canonical_url={canonical_url}" if canonical_url else None

            idx.execute(
                """update canonical_items
                   set title = ?, description = ?, duration_seconds = ?,
                       publish_date = ?, date_source = 'published',
                       metadata_source = 'cspan_discovery_db',
                       is_institutional = ?,
                       notes = coalesce(notes || ' | ' || ?, ?)
                   where canonical_id = ?""",
                (title, description, duration_seconds, parse_date(program_date),
                 1 if is_inst else 0, notes, notes, canonical_id),
            )
            updated += 1

    print(f"cspan_discovery programs seen:      {cspan_con.execute('select count(*) from programs').fetchone()[0]}")
    print(f"not found in registry (unexpected): {not_in_registry}")
    print(f"canonical_items updated:            {updated}")
    print(f"  of which flagged institutional:   {institutional}")

    idx.close()
    cspan_con.close()


if __name__ == "__main__":
    main()
