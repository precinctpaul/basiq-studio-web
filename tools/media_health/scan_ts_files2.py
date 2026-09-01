"""
scan_ts_files.py -- read-only scanner. Walks a media folder, checks files
matching a glob pattern for the "raw MPEG-TS saved as .mp4" signature (sync
byte 0x47 at the start of consecutive 188-byte packets), and prints a
report with a running time estimate. Does NOT modify, rename, or delete
anything -- this is purely reconnaissance.

Usage:
    python scan_ts_files.py "C:\\path\\to\\folder"                 (all .mp4 files)
    python scan_ts_files.py "C:\\path\\to\\folder" "cspan_*.mp4"    (just C-SPAN files -- much faster)
"""
import sys
import time
from pathlib import Path

PACKET_SIZE = 188
SYNC_BYTE = 0x47
PACKETS_TO_CHECK = 200

def is_mpegts(path, packets_to_check=PACKETS_TO_CHECK):
    try:
        with open(path, "rb") as f:
            data = f.read(PACKET_SIZE * packets_to_check)
    except OSError as e:
        return None, f"could not read: {e}"
    total = len(data) // PACKET_SIZE
    if total == 0:
        return None, "file too small to check"
    hits = sum(1 for i in range(total) if data[i * PACKET_SIZE] == SYNC_BYTE)
    pct = 100 * hits / total
    return pct, None

def format_eta(seconds):
    if seconds < 60:
        return f"{seconds:.0f}s"
    if seconds < 3600:
        return f"{seconds/60:.1f}m"
    return f"{seconds/3600:.1f}h"

def main():
    root = Path(sys.argv[1])
    pattern = sys.argv[2] if len(sys.argv) > 2 else "*.mp4"
    if not root.exists():
        print(f"Path does not exist: {root}")
        return

    print(f"Globbing for files matching {pattern!r} under {root} ...")
    mp4_files = sorted(root.rglob(pattern))
    print(f"Found {len(mp4_files)} matching files\n")

    affected = []
    clean = []
    errors = []
    start = time.monotonic()

    for i, path in enumerate(mp4_files, 1):
        pct, err = is_mpegts(path)
        if err:
            errors.append((path, err))
        elif pct is not None and pct > 95:
            affected.append((path, pct))
        else:
            clean.append((path, pct))
        if i % 20 == 0 or i == len(mp4_files):
            elapsed = time.monotonic() - start
            rate = i / elapsed if elapsed > 0 else 0
            remaining = (len(mp4_files) - i) / rate if rate > 0 else 0
            print(f"  ...checked {i}/{len(mp4_files)}  "
                  f"({elapsed:.0f}s elapsed, ~{rate:.1f} files/sec, "
                  f"ETA {format_eta(remaining)})")

    print(f"\n{'='*70}")
    print(f"SCAN COMPLETE — read-only, nothing was modified")
    print(f"{'='*70}")
    print(f"Total files scanned      : {len(mp4_files)}")
    print(f"Affected (raw MPEG-TS)   : {len(affected)}")
    print(f"Clean (real MP4)         : {len(clean)}")
    print(f"Errors (couldn't check)  : {len(errors)}")

    if affected:
        print(f"\nAffected files:")
        for path, pct in affected:
            print(f"  {pct:5.1f}%  {path}")

    if errors:
        print(f"\nFiles that couldn't be checked:")
        for path, err in errors:
            print(f"  {path}  ({err})")

if __name__ == "__main__":
    main()
