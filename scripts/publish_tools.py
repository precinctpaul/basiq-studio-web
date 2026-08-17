"""Publish tools/ to the shared drive as a permissions-correct zip.

Why a zip instead of a folder copy: Windows/NTFS has no real Unix execute
bit, so no matter what git records, a robocopy/tar pipeline that passes
through a Windows machine cannot carry that bit to a Mac reading the same
LucidLink share - macOS then refuses to run Basiq-Setup.command ("you don't
have permission to open"), even though git and Git Bash both showed the
file as executable on the Windows side.

A zip sidesteps this entirely: Unix permissions are stored as data inside
the zip's central directory (the external_attr field), not as filesystem
metadata. Any unzip tool - macOS's built-in Archive Utility, Windows'
Extract All, Python's zipfile - reads that field and chmods the extracted
file accordingly. It works no matter what OS built the zip.

Safe to re-run: always rebuilds from the current git HEAD.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SOURCE_DIR = "tools"
ARCHIVE_NAME = "basiq-studio-hub"
DEST = Path(r"C:\Volumes\md-pac\media\Scripts") / f"{ARCHIVE_NAME}.zip"
STALE_FOLDER = Path(r"C:\Volumes\md-pac\media\Scripts") / ARCHIVE_NAME


def tracked_files():
    """(mode, blob_sha, path) for every git-tracked file under tools/."""
    out = subprocess.check_output(
        ["git", "ls-tree", "-r", "HEAD", "--", SOURCE_DIR],
        cwd=REPO_ROOT, text=True,
    )
    for line in out.splitlines():
        meta, path = line.split("\t")
        mode_str, _objtype, sha = meta.split()
        yield int(mode_str, 8), sha, path


def build_zip(dest: Path) -> int:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".tmp")
    count = 0
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
        for mode, sha, path in tracked_files():
            rel = Path(path).relative_to(SOURCE_DIR)
            arcname = f"{ARCHIVE_NAME}/{rel.as_posix()}"
            content = subprocess.check_output(["git", "cat-file", "-p", sha], cwd=REPO_ROOT)
            info = zipfile.ZipInfo(arcname, date_time=(2020, 1, 1, 0, 0, 0))
            info.external_attr = (mode & 0xFFFF) << 16  # embeds the exec bit as zip metadata
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, content)
            count += 1
    tmp.replace(dest)
    return count


def main() -> int:
    print(f"Building {DEST} from git HEAD...")
    count = build_zip(DEST)
    print(f"  [ok] {count} files, {DEST.stat().st_size / 1024:.1f} KB -> {DEST}")

    if STALE_FOLDER.is_dir():
        shutil.rmtree(STALE_FOLDER)
        print(f"  [ok] Removed the old loose-file folder at {STALE_FOLDER}")
        print("       (superseded by the zip - it's the only copy now, no permission bugs)")

    print()
    print("Teammates: copy the .zip to their machine, then double-click to")
    print("extract it - do NOT just copy the extracted files off the network")
    print("share directly, always extract locally.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
