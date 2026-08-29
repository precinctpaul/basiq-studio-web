"""Step 2l: apply hand-verified corrections to specific suspect rows from
video_lookup_complete.csv.

These are not re-derived by any heuristic -- they're exactly what was
manually checked against c-span.org/person pages and confirmed in the
conversation this was decided in. Two are the confirmed collision bugs
(S000351/P000025 resolving to the wrong 19th-century person entirely);
two are legitimate former members that the "channel confirms the match"
check couldn't verify because they were uploaded to the generic C-SPAN
channel rather than their own, not because the match was wrong.
"""

import csv

import config
import schema
import target_naming

CSV_PATH = config.TOOL_DIR.parent / "video_lookup_complete.csv"

# original (wrong) BioGuideID or Person value in the source file -> correction
BIOGUIDE_CORRECTIONS = {
    # bad BioGuideID -> the real person, as a real BioGuideID
    "S000351": {"kind": "bioguide", "bioguide_id": "S001207", "first": "Mikie", "last": "Sherrill"},
    # bad BioGuideID -> the real person, who has NO federal BioGuideID at all
    "P000025": {"kind": "name_slug", "first": "Paige", "last": "Cognetti"},
    # Same collision pattern as S000351/P000025, found later via the
    # honorific+surname dry run: "Sen. Mallory McMorrow" (her own channel)
    # matched M000084 (a 19th/20th-century FL federal senator named Stephen
    # Mallory) because her FIRST name happens to be his surname. She's a
    # Michigan STATE senator, never in the US Congress -- no real
    # BioGuideID exists for her.
    "M000084": {"kind": "name_slug", "first": "Mallory", "last": "McMorrow"},
}
PERSON_CORRECTIONS = {
    # Person value -> verified-correct BioGuideID (legitimate former member,
    # just uploaded to the generic C-SPAN channel so the channel-confirms
    # check couldn't verify it on its own)
    "Trey Gowdy": {"kind": "bioguide", "bioguide_id": "G000566", "first": "Trey", "last": "Gowdy"},
    "Joe Manchin, III": {"kind": "bioguide", "bioguide_id": "M001183", "first": "Joe", "last": "Manchin"},
    # Confirmed correct on both their own-channel uploads (already trusted)
    # AND their C-SPAN-uploaded appearances (generic "C-SPAN" channel,
    # which the automated channel-check can't verify on its own) -- this
    # closes the residual gap left when only the own-channel rows imported.
    "Abigail Davis Spanberger": {"kind": "bioguide", "bioguide_id": "S001209", "first": "Abigail", "last": "Spanberger"},
    "Mary Sattler Peltola": {"kind": "bioguide", "bioguide_id": "P000619", "first": "Mary", "last": "Peltola"},
    # Confirmed good to import -- internally consistent (name genuinely
    # matches the reference record, no collision), just historical figures
    # rather than current/recent members.
    "Barack Obama": {"kind": "bioguide", "bioguide_id": "O000167", "first": "Barack", "last": "Obama"},
    "Dave Brat": {"kind": "bioguide", "bioguide_id": "B001290", "first": "Dave", "last": "Brat"},
    "Hillary Clinton": {"kind": "bioguide", "bioguide_id": "C001041", "first": "Hillary", "last": "Clinton"},
    "James Monroe": {"kind": "bioguide", "bioguide_id": "M000858", "first": "James", "last": "Monroe"},
    "Don Young": {"kind": "bioguide", "bioguide_id": "Y000033", "first": "Don", "last": "Young"},
    "Richard Nixon": {"kind": "bioguide", "bioguide_id": "N000116", "first": "Richard", "last": "Nixon"},
}


def main():
    con = schema.connect(config.INDEX_DB)
    with open(CSV_PATH, encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))

    registry_ids = {r[0] for r in con.execute("select canonical_id from canonical_items")}

    applied = {}
    with con:
        for row in rows:
            canonical_id = row["URL Extension"].strip()
            if canonical_id not in registry_ids:
                continue

            correction = BIOGUIDE_CORRECTIONS.get(row["BioGuide ID"].strip()) \
                or PERSON_CORRECTIONS.get(row["Person"].strip())
            if not correction:
                continue

            if correction["kind"] == "bioguide":
                bg = correction["bioguide_id"]
                con.execute(
                    """update canonical_items
                       set person_bioguide_id = ?, person_first_name = ?, person_last_name = ?,
                           person_match_source = 'manual_correction', person_match_confidence = 1.0,
                           person_folder_key = ?, person_identifier_type = 'bioguide'
                       where canonical_id = ?""",
                    (bg, correction["first"], correction["last"], bg, canonical_id),
                )
            else:  # name_slug
                slug = target_naming.sanitize(f"{correction['last']}_{correction['first']}".lower())
                con.execute(
                    """update canonical_items
                       set person_bioguide_id = null, person_first_name = ?, person_last_name = ?,
                           person_match_source = 'manual_correction', person_match_confidence = 1.0,
                           person_folder_key = ?, person_identifier_type = 'name_slug'
                       where canonical_id = ?""",
                    (correction["first"], correction["last"], f"nc_{slug}", canonical_id),
                )
            key = f"{row['BioGuide ID'].strip() or row['Person'].strip()}"
            applied[key] = applied.get(key, 0) + 1

    print("corrections applied:")
    for k, v in applied.items():
        print(f"  {k}: {v} items")
    print(f"total: {sum(applied.values())}")

    con.close()


if __name__ == "__main__":
    main()
