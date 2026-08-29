"""Step 4c: generate tags for items that already have a transcript but
never got categorized (not resolved to a person, not institutional) --
the "video + transcript, no tags" bucket the user asked about directly.

Reuses extract_tags() from tools/basiq_agent.py verbatim -- the exact
same spaCy NER + KeyBERT keyphrase extraction the live app runs on a
fresh upload's transcript -- pointed at the .srt this project already
generated instead of a new one. BasiqUUID items are excluded per the
user's call: those are known test uploads, not real archive content.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import basiq_agent  # noqa: E402  -- path must be set before this import

import config
import schema


def read_srt_text(path: Path) -> str:
    lines = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.isdigit() or "-->" in line:
            continue
        lines.append(line)
    text = " ".join(lines)
    # Raw C-SPAN captions are frequently ALL CAPS, which spaCy's NER reads
    # as a capitalization signal and misfires on procedural words (GENTLEMAN,
    # OBJECTION, MADAM, CHAIR) as if they were named entities. Lowercasing
    # loses a few real entities too, but trades less garbage for that --
    # these tags are explicitly disposable/re-generatable by design (see
    # 0004_tags.sql), so it's a fine trade to make now rather than block on
    # a proper truecasing model.
    #
    # A whole-string .isupper() check is too fragile for this: one
    # transcript had exactly 6 lowercase characters (stray "5th"/"6th"
    # ordinal suffixes) out of 169,922, which made .isupper() report False
    # and skip the fix entirely, leaving the other 99.996% of the text
    # untouched. Proportion of cased characters that are uppercase is
    # robust to that.
    cased = [c for c in text if c.isupper() or c.islower()]
    is_shouting = bool(cased) and sum(c.isupper() for c in cased) / len(cased) > 0.9
    return text.lower() if is_shouting else text


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    con = schema.connect(config.INDEX_DB)
    srt_dir = config.OUTPUT_DIR / "transcripts_srt"

    is_tagged = "(person_folder_key is not null or is_institutional = 1)"
    rows = con.execute(
        f"""select canonical_id from canonical_items
            where transcript_status = 'available' and id_type != 'BasiqUUID'
              and not {is_tagged}"""
    ).fetchall()
    ids = [r[0] for r in rows]
    if args.limit:
        ids = ids[: args.limit]

    tagged, no_srt, no_tags_found = 0, 0, 0
    with con:
        for canonical_id in ids:
            srt_path = srt_dir / f"{canonical_id}.srt"
            if not srt_path.exists():
                no_srt += 1
                continue
            text = read_srt_text(srt_path)
            tags = basiq_agent.extract_tags(text, [])
            if not tags:
                no_tags_found += 1
                continue
            for t in tags:
                con.execute(
                    "insert or ignore into item_tags (canonical_id, label, kind, source) values (?, ?, ?, 'auto')",
                    (canonical_id, t["label"], t["kind"]),
                )
            tagged += 1

    print(f"items considered: {len(ids)}")
    print(f"tagged:           {tagged}")
    print(f"no srt found:     {no_srt}")
    print(f"no tags produced: {no_tags_found}")

    con.close()


if __name__ == "__main__":
    main()
