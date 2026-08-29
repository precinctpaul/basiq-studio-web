"""Step 2h: resolve cabinet/administration figures the Congress-only
fuzzy matcher (enrich_fuzzy_person_match.py) can never find -- it's
scoped to the 531 sitting 119th-Congress members on purpose (see
people.py), so a cabinet secretary with no current committee seat is
invisible to it even if they used to serve.

Two groups, decided with the user directly:
  - 7 cabinet/administration officials who DO have a real BioGuideID from
    past House/Senate service (Rubio, Duffy, Collins, Mullin, Ratcliffe,
    Zeldin, Loeffler) -- these get filed under that BioGuideID exactly
    like a sitting member would.
  - 15 high-volume figures with no BioGuideID at all (Trump 184 mentions,
    Hegseth 73, Vance 51, etc.) -- these get a name_slug identifier
    instead, so the folder builder can give them their own folder without
    inventing a fake BioGuideID.

Also backfills person_folder_key/person_identifier_type for every item
already resolved by an earlier pass (filename convention, cspan_discovery
speaker IDs, indexer video_people, current-Congress fuzzy match), so the
folder builder has one column to key off regardless of which pass
resolved a given item.
"""

import re

import config
import schema

# (full name to match, bioguide_id) -- confirmed by hand against the
# reference CSV; see the conversation this was decided in.
EX_CONGRESS_CABINET = [
    ("Marco Rubio", "R000595"),
    ("Sean Duffy", "D000614"),
    ("Doug Collins", "C001093"),
    ("Markwayne Mullin", "M001190"),
    ("John Ratcliffe", "R000601"),
    ("Lee Zeldin", "Z000017"),
    ("Kelly Loeffler", "L000594"),
]

# Never served in Congress -- no BioGuideID exists to file these under.
NAME_SLUG_FIGURES = [
    "Donald Trump", "Pete Hegseth", "JD Vance", "Scott Bessent", "Todd Blanche",
    "Robert F. Kennedy", "Doug Burgum", "Brooke Rollins", "Howard Lutnick",
    "Scott Turner", "Linda McMahon", "Jamieson Greer", "Chris Wright",
    "Keith Sonderling", "Aaron Lukas",
]


def slugify(first: str, last: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", f"{last}_{first}".lower()).strip("_")


def find_matches(text: str, pattern: re.Pattern) -> bool:
    return bool(text and pattern.search(text))


def main():
    con = schema.connect(config.INDEX_DB)

    # -- 7 ex-Congress cabinet officials --
    cabinet_resolved = 0
    with con:
        for full_name, bioguide_id in EX_CONGRESS_CABINET:
            first, last = full_name.split(" ", 1)[0], full_name.split(" ")[-1]
            pattern = re.compile(r"\b" + re.escape(full_name) + r"\b", re.IGNORECASE)
            rows = con.execute(
                "select canonical_id, title, description from canonical_items "
                "where person_bioguide_id is null and person_folder_key is null"
            ).fetchall()
            for canonical_id, title, description in rows:
                if find_matches(title, pattern) or find_matches(description, pattern):
                    con.execute(
                        """update canonical_items
                           set person_bioguide_id = ?, person_first_name = ?, person_last_name = ?,
                               person_match_source = 'notable_figure_ex_congress', person_match_confidence = 0.85,
                               person_folder_key = ?, person_identifier_type = 'bioguide'
                           where canonical_id = ?""",
                        (bioguide_id, first, last, bioguide_id, canonical_id),
                    )
                    cabinet_resolved += 1

    # -- 15 name-slug figures (no BioGuideID) --
    slug_resolved = 0
    with con:
        for full_name in NAME_SLUG_FIGURES:
            first, last = full_name.split(" ", 1)[0], full_name.split(" ")[-1]
            slug = slugify(first, last)
            pattern = re.compile(r"\b" + re.escape(full_name) + r"\b", re.IGNORECASE)
            rows = con.execute(
                "select canonical_id, title, description from canonical_items where person_bioguide_id is null and person_folder_key is null"
            ).fetchall()
            for canonical_id, title, description in rows:
                if find_matches(title, pattern) or find_matches(description, pattern):
                    con.execute(
                        """update canonical_items
                           set person_first_name = ?, person_last_name = ?,
                               person_match_source = 'notable_figure_name_slug', person_match_confidence = 0.75,
                               person_folder_key = ?, person_identifier_type = 'name_slug'
                           where canonical_id = ?""",
                        (first, last, slug, canonical_id),
                    )
                    slug_resolved += 1

    # -- backfill folder_key for everyone already resolved by an earlier pass --
    with con:
        con.execute(
            """update canonical_items
               set person_folder_key = person_bioguide_id, person_identifier_type = 'bioguide'
               where person_bioguide_id is not null and person_folder_key is null"""
        )

    print(f"ex-Congress cabinet items resolved: {cabinet_resolved}")
    print(f"name-slug figures resolved:         {slug_resolved}")
    (total_keyed,) = con.execute("select count(*) from canonical_items where person_folder_key is not null").fetchone()
    print(f"total canonical items with a person_folder_key: {total_keyed}")
    print("\nname_slug breakdown:")
    for row in con.execute(
        "select person_folder_key, count(*) from canonical_items where person_identifier_type='name_slug' group by 1 order by 2 desc"
    ):
        print(f"  {row[0]:25s} {row[1]}")

    con.close()


if __name__ == "__main__":
    main()
