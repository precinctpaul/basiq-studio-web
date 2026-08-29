"""Step 2p: import Resolved_Master_Inventory_with_Smart_IDs.xlsx.

The file's own "canonical_id" column (present in the first version handed
over) was internally inconsistent with its own VideoURL column for 86.5%
of rows (22,548 / 26,051) -- almost certainly an Excel sort/paste that
moved one column independently of the others. The user re-sent it with
that column removed once this was flagged. The real join key used here is
the YouTube ID parsed directly out of VideoURL, which IS internally
consistent: every one of the 4,679 distinct real video IDs has identical
channel/name/ID data across every duplicate row (checked by hand, zero
conflicts) -- the underlying resolution work is sound, only that one
derived column was broken.

Four ID_Source tiers, handled differently by how verifiable they are:
  Local_BioGuide / Congress_API (3,105 videos) - a real BioGuideID.
    Validated against the reference CSV by hand: 0 not-found, 0 name
    mismatches (i.e. none of the Sherrill/Paige/Mallory-style collisions
    found in earlier batches this project imported).
  OpenStates_API (625 videos)  - a state legislator with no federal
    BioGuideID -> name_slug, same treatment as Talarico/McMorrow, with the
    OpenStates id kept in notes.
  Group/System (887 videos)   - institutional channels (C-SPAN, House
    committees) with no person at all -> is_institutional, not a person.
  Fallback_Split (62 videos, only 4 distinct people) - a best-guess name
    split with NO verifying ID at all. Small enough to check by hand
    rather than trust or discard wholesale:
      - "Pat Ryan" -> already a tracked member (R000579), just resolved
        via bioguide directly instead of guessing.
      - "Josh Turek" -> real Iowa state rep, confirmed on OpenStates by a
        direct lookup (the file's own OpenStates pass evidently missed him).
      - "Mayor Of Milwaukee Cavalier Johnson" -> the file's own name-split
        bug ("Mayor" / "Of Milwaukee Cavalier Johnson"); the real name is
        Cavalier Johnson, Mayor of Milwaukee.
      - "Jamie Ager" -> imported as a plain name_slug; nothing to verify
        against, low volume either way.
"""

import csv

import openpyxl

import config
import schema
import target_naming

XLSX_PATH = config.TOOL_DIR / "output" / "Resolved_Master_Inventory_with_Smart_IDs.xlsx"

# Hand-resolved corrections for the 4 Fallback_Split people (see docstring).
FALLBACK_OVERRIDES = {
    ("Pat", "Ryan"): {"kind": "bioguide", "bioguide_id": "R000579", "first": "Patrick", "last": "Ryan"},
    ("Josh", "Turek"): {"kind": "name_slug", "first": "Josh", "last": "Turek",
                         "note": "openstates_id=ocd-person/c9679bfc-5a21-405a-bae1-e2de9a85baf8 role=IA House District 20"},
    ("Mayor", "Of Milwaukee Cavalier Johnson"): {"kind": "name_slug", "first": "Cavalier", "last": "Johnson",
                                                  "note": "Mayor of Milwaukee; source file split this name incorrectly"},
    ("Jamie", "Ager"): {"kind": "name_slug", "first": "Jamie", "last": "Ager"},
}


def load_reference():
    with open(config.BIOGUIDE_CSV, encoding="utf-8") as f:
        return {r["bioguide_id"]: r for r in csv.DictReader(f)}


def extract_real_id(url: str) -> str | None:
    if not url or "watch?v=" not in str(url):
        return None
    return str(url).split("watch?v=")[1][:11]


def dedupe_by_real_id(rows) -> dict[str, tuple]:
    by_id = {}
    for url, channel, chan_id, first, last, official_id, source in rows:
        real_id = extract_real_id(url)
        if real_id:
            by_id[real_id] = (channel, first, last, official_id, source)
    return by_id


def main():
    reference = load_reference()
    wb = openpyxl.load_workbook(XLSX_PATH, read_only=True, data_only=True)
    ws = wb["Sheet1"]
    rows = list(ws.iter_rows(min_row=2, values_only=True))
    by_real_id = dedupe_by_real_id(rows)
    print(f"distinct videos in file: {len(by_real_id)}")

    con = schema.connect(config.INDEX_DB)
    registry_ids = {r[0] for r in con.execute("select canonical_id from canonical_items")}
    already_resolved = {
        r[0] for r in con.execute("select canonical_id from canonical_items where person_folder_key is not null")
    }

    counts = {"bioguide": 0, "name_slug": 0, "institutional": 0, "skipped_not_in_registry": 0,
              "skipped_already_resolved": 0, "skipped_no_data": 0}

    with con:
        for video_id, (channel, first, last, official_id, source) in by_real_id.items():
            if video_id not in registry_ids:
                counts["skipped_not_in_registry"] += 1
                continue
            if video_id in already_resolved:
                counts["skipped_already_resolved"] += 1
                continue

            if source in ("Local_BioGuide", "Congress_API") and official_id in reference:
                ref = reference[official_id]
                con.execute(
                    """update canonical_items
                       set person_bioguide_id = ?, person_first_name = ?, person_last_name = ?,
                           person_match_source = 'smart_ids_inventory_bioguide', person_match_confidence = 0.9,
                           person_folder_key = ?, person_identifier_type = 'bioguide'
                       where canonical_id = ?""",
                    (official_id, ref["first_name"], ref["last_name"], official_id, video_id),
                )
                counts["bioguide"] += 1

            elif source == "OpenStates_API" and first and last:
                slug = target_naming.sanitize(f"{last}_{first}".lower())
                con.execute(
                    """update canonical_items
                       set person_first_name = ?, person_last_name = ?,
                           person_match_source = 'smart_ids_inventory_openstates', person_match_confidence = 0.75,
                           person_folder_key = ?, person_identifier_type = 'name_slug',
                           notes = coalesce(notes || ' | ', '') || 'openstates_id=' || ?
                       where canonical_id = ?""",
                    (first, last, f"nc_{slug}", official_id or "", video_id),
                )
                counts["name_slug"] += 1

            elif source == "Group/System":
                con.execute(
                    "update canonical_items set is_institutional = 1 where canonical_id = ?",
                    (video_id,),
                )
                counts["institutional"] += 1

            elif source == "Fallback_Split":
                override = FALLBACK_OVERRIDES.get((first, last))
                if not override:
                    counts["skipped_no_data"] += 1
                    continue
                if override["kind"] == "bioguide":
                    bg = override["bioguide_id"]
                    con.execute(
                        """update canonical_items
                           set person_bioguide_id = ?, person_first_name = ?, person_last_name = ?,
                               person_match_source = 'smart_ids_inventory_fallback_verified', person_match_confidence = 0.9,
                               person_folder_key = ?, person_identifier_type = 'bioguide'
                           where canonical_id = ?""",
                        (bg, override["first"], override["last"], bg, video_id),
                    )
                    counts["bioguide"] += 1
                else:
                    slug = target_naming.sanitize(f"{override['last']}_{override['first']}".lower())
                    note = override.get("note", "")
                    con.execute(
                        """update canonical_items
                           set person_first_name = ?, person_last_name = ?,
                               person_match_source = 'smart_ids_inventory_fallback_verified', person_match_confidence = 0.75,
                               person_folder_key = ?, person_identifier_type = 'name_slug',
                               notes = coalesce(notes || ' | ', '') || ?
                           where canonical_id = ?""",
                        (override["first"], override["last"], f"nc_{slug}", note, video_id),
                    )
                    counts["name_slug"] += 1
            else:
                counts["skipped_no_data"] += 1

    print(counts)
    con.close()


if __name__ == "__main__":
    main()
