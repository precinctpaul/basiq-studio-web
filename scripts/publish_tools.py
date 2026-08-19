"""Publish the compiled agent installer(s) to the shared drive.

Used to publish a zip of tools/ for teammates to extract and run from
source. That's gone: Windows threw obscure errors and macOS refused to run
an unextracted or un-permissioned script often enough that "stop shipping
Python source, ship a compiled installer" won. tools/build/ now freezes
basiq_agent.py (and its whole dependency chain) into Basiq-Agent-Setup.exe
via PyInstaller + Inno Setup — see tools/build/README.md. This script's job
shrinks to matching: copy whatever installer(s) have already been built to
the one shared-drive location teammates install from.

This does NOT build anything — run tools\\build\\build_windows.bat (and, once
someone has a Mac, tools/build/build_macos.sh) first. Safe to re-run: it just
overwrites the shared copy with whatever's currently in installer_output/.
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALLER_OUTPUT = REPO_ROOT / "tools" / "build" / "installer_output"
SHARED_DIR = Path(r"C:\Volumes\md-pac\media\Scripts")

# Superseded by the installers below — cleaned up on every publish so nobody
# on the shared drive mistakes an old zip for the current release.
STALE_ZIP = SHARED_DIR / "basiq-studio-hub.zip"
STALE_FOLDER = SHARED_DIR / "basiq-studio-hub"

ARTIFACTS = [
    "Basiq-Agent-Setup.exe",
    "Basiq-Agent-Setup.dmg",  # only present once someone builds it on a Mac
]


def main() -> int:
    found = [name for name in ARTIFACTS if (INSTALLER_OUTPUT / name).is_file()]
    if not found:
        print(f"No installer found in {INSTALLER_OUTPUT}")
        print(r"Run tools\build\build_windows.bat (or build_macos.sh) first.")
        return 1

    SHARED_DIR.mkdir(parents=True, exist_ok=True)
    for name in found:
        src = INSTALLER_OUTPUT / name
        dest = SHARED_DIR / name
        shutil.copy2(src, dest)
        print(f"  [ok] {name}  ({src.stat().st_size / 1_000_000:.0f} MB) -> {dest}")

    for stale in (STALE_ZIP, STALE_FOLDER):
        if stale.is_file():
            stale.unlink()
            print(f"  [ok] Removed the old {stale.name} (superseded by the installer)")
        elif stale.is_dir():
            shutil.rmtree(stale)
            print(f"  [ok] Removed the old {stale.name}/ folder (superseded by the installer)")

    print()
    print("Teammates: download the installer from")
    print(f"  {SHARED_DIR}")
    print("and double-click it. That's the whole install — no extracting, no venv.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
