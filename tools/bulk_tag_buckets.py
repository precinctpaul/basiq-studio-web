"""
bulk_tag_buckets.py — tags videos into curated watchlist buckets so the
library sidebar can group them instead of showing one flat 5,595-item list.

WHAT IT DOES: reads roster sources, matches each video's uploader/channel
name against them, and writes a "bucket" tag onto the match. Each person
lands in exactly one bucket — see EXCLUSIVITY below.

SOURCES (right now):
  - MB_and_Bench_Members.txt   -> "Majority Democrats" and "The Bench" buckets
    (flat — names sit directly inside)
  - house_committee_memberships_119th_current.xlsx (Member_Lookup sheet,
    filtered to Chamber == House) -> "Federal" bucket, "House" chamber
    subfolder (Senate/Cabinet get added the same way later)

EXCLUSIVITY: each person lands in exactly ONE bucket, picked by priority —
Majority Democrats > The Bench > Federal/Cabinet > Federal/House >
Federal/Senate > Watch List (catch-all for anyone matched but not covered
by a specific list). A Majority Democrat who's also a sitting House member
shows up under Majority Democrats only, not both.

NOT YET WIRED UP: Senate, Cabinet — once those files are in hand, add them
to build_roster() as add_person(name, "Federal", "Senate") /
add_person(name, "Federal", "Cabinet"), following the House pattern.

MATCHING: normalizes names (strips "Rep.", "Sen.", titles, extra whitespace,
lowercases) and requires the shorter name's words to be a full subset of the
longer name's words, with at least a first+last name overlap — avoids a bare
"Josh" accidentally matching "Josh Turk" while still tolerating "Rep. Ritchie
Torres" matching plain "Ritchie Torres".

TAGS: writes TWO tags per match — a kind='bucket' tag (e.g. "Majority
Democrats") for the top-level sidebar grouping, and a kind='person' tag
(e.g. "Ritchie Torres") so the sidebar can nest a subfolder per person
inside each bucket. Both are source='manual', so they never get wiped out
by an auto re-tag (see 0004_tags.sql), and a manual tag intentionally wins
over any auto-generated entity tag with the same name/label.

SAFE TO RE-RUN: uses upsert on (video_id, label), so running it again after
adding Senate/Cabinet/Court sources just adds the new tags without touching
or duplicating what's already there.

Run it from the tools folder, with MB_and_Bench_Members.txt and
house_committee_memberships_119th_current.xlsx in the same folder:

    python bulk_tag_buckets.py
"""

import re
from collections import defaultdict
from pathlib import Path

import openpyxl
from supabase import create_client, Client

# --- CONFIGURATION ---
SUPABASE_URL = "https://tijwokimlrglufjqiwok.supabase.co"
# STOP! Replace with your SUPABASE_SERVICE_ROLE_KEY from .env.local
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRpandva2ltbHJnbHVmanFpd29rIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NjgyMDQ0OSwiZXhwIjoyMTAyMzk2NDQ5fQ.vD586cg84F9LuNRb7AegIiu5Cn843wezSKmnX23Q1pw"

MEMBERS_TXT = Path("MB and Bench Members.txt")
HOUSE_XLSX = Path("house_committee_memberships_119th_current.xlsx")

PAGE_SIZE = 1000

# Every person gets filed under exactly ONE of these, picked by priority —
# not every list they happen to match. Someone who's both a Majority
# Democrat AND a sitting House member goes in Majority Democrats only.
# Anyone matched but not covered by a specific list falls through to the
# Watch List catch-all at the bottom.
PRIORITY_ORDER = [
    ("Majority Democrats", None),
    ("The Bench", None),
    ("Federal", "Cabinet"),
    ("Federal", "House"),
    ("Federal", "Senate"),
]
CATCH_ALL = ("Watch List", None)

TITLE_PREFIX_RE = re.compile(
    r"^(rep\.?|sen\.?|senator|representative|congressman|congresswoman|gov\.?|governor|mayor)\s+",
    re.IGNORECASE,
)


def normalize_name(name: str) -> str:
    name = (name or "").strip()
    name = TITLE_PREFIX_RE.sub("", name)
    name = re.sub(r"\s+", " ", name)
    return name.lower().strip()


def name_matches(a: str, b: str) -> bool:
    """a and b are already normalized. Requires the shorter name's words to
    be fully contained in the longer name's words, with a real first+last
    overlap — not just any single shared word."""
    if not a or not b:
        return False
    if a == b:
        return True
    a_words, b_words = set(a.split()), set(b.split())
    shorter, longer = (a_words, b_words) if len(a_words) <= len(b_words) else (b_words, a_words)
    return len(shorter) >= 2 and shorter.issubset(longer)


def parse_member_list(path: Path) -> dict:
    """Parses the '<Bucket Name> (N People)' + blank-line-separated format
    into {bucket_name: [names...]}."""
    header_re = re.compile(r"^(.+?)\s*\(\d+\s*People\)\s*$", re.IGNORECASE)
    sections = {}
    current = None
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        m = header_re.match(line)
        if m:
            current = m.group(1).strip()
            sections[current] = []
            continue
        if current:
            sections[current].append(line)
    return sections


def load_house_members(path: Path) -> list:
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb["Member_Lookup"]
    rows = ws.iter_rows(values_only=True)
    header = next(rows)
    idx = {name: i for i, name in enumerate(header)}
    names = []
    for row in rows:
        if row[idx["Chamber"]] == "House":
            names.append(row[idx["Member Name"]])
    return names


def build_roster() -> dict:
    """Returns {normalized_name: {"display": "Proper Case Name", "memberships": {(bucket, chamber_or_None), ...}}}.
    A person can accumulate several memberships here (e.g. someone who's both
    a Majority Democrat and a sitting House member) — pick_primary_membership()
    is what collapses that down to the one bucket they actually get filed
    under. Majority Democrats/The Bench have chamber=None (flat). House
    members get ("Federal", "House"). Senate/Cabinet get added the same way
    later: add_person(name, "Federal", "Senate"), etc."""
    roster: dict = {}

    def add_person(display_name: str, bucket_label: str, chamber: str | None = None):
        norm = normalize_name(display_name)
        if not norm:
            return
        entry = roster.setdefault(norm, {"display": display_name.strip(), "memberships": set()})
        entry["memberships"].add((bucket_label, chamber))

    for bucket_label, names in parse_member_list(MEMBERS_TXT).items():
        for name in names:
            add_person(name, bucket_label)

    for name in load_house_members(HOUSE_XLSX):
        add_person(name, "Federal", "House")

    return roster


def pick_primary_membership(memberships: set) -> tuple:
    """A person can technically match several lists (e.g. a Majority
    Democrat who's also a sitting House member). This picks the single
    highest-priority one so they land in exactly one bucket, not several."""
    for candidate in PRIORITY_ORDER:
        if candidate in memberships:
            return candidate
    return CATCH_ALL


def find_matches(fields: list, roster: dict) -> dict:
    """Returns the subset of roster entries (keyed by normalized name) that
    match any of the given video fields — usually zero or one person, but
    a dict in case a video ever legitimately matches more than one."""
    matched = {}
    for field in fields:
        norm_field = normalize_name(field)
        if not norm_field:
            continue
        for roster_name, entry in roster.items():
            if roster_name in matched:
                continue
            if name_matches(norm_field, roster_name):
                matched[roster_name] = entry
    return matched


def fetch_all(supabase: Client, table: str, columns: str) -> list:
    rows, page = [], 0
    while True:
        res = supabase.table(table).select(columns).range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1).execute()
        batch = res.data or []
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
        page += 1
    return rows


def main():
    print("Building roster from local files...")
    roster = build_roster()
    bucket_names = sorted({b for entry in roster.values() for (b, _c) in entry["memberships"]})
    print(f"  {len(roster)} known people across buckets: {', '.join(bucket_names)}")

    print("Connecting to Supabase...")
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

    print("Clearing every bucket/chamber/person tag from previous runs (clean slate)...")
    print("  This only touches kind IN ('bucket','chamber','person') — nothing else.")
    supabase.table("tags").delete().eq("source", "manual").in_("kind", ["bucket", "chamber", "person"]).execute()

    print("Loading videos...")
    videos = fetch_all(supabase, "videos", "id, uploader, channel")
    print(f"  {len(videos)} videos to check.")

    tag_rows = []
    per_bucket_count = defaultdict(int)
    per_person_count = defaultdict(int)
    matched_videos = 0

    for v in videos:
        matches = find_matches([v.get("uploader"), v.get("channel")], roster)
        if not matches:
            continue
        matched_videos += 1
        for entry in matches.values():
            display = entry["display"]
            per_person_count[display] += 1
            tag_rows.append({
                "video_id": v["id"],
                "label": display,
                "source": "manual",
                "kind": "person",
            })
            bucket_label, chamber = pick_primary_membership(entry["memberships"])
            per_bucket_count[bucket_label] += 1
            tag_rows.append({
                "video_id": v["id"],
                "label": bucket_label,
                "source": "manual",
                "kind": "bucket",
            })
            if chamber:
                tag_rows.append({
                    "video_id": v["id"],
                    "label": chamber,
                    "source": "manual",
                    "kind": "chamber",
                })

    print(f"\n{matched_videos} videos matched at least one bucket.")
    for b in sorted(per_bucket_count.keys()):
        print(f"  {b}: {per_bucket_count[b]} videos")
    print(f"\n{len(per_person_count)} distinct people matched at least one video.")

    seen = set()
    deduped_rows = []
    for row in tag_rows:
        key = (row["video_id"], row["label"])
        if key in seen:
            continue
        seen.add(key)
        deduped_rows.append(row)
    tag_rows = deduped_rows

    if not tag_rows:
        print("\nNothing to write — stopping.")
        return

    print(f"\nWriting {len(tag_rows)} bucket + person tags...")
    written = 0
    for i in range(0, len(tag_rows), 500):
        chunk = tag_rows[i:i + 500]
        try:
            supabase.table("tags").upsert(chunk, on_conflict="video_id,label").execute()
            written += len(chunk)
        except Exception as e:
            print(f"  FAILED on a batch: {e}")

    print(f"\nDone. {written} bucket tags written (safe to re-run any time).")


if __name__ == "__main__":
    main()
