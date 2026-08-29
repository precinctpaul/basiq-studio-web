"""Step 2f: last-resort person resolution by name-matching title/description.

Only runs on canonical items that still have no person_bioguide_id after
every structured source (filename convention, cspan_discovery speaker
IDs, indexer video_people links) has had a chance. Matches full
"First Last" names for the 531 sitting 119th-Congress members only (see
people.py for why) -- there are zero first+last name collisions in that
set, so an exact, word-bounded, case-insensitive match is about as safe
as fuzzy matching gets.

A name appearing in the title is trusted (that's what the content is
named after); a name appearing only in the description is recorded with
lower confidence, since a member can be mentioned in passing without the
clip being about them. An item mentioning more than one current member in
the title is left unresolved rather than guessing which one is primary --
that ambiguity is real, not a parsing failure.
"""

import re

import config
import people
import schema


def build_matcher(name_index: dict[str, list[str]]):
    # Longest names first so "Kristen McDonald Rivet" (multi-word) doesn't
    # get shadowed by a shorter accidental match.
    names = sorted(name_index.keys(), key=len, reverse=True)
    pattern = re.compile(
        r"\b(" + "|".join(re.escape(n) for n in names) + r")\b",
        re.IGNORECASE,
    )
    return pattern


def find_matches(text: str, pattern: re.Pattern, name_index: dict[str, list[str]]) -> set[str]:
    if not text:
        return set()
    found = {m.group(1).lower() for m in pattern.finditer(text)}
    bioguide_ids = set()
    for name in found:
        bioguide_ids.update(name_index[name])
    return bioguide_ids


def main():
    con = schema.connect(config.INDEX_DB)
    reference = people.load_bioguide_reference()
    name_index = people.build_current_member_index()
    pattern = build_matcher(name_index)

    rows = con.execute(
        """select canonical_id, title, description from canonical_items
           where person_bioguide_id is null and person_folder_key is null
             and (title is not null or description is not null)"""
    ).fetchall()

    resolved_from_title = 0
    resolved_from_description = 0
    ambiguous_title = 0
    updated_ids = []

    with con:
        for canonical_id, title, description in rows:
            title_matches = find_matches(title, pattern, name_index)
            if len(title_matches) == 1:
                bid = next(iter(title_matches))
                ref = reference[bid]
                con.execute(
                    """update canonical_items
                       set person_bioguide_id = ?, person_first_name = ?, person_last_name = ?,
                           person_match_source = 'fuzzy_title_match', person_match_confidence = 0.85
                       where canonical_id = ?""",
                    (bid, ref["first_name"], ref["last_name"], canonical_id),
                )
                resolved_from_title += 1
                updated_ids.append(canonical_id)
                continue
            if len(title_matches) > 1:
                ambiguous_title += 1
                continue

            desc_matches = find_matches(description, pattern, name_index)
            if len(desc_matches) == 1:
                bid = next(iter(desc_matches))
                ref = reference[bid]
                con.execute(
                    """update canonical_items
                       set person_bioguide_id = ?, person_first_name = ?, person_last_name = ?,
                           person_match_source = 'fuzzy_description_match', person_match_confidence = 0.5
                       where canonical_id = ?""",
                    (bid, ref["first_name"], ref["last_name"], canonical_id),
                )
                resolved_from_description += 1
                updated_ids.append(canonical_id)

    print(f"canonical items considered (no person yet, have title/description): {len(rows)}")
    print(f"resolved from a single title match:       {resolved_from_title}  (confidence 0.85)")
    print(f"resolved from a single description match: {resolved_from_description}  (confidence 0.50)")
    print(f"left unresolved -- title mentions >1 current member: {ambiguous_title}")
    print(f"total newly resolved: {len(updated_ids)}")

    con.close()


if __name__ == "__main__":
    main()
