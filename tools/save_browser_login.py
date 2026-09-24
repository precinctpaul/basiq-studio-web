"""Run this ONCE, manually, whenever a login-gated live source (a cable-
provider/TVE wall like News12's "Select your TV provider") needs to be
captured, or whenever a previously-saved session has expired.

This opens a REAL, VISIBLE Firefox window (not Chromium -- confirmed
2026-09-24: Akamai Bot Manager, which fronts this exact News12/Optimum
login, challenged Playwright's automated Chromium with a "confirm you're
human" loop before a real login could even be attempted. Firefox's
automation footprint isn't targeted by that same fingerprinting nearly as
often. resolve_live_stream_generic() in basiq_agent.py uses Firefox for the
same reason -- keeping both on the same engine also avoids a login saved
under one engine's fingerprint being replayed under a different one's).
A human logs in by hand, in that window -- this script never sees or
handles the password itself, it only saves the resulting session (cookies +
localStorage) to a file once you're done. basiq_agent.py's
resolve_live_stream_generic() then loads that file (via the
PLAYWRIGHT_STORAGE_STATE env var) to resolve and capture that source as an
already-authenticated viewer, without ever logging in itself.

Usage:
    python tools/save_browser_login.py https://westchester.news12.com/live tools/tve_session.json

Then set, wherever basiq_agent.py runs (e.g. /etc/basiq-agent.env on the
droplet):
    PLAYWRIGHT_STORAGE_STATE=/var/www/basiq-studio-web/tools/tve_session.json

and restart the basiq-agent service.

The saved file contains live session cookies -- treat it like a credential
(don't commit it; keep it out of version control) and re-run this whenever
captures of that source start failing again, since the underlying session
will eventually expire.
"""
import sys

from playwright.sync_api import sync_playwright


def main() -> None:
    if len(sys.argv) != 3:
        print("usage: python tools/save_browser_login.py <url> <output_storage_state.json>")
        raise SystemExit(1)

    url, out_path = sys.argv[1], sys.argv[2]

    with sync_playwright() as p:
        browser = p.firefox.launch(headless=False)
        try:
            context = browser.new_context()
            page = context.new_page()
            try:
                # "domcontentloaded", not the default "load" -- an ad-heavy
                # news page like this one can easily never fire a clean
                # "load" event within any reasonable timeout (confirmed
                # 2026-09-24: a real attempt timed out after 30s waiting on
                # it). The page is still fully usable well before that.
                page.goto(url, wait_until="domcontentloaded", timeout=30000)
            except Exception as exc:
                print(f"(navigation didn't fully settle, continuing anyway: {exc})")
            print(f"\nA real browser window is now open at {url}.")
            print("Log in there yourself (this script never sees your password).")
            input("Once you can see the live stream playing, press Enter here to save the session... ")
            context.storage_state(path=out_path)
            print(f"Saved session to {out_path}")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
