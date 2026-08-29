"""Step 2o: commits the honorific + surname match validated in
dryrun_honorific_surname_match.py -- same logic, this time writing
person_bioguide_id/person_folder_key for every item that resolved
cleanly (exactly one tracked person's chamber+surname pattern matched).
Chamber+surname collisions within the tracked pool (Smith, Kelly, Torres
as of this run) are still skipped, never guessed.
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

    by_chamber_surname = defaultdict(list)
    for bid in tracked_bioguide_ids:
        ref = reference.get(bid)
        if not ref:
            continue
        chamber = "Senate" if ref["latest_chamber"] == "Senate" else "House"
        by_chamber_surname[(chamber, ref["last_name"].lower())].append(bid)

    clean = {k: v[0] for k, v in by_chamber_surname.items() if len(v) == 1}
    collisions = {k: v for k, v in by_chamber_surname.items() if len(v) > 1}

    patterns = []
    for (chamber, last), bid in clean.items():
        honorific = _HONORIFIC_SENATE if chamber == "Senate" else _HONORIFIC_HOUSE
        last_escaped = re.escape(reference[bid]["last_name"])
        patterns.append((re.compile(rf"\b{honorific}\.?\s+{last_escaped}\b", re.IGNORECASE), bid))

    rows = con.execute(
        "select canonical_id, title, description from canonical_items "
        "where person_folder_key is null and is_institutional = 0 and title is not null"
    ).fetchall()

    resolved = 0
    ambiguous = 0
    with con:
        for canonical_id, title, description in rows:
            text = f"{title or ''} {description or ''}"
            hits = {bid for pattern, bid in patterns if pattern.search(text)}
            if len(hits) != 1:
                if len(hits) > 1:
                    ambiguous += 1
                continue
            bid = next(iter(hits))
            ref = reference[bid]
            con.execute(
                """update canonical_items
                   set person_bioguide_id = ?, person_first_name = ?, person_last_name = ?,
                       person_match_source = 'honorific_surname_match', person_match_confidence = 0.8,
                       person_folder_key = ?, person_identifier_type = 'bioguide'
                   where canonical_id = ?""",
                (bid, ref["first_name"], ref["last_name"], bid, canonical_id),
            )
            resolved += 1

    print(f"tracked people:          {len(tracked_bioguide_ids)}")
    print(f"chamber+surname collisions (skipped): {len(collisions)}")
    for (chamber, last), ids in collisions.items():
        print(f"  {chamber} {last}: {[reference[i]['full_name'] for i in ids]}")
    print(f"items considered:        {len(rows)}")
    print(f"newly resolved:          {resolved}")
    print(f"ambiguous (skipped):     {ambiguous}")

    con.close()


if __name__ == "__main__":
    main()
