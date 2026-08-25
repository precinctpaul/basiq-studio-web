"""
cspan_db_inspect.py — quick look inside cspan_search.db to figure out why
cspan_import_transcripts.py found 0 matching lines for all 260 target
program IDs, even though ID extraction itself worked perfectly.

Run this from the same folder as cspan_search.db:
    python cspan_db_inspect.py
"""
import sqlite3
from pathlib import Path

DB_PATH = Path("cspan_search.db")

if not DB_PATH.is_file():
    print(f"Can't find {DB_PATH.resolve()}")
    raise SystemExit(1)

db = sqlite3.connect(str(DB_PATH))

print("Tables in this database:")
for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall():
    print(f"  - {name}")

print()
try:
    (count,) = db.execute("SELECT COUNT(*) FROM transcript_lines").fetchone()
    print(f"transcript_lines row count: {count}")
except sqlite3.OperationalError as e:
    print(f"Couldn't query transcript_lines: {e}")
    raise SystemExit(1)

print()
print("Column info for transcript_lines:")
for col in db.execute("PRAGMA table_info(transcript_lines)").fetchall():
    # (cid, name, type, notnull, dflt_value, pk)
    print(f"  {col}")

print()
print("Sample of distinct program_id values actually IN the table (up to 20):")
for (pid,) in db.execute("SELECT DISTINCT program_id FROM transcript_lines LIMIT 20").fetchall():
    print(f"  {pid!r}   (python type: {type(pid).__name__})")

print()
# A handful of real IDs pulled straight from the 260-video preview run
target_sample = ["637310", "638515", "649970", "529819", "610537", "684045"]
print(f"Checking specific target program IDs directly: {target_sample}")
for pid in target_sample:
    (n_exact,) = db.execute(
        "SELECT COUNT(*) FROM transcript_lines WHERE program_id = ?", (pid,)
    ).fetchone()
    (n_cast,) = db.execute(
        "SELECT COUNT(*) FROM transcript_lines WHERE CAST(program_id AS TEXT) = ?", (pid,)
    ).fetchone()
    (n_like,) = db.execute(
        "SELECT COUNT(*) FROM transcript_lines WHERE program_id LIKE ?", (f"%{pid}%",)
    ).fetchone()
    print(f"  program_id={pid}: exact-match={n_exact}  cast-match={n_cast}  LIKE-contains={n_like}")

print()
print("If all three columns above are 0 for every ID, this program almost certainly "
      "isn't in this copy of cspan_search.db at all (rather than a formatting mismatch).")
