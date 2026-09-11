"""Sanity-check a cookies.txt export for real YouTube login cookies -- entirely
local, makes zero network calls, never touches YouTube. Run this BEFORE
trusting a fresh cookie export enough to try a real grab, since a bad export
looks identical to a good one until yt-dlp actually fails on a real video.

Background (2026-09-09): a cookie export that looked complete (1000+ lines,
real Google SID/APISID login cookies) still failed every grab with "Sign in
to confirm you're not a bot" because it was missing LOGIN_INFO -- the cookie
YouTube itself sets once it recognizes a session as logged-in on youtube.com
specifically, as opposed to just a valid Google account cookie. Cookie-export
extensions can silently skip it if their "include HttpOnly cookies" option is
off, or if the export was taken from a Google-account page rather than an
actual youtube.com video page.

Usage:
    python check_cookies.py [path-to-cookies.txt]   (defaults to cookies.txt
    next to this script, the same file COOKIES_FILE in worker_config.txt
    normally points at)
"""

import sys
from pathlib import Path

REQUIRED = ["LOGIN_INFO", "SID", "HSID", "SSID", "APISID", "SAPISID",
            "__Secure-3PSID", "PREF", "VISITOR_INFO1_LIVE"]


def _names_on_youtube(path: Path) -> set[str]:
    names = set()
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        domain, name = parts[0], parts[5]
        if domain.endswith("youtube.com"):
            names.add(name)
    return names


def missing_required(path: Path) -> list[str]:
    """Return the REQUIRED cookie names absent from a Netscape-format
    cookies.txt on .youtube.com. Empty list means the export looks complete.
    Raises FileNotFoundError/OSError if path doesn't exist. Zero network calls.
    """
    names_on_youtube = _names_on_youtube(path)
    return [n for n in REQUIRED if n not in names_on_youtube]


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "cookies.txt"
    if not path.exists():
        print(f"No file at {path}")
        sys.exit(1)

    names_on_youtube = _names_on_youtube(path)
    missing = [n for n in REQUIRED if n not in names_on_youtube]
    print(f"Checked {path} -- {len(names_on_youtube)} distinct cookie names on .youtube.com")
    if missing:
        print(f"MISSING: {', '.join(missing)}")
        if "LOGIN_INFO" in missing:
            print(
                "\nLOGIN_INFO specifically missing -- this export will very likely fail "
                "every grab with \"Sign in to confirm you're not a bot\", even though it "
                "looks like a normal, complete cookie file. Re-export after actually "
                "loading a real youtube.com video page while logged in (not just the "
                "homepage or a Google account page), and make sure your export "
                "extension's \"include HttpOnly cookies\" option is turned on."
            )
        sys.exit(1)
    print("Looks complete -- has all the cookies a real logged-in YouTube session needs.")


if __name__ == "__main__":
    main()
