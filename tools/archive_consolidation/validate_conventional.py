"""Spot-check: find every file already following the target naming
convention, parse it, and cross-check the embedded BioguideID against the
real reference CSV. This is the brief's suggested first step -- these ~203
files are verified ground truth for person + date resolution, so the
resolver's logic gets proven against them before it's ever trusted on the
other ~8,800 items that need it inferred.
"""

import csv
from pathlib import Path

import config
import parse_filename
import schema


def load_bioguide_reference() -> dict[str, dict]:
    with open(config.BIOGUIDE_CSV, encoding="utf-8") as f:
        return {row["bioguide_id"]: row for row in csv.DictReader(f)}


def main():
    con = schema.connect(config.INDEX_DB)
    bioguide = load_bioguide_reference()

    rows = con.execute("select full_path, name, canonical_id, id_type from files").fetchall()

    matches = []
    bioguide_not_found = []
    for full_path, name, canonical_id, id_type in rows:
        stem = Path(name).stem
        parsed = parse_filename.parse_conventional_name(stem)
        if not parsed:
            continue
        matches.append((full_path, canonical_id, id_type, parsed))
        if parsed["bioguide_id"] not in bioguide:
            bioguide_not_found.append((full_path, parsed))

    print(f"files matching the full naming convention: {len(matches)}  <- brief says ~203")
    print(f"distinct BioguideIDs among them: {len({m[3]['bioguide_id'] for m in matches})}")
    print(f"embedded BioguideIDs NOT found in the reference CSV: {len(bioguide_not_found)}")
    for full_path, parsed in bioguide_not_found[:10]:
        print(f"  ! {parsed['bioguide_id']}  {parsed['last_name']} {parsed['first_name']}  {full_path}")

    print()
    print("sample of 5 parsed rows, cross-checked against the reference:")
    for full_path, canonical_id, id_type, parsed in matches[:5]:
        ref = bioguide.get(parsed["bioguide_id"])
        ref_name = f"{ref['first_name']} {ref['last_name']}" if ref else "NOT FOUND"
        print(f"  {Path(full_path).name}")
        print(f"    parsed: {parsed['first_name']} {parsed['last_name']} ({parsed['bioguide_id']}) "
              f"date={parsed['date']} speaker_id={parsed['cspan_speaker_id']} "
              f"proxy={parsed['is_proxy']}")
        print(f"    reference says: {ref_name}")
        print(f"    canonical_id in registry: {canonical_id} ({id_type})")

    # speaker_id should be stable per bioguide_id -- if not, the pattern is
    # matching something it shouldn't.
    speaker_by_bioguide: dict[str, set[str]] = {}
    for _, _, _, parsed in matches:
        speaker_by_bioguide.setdefault(parsed["bioguide_id"], set()).add(parsed["cspan_speaker_id"])
    inconsistent = {b: s for b, s in speaker_by_bioguide.items() if len(s) > 1}
    print(f"\nBioguideIDs with more than one distinct speaker_id (should be ~0): {len(inconsistent)}")
    for b, s in list(inconsistent.items())[:10]:
        print(f"  {b}: {s}")

    con.close()


if __name__ == "__main__":
    main()
