"""
scan_ts_files.py -- read-only scanner. Walks a media folder, checks every
.mp4 file for the "raw MPEG-TS saved as .mp4" signature (sync byte 0x47 at
the start of consecutive 188-byte packets), and prints a report. Does NOT
modify, rename, or delete anything -- this is purely reconnaissance so we
know the true scope before touching any real files.

Usage:  python scan_ts_files.py "C:\\Volumes\\md-pac\\media\\Archive\\Basiq-Studio-Hub"
"""
import sys
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

def main():
    root = Path(sys.argv[1])
    if not root.exists():
        print(f"Path does not exist: {root}")
        return

    mp4_files = sorted(root.rglob("*.mp4"))
    print(f"Found {len(mp4_files)} .mp4 files under {root}\n")

    affected = []
    clean = []
    errors = []

    for i, path in enumerate(mp4_files, 1):
        pct, err = is_mpegts(path)
        if err:
            errors.append((path, err))
        elif pct is not None and pct > 95:
            affected.append((path, pct))
        else:
            clean.append((path, pct))
        if i % 100 == 0:
            print(f"  ...checked {i}/{len(mp4_files)}")

    print(f"\n{'='*70}")
    print(f"SCAN COMPLETE — read-only, nothing was modified")
    print(f"{'='*70}")
    print(f"Total .mp4 files scanned : {len(mp4_files)}")
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
