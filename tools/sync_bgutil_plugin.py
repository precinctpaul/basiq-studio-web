"""Keep the bgutil-ytdlp-pot-provider pip package's major version matched to
the bgutil.service HTTP server it talks to -- run on the droplet only, as
part of basiq-ytdlp-update.service (see tools/build/deploy/).

Why this exists: the plugin and the server are deployed by two unrelated
mechanisms (pip vs. bgutil.service's own systemd/Deno setup), so nothing
keeps their versions in sync automatically. A static pip pin (what this
replaces) only fixes today's mismatch -- the day someone bumps the server
to a new major version, the pin goes stale again and every YouTube grab
breaks the exact same way (confirmed 2026-09-29: droplet's plugin sat at
1.3.1 for weeks against the server's 2.0.0). This queries the server's own
/ping for its real current version and installs a matching plugin release
every time the weekly sync runs, so the pairing can't drift either
direction without a code change.

Exits 0 even when the server can't be reached or its version can't be
parsed -- a transient server hiccup during the weekly sync should not
block the yt-dlp upgrade or the agent restart that follow it in
ExecStart. Only a real pip install failure (the version this queries for
genuinely isn't a published release) is treated as an error worth a
non-zero exit and a loud log line.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.request

PACKAGE = "bgutil-ytdlp-pot-provider"
DEFAULT_BASE_URL = "http://127.0.0.1:4416"
TIMEOUT_SECONDS = 10


def _server_version(base_url: str) -> str | None:
    try:
        with urllib.request.urlopen(f"{base_url}/ping", timeout=TIMEOUT_SECONDS) as resp:
            data = json.load(resp)
    except Exception as exc:
        print(f"[sync_bgutil_plugin] could not reach {base_url}/ping, skipping this run: {exc!r}")
        return None
    version = data.get("version")
    if not version or not isinstance(version, str):
        print(f"[sync_bgutil_plugin] /ping response had no usable 'version' field: {data!r}")
        return None
    return version


def main() -> int:
    base_url = os.environ.get("BGUTIL_POT_BASE_URL", DEFAULT_BASE_URL)
    version = _server_version(base_url)
    if version is None:
        return 0

    major = version.split(".", 1)[0]
    spec = f"{PACKAGE}=={major}.*"
    print(f"[sync_bgutil_plugin] server at {base_url} reports version {version} -- installing {spec}")

    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", spec],
        capture_output=True, text=True,
    )
    print(result.stdout)
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        print(f"[sync_bgutil_plugin] pip install {spec} failed -- see output above", file=sys.stderr)
        return 1

    print(f"[sync_bgutil_plugin] {PACKAGE} now matches server major version {major}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
