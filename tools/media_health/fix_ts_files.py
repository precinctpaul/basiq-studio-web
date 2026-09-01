"""
fix_ts_files.py -- finds .mp4 files that are actually raw MPEG-TS data
(saved under the wrong extension, never remuxed) and repairs them by
remuxing into a real MP4 container with ffmpeg (-c copy, no re-encoding,
so no quality loss).

SAFETY PROPERTIES:
  - Never deletes anything. The original is renamed to <name>.mp4.orig-ts
    once the fix is verified -- never overwritten, never removed.
  - Verifies the fixed file's duration matches the original's (within 1
    second) via ffprobe before finalizing. If it doesn't match, the
    original is left completely untouched and the attempt is logged as
    FAILED for manual review.
  - Resumable: if interrupted, already-fixed files are real MP4s by the
    time you rerun, so the detector correctly sees them as clean and
    skips them. Nothing needs to be tracked between runs.
  - --dry-run reports exactly what WOULD be done without calling ffmpeg
    or touching any file.
  - Non-recursive by default -- only touches files directly in the given
    folder, not subfolders like media-intelligence/high-res or low-res,
    since those may be proxy/duplicate copies the app doesn't actually
    serve. Pass --recursive to include subfolders too.

Usage:
    python fix_ts_files.py "C:\\path\\to\\folder" --dry-run
    python fix_ts_files.py "C:\\path\\to\\folder"
    python fix_ts_files.py "C:\\path\\to\\folder" --pattern "cspan_*.mp4" --limit 10
    python fix_ts_files.py "C:\\path\\to\\folder" --recursive
"""
import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

PACKET_SIZE = 188
SYNC_BYTE = 0x47
PACKETS_TO_CHECK = 200
DURATION_TOLERANCE_SECONDS = 1.0


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
    return (100 * hits / total), None


def get_duration(path):
    """Returns duration in seconds via ffprobe, or None if it couldn't be read."""
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, timeout=60,
        )
        if result.returncode != 0:
            return None
        return float(result.stdout.strip())
    except (subprocess.TimeoutExpired, ValueError, OSError):
        return None


def find_sidecar_duration(path: Path, sidecar_dir):
    """Looks for <sidecar_dir>/cspan_<id>_program.json matching this file's
    numeric id and returns its authoritative "video_duration" (seconds), or
    None if no sidecar_dir was given, no matching sidecar exists, or it
    doesn't parse. This is an EXTERNAL ground truth (from C-SPAN's own API)
    -- unlike comparing the fix's input/output durations to each other, this
    can actually catch a source file that was already truncated before we
    ever touched it."""
    if not sidecar_dir:
        return None
    m = re.search(r"cspan_(\d+)", path.stem)
    if not m:
        return None
    sidecar_path = Path(sidecar_dir) / f"cspan_{m.group(1)}_program.json"
    if not sidecar_path.exists():
        return None
    try:
        data = json.loads(sidecar_path.read_text(encoding="utf-8"))
        return float(data["video_duration"])
    except (OSError, ValueError, KeyError, json.JSONDecodeError):
        return None


def fix_one(path: Path, dry_run: bool, sidecar_dir=None) -> tuple[str, str]:
    """Returns (status, detail). status is one of:
    'fixed', 'skipped-clean', 'skipped-unreadable', 'skipped-suspicious-source',
    'dry-run-would-fix', 'failed'."""
    pct, err = is_mpegts(path)
    if err:
        return "skipped-unreadable", err
    if pct is None or pct <= 95:
        return "skipped-clean", f"{pct:.1f}% TS-pattern match" if pct is not None else "n/a"

    if dry_run:
        return "dry-run-would-fix", f"{pct:.1f}% TS-pattern match"

    original_duration = get_duration(path)
    if original_duration is None:
        return "failed", "could not read original duration via ffprobe -- skipping to be safe"

    sidecar_duration = find_sidecar_duration(path, sidecar_dir)
    if sidecar_duration is not None and abs(original_duration - sidecar_duration) > max(
        DURATION_TOLERANCE_SECONDS, 0.02 * sidecar_duration
    ):
        return "skipped-suspicious-source", (
            f"C-SPAN metadata says {sidecar_duration:.1f}s but the file on disk is only "
            f"{original_duration:.1f}s -- this looks like an incomplete/truncated download, "
            f"NOT a container-format problem. Left untouched; needs re-downloading, not remuxing."
        )

    fixing_path = path.with_suffix(path.suffix + ".fixing.mp4")
    if fixing_path.exists():
        fixing_path.unlink()  # leftover from a previous interrupted attempt on THIS temp file only

    result = subprocess.run(
        ["ffmpeg", "-y", "-i", str(path), "-c", "copy", "-movflags", "+faststart", str(fixing_path)],
        capture_output=True, text=True, timeout=1800,
    )
    if result.returncode != 0:
        return "failed", f"ffmpeg exited {result.returncode}: {result.stderr[-300:]}"

    fixed_duration = get_duration(fixing_path)
    if fixed_duration is None:
        return "failed", "ffmpeg ran but fixed file's duration couldn't be verified -- original left untouched"

    if abs(fixed_duration - original_duration) > DURATION_TOLERANCE_SECONDS:
        return "failed", (f"duration mismatch: original={original_duration:.2f}s "
                           f"fixed={fixed_duration:.2f}s -- original left untouched, "
                           f"fixed attempt kept at {fixing_path.name} for inspection")

    # Verified. Now do the actual (non-destructive) swap.
    backup_path = path.with_suffix(path.suffix + ".orig-ts")
    if backup_path.exists():
        return "failed", f"backup path {backup_path.name} already exists -- not overwriting, skipping"

    path.rename(backup_path)
    fixing_path.rename(path)
    return "fixed", f"duration matched ({original_duration:.2f}s), original preserved as {backup_path.name}"


def format_eta(seconds):
    if seconds < 60:
        return f"{seconds:.0f}s"
    if seconds < 3600:
        return f"{seconds/60:.1f}m"
    return f"{seconds/3600:.1f}h"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder")
    parser.add_argument("--pattern", default="cspan_*.mp4")
    parser.add_argument("--recursive", action="store_true", help="also scan subfolders")
    parser.add_argument("--limit", type=int, default=None, help="only process the first N matching files")
    parser.add_argument("--dry-run", action="store_true", help="report only, touch nothing")
    parser.add_argument("--sidecar-dir", default=None,
                         help="folder containing cspan_<id>_program.json files, used as an "
                              "external ground-truth duration check to catch pre-existing "
                              "truncated downloads (not just corruption from the fix itself)")
    args = parser.parse_args()

    root = Path(args.folder)
    if not root.exists():
        print(f"Path does not exist: {root}")
        return

    files = sorted(root.rglob(args.pattern) if args.recursive else root.glob(args.pattern))
    if args.limit:
        files = files[: args.limit]

    print(f"{'DRY RUN — ' if args.dry_run else ''}Found {len(files)} files matching {args.pattern!r} "
          f"under {root}{' (recursive)' if args.recursive else ''}\n")

    counts = {"fixed": 0, "skipped-clean": 0, "skipped-unreadable": 0,
              "skipped-suspicious-source": 0, "dry-run-would-fix": 0, "failed": 0}
    details = []
    start = time.monotonic()

    for i, path in enumerate(files, 1):
        status, detail = fix_one(path, args.dry_run, args.sidecar_dir)
        counts[status] += 1
        if status in ("fixed", "failed", "dry-run-would-fix", "skipped-unreadable", "skipped-suspicious-source"):
            details.append((path, status, detail))

        elapsed = time.monotonic() - start
        rate = i / elapsed if elapsed > 0 else 0
        remaining = (len(files) - i) / rate if rate > 0 else 0
        print(f"  [{i}/{len(files)}] {status:20} {path.name}  "
              f"({elapsed:.0f}s elapsed, ETA {format_eta(remaining)})")

    print(f"\n{'='*70}")
    print(f"{'DRY RUN ' if args.dry_run else ''}COMPLETE")
    print(f"{'='*70}")
    for k, v in counts.items():
        if v:
            print(f"  {k:20} {v}")

    fixed_or_failed = [d for d in details
                       if d[1] in ("fixed", "failed", "dry-run-would-fix", "skipped-suspicious-source")]
    if fixed_or_failed:
        print()
        for path, status, detail in fixed_or_failed:
            print(f"  {status:20} {path.name} -- {detail}")


if __name__ == "__main__":
    main()
