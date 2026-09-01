"""
scan_ts_files_threaded.py -- read-only scanner, concurrent version of
scan_ts_files2.py. Walks a media folder, checks files matching a glob
pattern for the "raw MPEG-TS saved as .mp4" signature (sync byte 0x47 at
the start of consecutive 188-byte packets), and prints a report with a
running time estimate. Does NOT modify, rename, or delete anything -- this
is purely reconnaissance, identical in that respect to scan_ts_files2.py.

WHY THREADED: on a network-mounted drive (LucidLink, SMB, etc.), each file
open/read is dominated by round-trip latency to the backend, not local disk
throughput -- ~0.7 files/sec to read the first ~37KB of a file is a strong
signal that's exactly what's happening. Threads (not processes) are the
right tool here: this is I/O-bound, so CPython releases the GIL during the
blocking open/read calls, letting many reads be in flight to the backend at
once instead of queued one after another. This does nothing for a
genuinely disk-throughput-bound drive -- it specifically targets latency,
not bandwidth.

SAFETY: identical read-only logic to scan_ts_files2.py -- open a file, read
the first PACKETS_TO_CHECK*188 bytes, close it. Never writes, renames, or
deletes anything. --workers only controls how many of those reads are
in flight concurrently, nothing about what happens to any file.

Usage:
    python scan_ts_files_threaded.py "C:\\path\\to\\folder"
    python scan_ts_files_threaded.py "C:\\path\\to\\folder" "cspan_*.mp4"
    python scan_ts_files_threaded.py "C:\\path\\to\\folder" "*.mp4" --workers 40
"""
import argparse
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from threading import Lock

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
        return f"{seconds / 60:.1f}m"
    return f"{seconds / 3600:.1f}h"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("folder")
    parser.add_argument("pattern", nargs="?", default="*.mp4")
    parser.add_argument("--workers", type=int, default=20,
                         help="concurrent file checks in flight at once (default 20)")
    args = parser.parse_args()

    root = Path(args.folder)
    if not root.exists():
        print(f"Path does not exist: {root}")
        return

    print(f"Globbing for files matching {args.pattern!r} under {root} ...")
    mp4_files = sorted(root.rglob(args.pattern))
    total = len(mp4_files)
    print(f"Found {total} matching files")
    print(f"Checking with {args.workers} concurrent workers...\n")

    affected: list[tuple[Path, float]] = []
    clean: list[tuple[Path, float]] = []
    errors: list[tuple[Path, str]] = []
    completed = 0
    lock = Lock()
    start = time.monotonic()

    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(is_mpegts, path): path for path in mp4_files}
        for future in as_completed(futures):
            path = futures[future]
            pct, err = future.result()
            with lock:
                if err:
                    errors.append((path, err))
                elif pct is not None and pct > 95:
                    affected.append((path, pct))
                else:
                    clean.append((path, pct))
                completed += 1
                if completed % 20 == 0 or completed == total:
                    elapsed = time.monotonic() - start
                    rate = completed / elapsed if elapsed > 0 else 0
                    remaining = (total - completed) / rate if rate > 0 else 0
                    print(f"  ...checked {completed}/{total}  "
                          f"({elapsed:.0f}s elapsed, ~{rate:.1f} files/sec, "
                          f"ETA {format_eta(remaining)})")

    print(f"\n{'=' * 70}")
    print("SCAN COMPLETE — read-only, nothing was modified")
    print(f"{'=' * 70}")
    print(f"Total files scanned      : {total}")
    print(f"Affected (raw MPEG-TS)   : {len(affected)}")
    print(f"Clean (real MP4)         : {len(clean)}")
    print(f"Errors (couldn't check)  : {len(errors)}")

    if affected:
        print("\nAffected files:")
        for path, pct in sorted(affected, key=lambda x: str(x[0])):
            print(f"  {pct:5.1f}%  {path}")

    if errors:
        print("\nFiles that couldn't be checked:")
        for path, err in sorted(errors, key=lambda x: str(x[0])):
            print(f"  {path}  ({err})")


if __name__ == "__main__":
    main()
