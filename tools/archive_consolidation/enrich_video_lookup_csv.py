"""Step 2k: import the validated slices of tools/video_lookup_complete.csv
(a separate side-effort built via the YouTube Data API + BioGuide DB, see
fill_all_videos.py) into the person resolver.

video_lookup_complete.csv resolves 1,716 items -- every one of them
already exists in this index and every one was previously unresolved
here, since it uses a completely different method (live YouTube API
metadata) than anything in this pipeline. But it also has a confirmed bug:
a last-name-only lookup against the FULL historical BioGuide table (back
to 1789) occasionally grabs the wrong person entirely -- e.g. a channel
literally titled "Congresswoman Mikie Sherrill" got resolved to
"Eliakim Sherrill" (bioguide S000351, an 1813-born Whig congressman),
because that's a different person who happens to share the surname.

Every real-format BioGuideID is trusted if EITHER:
  (a) it's a current 119th-Congress member or one of the 7 ex-Congress
      cabinet officials already in this index, or
  (b) the video's own Channel name contains the BioGuide reference's
      last name -- independent confirmation that doesn't rely on
      whatever the source script's Person/BioGuideID columns claim,
      since those two can be wrong together (as in the Sherrill case).
Anything that clears neither bar is written to
output/video_lookup_suspect_rows.csv for manual review rather than
imported, since importing a wrong BioGuideID would silently misfile
real content under the wrong member.

Channel-fallback rows (Person == Channel, BioGuideID == a channel URL --
Branch B in fill_all_videos.py) are split further: a channel that's
demonstrably a real person's own channel with no federal BioGuideID
(state legislators, mayoral/gubernatorial campaigns) becomes a
name_slug entry exactly like the notable-figures pass; a generic
institutional channel (C-SPAN's own channel, a committee channel) is
left unresolved, with is_institutional set for committee channels.
"""

import csv
import re

import config
import people
import schema
import target_naming

CSV_PATH = config.TOOL_DIR.parent / "video_lookup_complete.csv"
SUSPECT_OUT = config.OUTPUT_DIR / "video_lookup_suspect_rows.csv"

_REAL_BIOGUIDE = re.compile(r"^[A-Z]\d{6}$")

# Channels confirmed to be a real person's own channel with no federal
# BioGuideID (checked by hand against the ~15-person MB/bench watchlist) --
# mapped explicitly rather than parsed from the channel string, since
# "Mahan for California" is a campaign-channel name, not "First Last".
_REAL_PERSON_NO_BIOGUIDE_CHANNELS = {
    "James Talarico": ("James", "Talarico"),
    "Mahan for California": ("Matt", "Mahan"),
    "Jason Esteves For Georgia": ("Jason", "Esteves"),
}
_COMMITTEE_CHANNELS = {"House Committee on Agriculture"}


def load_rows() -> list[dict]:
    with open(CSV_PATH, encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def classify(row: dict, reference: dict, trusted_current_ids: set[str]) -> str:
    bg = row["BioGuide ID"].strip()
    channel = row["Channel"].strip()

    if bg.startswith("http"):
        return "channel_fallback"
    if not _REAL_BIOGUIDE.match(bg):
        return "suspect"  # malformed/blank -- can't verify, don't import

    if bg in trusted_current_ids:
        return "trusted"

    ref_row = reference.get(bg)
    if ref_row and channel and channel.lower() not in ("c-span", "c-span program") \
            and ref_row["last_name"].lower() in channel.lower():
        return "trusted"

    return "suspect"


def main():
    con = schema.connect(config.INDEX_DB)
    reference = people.load_bioguide_reference()
    current_ids = people.load_current_bioguide_ids()
    ex_congress_cabinet_ids = {"R000595", "D000614", "C001093", "M001190", "R000601", "Z000017", "L000594"}
    trusted_current_ids = current_ids | ex_congress_cabinet_ids

    rows = load_rows()
    registry_ids = {r[0] for r in con.execute("select canonical_id from canonical_items")}

    counts = {"trusted": 0, "suspect": 0, "channel_fallback": 0}
    skipped_not_in_registry = 0
    skipped_already_resolved = 0
    imported_person = 0
    imported_name_slug = 0
    imported_institutional = 0
    suspect_rows_out = []

    with con:
        for row in rows:
            canonical_id = row["URL Extension"].strip()
            if canonical_id not in registry_ids:
                skipped_not_in_registry += 1
                continue

            already_resolved = con.execute(
                "select person_folder_key from canonical_items where canonical_id = ?", (canonical_id,)
            ).fetchone()[0]
            if already_resolved:
                skipped_already_resolved += 1
                continue

            bucket = classify(row, reference, trusted_current_ids)
            counts[bucket] += 1

            if bucket == "trusted":
                bg = row["BioGuide ID"].strip()
                ref_row = reference[bg]
                con.execute(
                    """update canonical_items
                       set person_bioguide_id = ?, person_first_name = ?, person_last_name = ?,
                           person_match_source = 'video_lookup_csv', person_match_confidence = 0.9,
                           person_folder_key = ?, person_identifier_type = 'bioguide'
                       where canonical_id = ?""",
                    (bg, ref_row["first_name"], ref_row["last_name"], bg, canonical_id),
                )
                imported_person += 1

            elif bucket == "channel_fallback":
                channel = row["Channel"].strip()
                if channel in _REAL_PERSON_NO_BIOGUIDE_CHANNELS:
                    first, last = _REAL_PERSON_NO_BIOGUIDE_CHANNELS[channel]
                    slug = target_naming.sanitize(f"{last}_{first}".lower()).replace(" ", "_")
                    con.execute(
                        """update canonical_items
                           set person_first_name = ?, person_last_name = ?,
                               person_match_source = 'video_lookup_csv_channel', person_match_confidence = 0.7,
                               person_folder_key = ?, person_identifier_type = 'name_slug'
                           where canonical_id = ?""",
                        (first, last, f"nc_{slug}", canonical_id),
                    )
                    imported_name_slug += 1
                elif channel in _COMMITTEE_CHANNELS:
                    con.execute(
                        "update canonical_items set is_institutional = 1 where canonical_id = ?",
                        (canonical_id,),
                    )
                    imported_institutional += 1
                # generic channels (plain "C-SPAN") -- leave fully unresolved

            else:  # suspect
                suspect_rows_out.append(row)

    with open(SUSPECT_OUT, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(suspect_rows_out)

    print(f"rows in file:                    {len(rows)}")
    print(f"not in this index at all:        {skipped_not_in_registry}")
    print(f"already resolved by another pass: {skipped_already_resolved}")
    print(f"trusted -> imported as person:    {imported_person}")
    print(f"channel_fallback -> name_slug:    {imported_name_slug}")
    print(f"channel_fallback -> institutional:{imported_institutional}")
    print(f"channel_fallback -> left as-is:  {counts['channel_fallback'] - imported_name_slug - imported_institutional}")
    print(f"suspect (written for review):     {len(suspect_rows_out)}")
    print(f"\nwrote {SUSPECT_OUT}")

    con.close()


if __name__ == "__main__":
    main()
