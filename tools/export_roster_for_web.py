"""
export_roster_for_web.py -- writes lib/rosterData.json, a static snapshot of
bulk_tag_buckets.py's roster (name -> pre-resolved bucket), so the web app
can classify a freshly GRABbed video's bucket the instant it's created
without spawning Python or re-parsing the roster xlsx/txt files per request.

WHY A STATIC FILE INSTEAD OF CALLING PYTHON LIVE: bucket classification
needs to happen synchronously in the same request that saves a fresh
grab's title/uploader/channel (see app/api/videos/[id]/route.ts's PATCH
handler), fast enough to add no perceptible delay. A static JSON import is
just an in-memory object; a live subprocess call per grab would be slower
and a new failure mode for no benefit, since the roster itself only
changes when someone updates the source files by hand.

pick_primary_membership() is called HERE, not on the TypeScript side --
this file stores each person's already-resolved bucket (e.g. "Majority
Democrats"), not their raw membership set. That keeps the priority-order
logic (Majority Democrats > The Bench > House > Senate > Notable Figures)
defined in exactly one place: bulk_tag_buckets.py. The TypeScript
classifier in lib/bucketClassifier.ts only re-implements the NAME MATCHING
(name_matches + the surname fallback), not the bucket priority rules.

Re-run this whenever the roster source files change (a new Congress
session, an updated MB and Bench Members.txt, etc.) and commit the
resulting lib/rosterData.json alongside that change -- same as re-running
bulk_tag_buckets.py --apply itself.

Run from the tools folder:
    python export_roster_for_web.py
"""

import json
from pathlib import Path

import bulk_tag_buckets as buckets

OUTPUT_PATH = Path(__file__).parent.parent / "lib" / "rosterData.json"


def main():
    roster = buckets.build_roster()
    out = {}
    for norm, entry in roster.items():
        bucket_label, _chamber = buckets.pick_primary_membership(entry["memberships"])
        out[norm] = {"display": entry["display"], "bucket": bucket_label}

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, sort_keys=True)

    print(f"wrote {len(out)} people to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
