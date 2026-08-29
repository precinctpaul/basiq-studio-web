"""DRY RUN ONLY -- writes nothing to the index. Reports what an
honorific + surname match (e.g. "Sen. Bennet", "Rep. Auchincloss") would
resolve if scoped to people ALREADY confirmed relevant to this archive
(everyone currently holding a real BioGuideID in the index -- current
members, ex-Congress cabinet, and every hand-verified former member from
the video_lookup corrections), rather than the full historical BioGuide
table. This is the same "Chamber Title + Last Name" tier fill_all_videos.py
used, just scoped to a pool we've already verified appears in this
specific archive instead of all 12,769 people in US history.

Chamber-disambiguated: "Sen. Scott" and "Rep. Scott" are different
people if both exist in the tracked pool, so the honorific's implied
chamber is part of the match key, not just the bare surname. A surname
that collides within the SAME chamber (two tracked senators named X) is
reported as a skipped collision, never guessed.
"""

import csv
import re
from collections import defaultdict

import config
import schema

_HONORIFIC_SENATE = r"(?:Sen\.|Senator|Sen)"
_HONORIFIC_HOUSE = r"(?:Rep\.|Representative|Rep|Congressman|Congresswoman|U\.S\.\s+Congressman|U\.S\.\s+Congresswoman)"


def load_reference():
    with open(config.BIOGUIDE_CSV, encoding="utf-8") as f:
        return {r["bioguide_id"]: r for r in csv.DictReader(f)}


def main():
    con = schema.connect(config.INDEX_DB)
    reference = load_reference()

    tracked_bioguide_ids = {
        r[0] for r in con.execute(
            "select distinct person_bioguide_id from canonical_items where person_identifier_type = 'bioguide'"
        ).fetchall()
    }
    print(f"tracked people with a real BioGuideID already in this archive: {len(tracked_bioguide_ids)}")

    # (chamber, last_name.lower()) -> [bioguide_id, ...]
    by_chamber_surname = defaultdict(list)
    for bid in tracked_bioguide_ids:
        ref = reference.get(bid)
        if not ref:
            continue
        chamber = "Senate" if ref["latest_chamber"] == "Senate" else "House"
        by_chamber_surname[(chamber, ref["last_name"].lower())].append(bid)

    collisions = {k: v for k, v in by_chamber_surname.items() if len(v) > 1}
    print(f"chamber+surname collisions within the tracked pool (skipped, not guessed): {len(collisions)}")
    for (chamber, last), ids in collisions.items():
        names = [reference[i]["full_name"] for i in ids]
        print(f"  {chamber} {last}: {names}")

    clean = {k: v[0] for k, v in by_chamber_surname.items() if len(v) == 1}

    patterns = []
    for (chamber, last), bid in clean.items():
        honorific = _HONORIFIC_SENATE if chamber == "Senate" else _HONORIFIC_HOUSE
        last_escaped = re.escape(reference[bid]["last_name"])
        patterns.append((re.compile(rf"\b{honorific}\.?\s+{last_escaped}\b", re.IGNORECASE), bid))

    rows = con.execute(
        "select canonical_id, title, description from canonical_items "
        "where person_folder_key is null and is_institutional = 0 and title is not null"
    ).fetchall()

    would_resolve = []
    ambiguous_multi_pattern = 0
    for canonical_id, title, description in rows:
        text = f"{title or ''} {description or ''}"
        hits = {bid for pattern, bid in patterns if pattern.search(text)}
        if len(hits) == 1:
            would_resolve.append((canonical_id, title, next(iter(hits))))
        elif len(hits) > 1:
            ambiguous_multi_pattern += 1

    print(f"\nitems considered: {len(rows)}")
    print(f"would resolve cleanly: {len(would_resolve)}")
    print(f"ambiguous (matched >1 tracked person's honorific+surname): {ambiguous_multi_pattern}")

    print("\nsample of what would resolve:")
    for canonical_id, title, bid in would_resolve[:25]:
        print(f"  [{reference[bid]['full_name']:25s}] {title[:80]}")

    from collections import Counter
    person_counts = Counter(reference[bid]["full_name"] for _, _, bid in would_resolve)
    print("\nby person:")
    for name, n in person_counts.most_common(30):
        print(f"  {n:4d}  {name}")

    con.close()


if __name__ == "__main__":
    main()
