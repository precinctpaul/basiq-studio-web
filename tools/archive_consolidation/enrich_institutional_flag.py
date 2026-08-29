"""Step 2j: extend is_institutional beyond cspan_discovery's 922 items.

enrich_cspan_discovery.py only ever applied the institutional-title regex
to the items it was enriching (922 CSPAN programs) -- it was never run
against items whose title came from a different source (metadata
sidecars, the youtube indexer, fuzzy match), so a YouTube upload of the
same "Morning Hour" floor session was invisible to it. Same regex,
applied archive-wide now that every titled item is a candidate.
"""

import re

import config
import schema

_INSTITUTIONAL_PATTERNS = re.compile(
    r"(House Session|Senate Session|Morning Hour|Daily Briefing|"
    r"Cabinet Meeting|News Conference|Press Briefing|Speaks to Reporters|"
    r"Republican Agenda|Democratic Agenda|Weekly Briefing|Pen and Pad)",
    re.IGNORECASE,
)


def main():
    con = schema.connect(config.INDEX_DB)

    rows = con.execute(
        "select canonical_id, title from canonical_items where title is not null and is_institutional = 0"
    ).fetchall()

    newly_flagged = 0
    with con:
        for canonical_id, title in rows:
            if _INSTITUTIONAL_PATTERNS.search(title):
                con.execute(
                    "update canonical_items set is_institutional = 1 where canonical_id = ?",
                    (canonical_id,),
                )
                newly_flagged += 1

    (total,) = con.execute("select count(*) from canonical_items where is_institutional = 1").fetchone()
    print(f"newly flagged institutional: {newly_flagged}")
    print(f"total institutional now:     {total}")

    con.close()


if __name__ == "__main__":
    main()
