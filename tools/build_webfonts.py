"""
build_webfonts.py — one-time build step: convert the licensed OTF cuts the
desktop app uses into WOFF2 for the web app to self-host.

Not part of running the app. Re-run only if the brand faces change:
    python build_webfonts.py

Which cuts and why (see app/theme.py in the desktop app for the full
rationale): Recoleta is the default face for nearly the whole UI; Druk
survives in exactly two places — the wordmark (display) and the player's
control bar (ui), which was width-tuned around a condensed face and would
reflow if Recoleta were swapped in. Mono is left to the system stack
(JetBrains Mono / Cascadia / Consolas), matching config.py's FONT_STACKS.
"""
from __future__ import annotations

import sys
from pathlib import Path

try:
    from fontTools.ttLib import TTFont
except ImportError:
    print("Needs fonttools + brotli:  pip install fonttools brotli")
    raise SystemExit(1)

SRC_DIR = Path.home() / "AppData/Local/Microsoft/Windows/Fonts"
OUT_DIR = Path(__file__).resolve().parent.parent / "public" / "fonts"

# (source filename, output filename)
CUTS = [
    # display — the wordmark
    ("DRUKWIDE-MEDIUM-TRIAL.OTF", "druk-wide-medium.woff2"),
    ("DRUKWIDE-BOLD-TRIAL.OTF", "druk-wide-bold.woff2"),
    # ui — the player control bar (condensed, width-tuned)
    ("DRUK-MEDIUM-TRIAL.OTF", "druk-medium.woff2"),
    ("DRUK-BOLD-TRIAL.OTF", "druk-bold.woff2"),
    # body — nearly everything else
    ("RECOLETA REGULAR.OTF", "recoleta-regular.woff2"),
    ("RECOLETA MEDIUM.OTF", "recoleta-medium.woff2"),
    ("RECOLETA SEMIBOLD.OTF", "recoleta-semibold.woff2"),
    ("RECOLETA BOLD.OTF", "recoleta-bold.woff2"),
]


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    missing = []
    for src_name, out_name in CUTS:
        src = SRC_DIR / src_name
        if not src.is_file():
            missing.append(src_name)
            continue
        font = TTFont(str(src))
        font.flavor = "woff2"
        out = OUT_DIR / out_name
        font.save(str(out))
        # Report the real family name so the @font-face declarations can be
        # checked against what the file actually calls itself.
        family = ""
        for rec in font["name"].names:
            if rec.nameID == 1:
                family = rec.toUnicode()
                break
        print(f"{out_name:28s} {out.stat().st_size // 1024:4d}K   (family: {family})")

    if missing:
        print("\nMISSING:", ", ".join(missing), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
