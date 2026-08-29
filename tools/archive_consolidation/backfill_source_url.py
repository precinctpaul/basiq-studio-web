"""Step 5b: pull a real source_url out of the free-text notes field.

Several enrichment passes wrote a URL into notes as "canonical_url=..." or
"source_url=..." (pipe-separated from whatever else is in there) instead of
a dedicated column, since no such column existed until now. This parses
those two prefixes out and backfills the new canonical_items.source_url
column. Safe to re-run: only touches rows where source_url is still NULL.
"""

import re

import config
import schema

_URL_RE = re.compile(r"(?:canonical_url|source_url)=(\S+)")


def main():
    con = schema.connect(config.INDEX_DB)
    rows = con.execute(
        "select canonical_id, notes from canonical_items where source_url is null and notes is not null"
    ).fetchall()

    updated = 0
    with con:
        for canonical_id, notes in rows:
            m = _URL_RE.search(notes)
            if not m:
                continue
            url = m.group(1).rstrip("|").strip()
            if not url.startswith("http"):
                continue
            con.execute(
                "update canonical_items set source_url = ? where canonical_id = ?",
                (url, canonical_id),
            )
            updated += 1

    print(f"rows considered: {len(rows)}")
    print(f"source_url backfilled: {updated}")
    con.close()


if __name__ == "__main__":
    main()
