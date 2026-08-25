"""
backfill_youtube_titles.py — recovers real titles for videos that only ever
got the raw YouTube ID as a title (e.g. "yt_HOdEOs7_wHY" instead of a real
name).

CAUSE: same root issue as the duration problem, but this half isn't
recoverable from the video file itself — a title was never encoded in the
bytes. It only ever existed on YouTube's page.

FIX: ask yt-dlp for JUST that page's metadata (title, uploader, channel) —
no re-download, a few KB per request, seconds each. If the video is still
live on YouTube, this recovers everything. If it's since been deleted or
made private, yt-dlp will fail on that one and we leave it alone — there's
nothing left to recover from.

RUN THIS ON YOUR OWN MACHINE, not the droplet. YouTube blocks the droplet's
datacenter IP for exactly this kind of request (see tools/README.md); a
normal residential connection works fine.

Needs yt-dlp installed — you already have it if basiq_agent.py runs:
    pip install yt-dlp

SAFE TO RE-RUN: only touches videos whose title still looks like a raw
YouTube ID, so a second run just mops up whatever the first one couldn't
reach (e.g. a video that was temporarily unavailable).

    python backfill_youtube_titles.py
"""

import re
import time
from pathlib import Path

import yt_dlp
from supabase import create_client, Client

# --- CONFIGURATION ---
SUPABASE_URL = "https://tijwokimlrglufjqiwok.supabase.co"
# STOP! Replace with your SUPABASE_SERVICE_ROLE_KEY from .env.local
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRpandva2ltbHJnbHVmanFpd29rIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NjgyMDQ0OSwiZXhwIjoyMTAyMzk2NDQ5fQ.vD586cg84F9LuNRb7AegIiu5Cn843wezSKmnX23Q1pw"

PAGE_SIZE = 1000
SLEEP_BETWEEN_CALLS = 1.0  # be polite — avoid tripping YouTube's rate limits

# Same escape hatch basiq_agent.py already documents for age-gated/members-
# only content — YouTube increasingly bot-checks even anonymous, logged-out
# requests, and borrowing your browser's real login session gets past it.
# Change to "edge", "firefox", or "brave" if that's what you're logged into
# YouTube with. CLOSE THAT BROWSER before running this — on Windows, yt-dlp
# can't read the cookie file while the browser has it open.
COOKIES_FROM_BROWSER = "firefox"

RAW_TITLE_RE = re.compile(r"^yt_([A-Za-z0-9_-]{6,})$")


def fetch_all(supabase: Client, table: str, columns: str) -> list:
    rows, page = [], 0
    while True:
        res = supabase.table(table).select(columns).range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1).execute()
        batch = res.data or []
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
        page += 1
    return rows


def extract_video_id(title: str, local_path: str) -> str | None:
    m = RAW_TITLE_RE.match((title or "").strip())
    if m:
        return m.group(1)
    stem = Path(local_path or "").stem
    m = RAW_TITLE_RE.match(stem)
    return m.group(1) if m else None


def fetch_metadata(video_id: str) -> dict | None:
    url = f"https://www.youtube.com/watch?v={video_id}"
    opts = {
        "skip_download": True,
        "quiet": True,
        "no_warnings": True,
        "cookiesfrombrowser": (COOKIES_FROM_BROWSER,),
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:
        msg = str(e).lower()
        if "sign in" in msg or "not a bot" in msg:
            return {"_blocked": True}
        return None

    title = (info.get("title") or "").strip()
    if not title:
        return None
    return {
        "title": title,
        "uploader": (info.get("uploader") or "")[:255],
        "channel": (info.get("channel") or info.get("uploader") or "")[:255],
    }


def main():
    print("Connecting to Supabase...")
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

    print("Loading videos and checking for raw-ID titles...")
    all_rows = fetch_all(supabase, "videos", "id, title, local_path")
    candidates = [r for r in all_rows if RAW_TITLE_RE.match((r.get("title") or "").strip())]
    print(f"  {len(all_rows)} videos total, {len(candidates)} need a title lookup.")

    recovered = 0
    unavailable = 0
    blocked = 0
    failed = 0

    for i, row in enumerate(candidates, 1):
        video_id = extract_video_id(row.get("title"), row.get("local_path"))
        if not video_id:
            failed += 1
            continue

        meta = fetch_metadata(video_id)
        time.sleep(SLEEP_BETWEEN_CALLS)

        if meta and meta.get("_blocked"):
            blocked += 1
            continue

        if not meta:
            unavailable += 1
            continue

        try:
            supabase.table("videos").update(meta).eq("id", row["id"]).execute()
            recovered += 1
        except Exception as e:
            print(f"  FAILED writing {video_id}: {e}")
            failed += 1

        if i % 50 == 0:
            print(f"  ...{i}/{len(candidates)} checked ({recovered} recovered, {blocked} blocked so far)")

    print("\nDone.")
    print(f"  Recovered:           {recovered}")
    print(f"  No longer available: {unavailable}  (deleted/private on YouTube — can't recover)")
    print(f"  Blocked by bot-check:{blocked}  (cookies didn't get through — see note below if > 0)")
    print(f"  Errors:              {failed}")

    if blocked > 0:
        print(
            "\nSome requests were still blocked even with cookies. Make sure "
            f"you're actually logged into YouTube in {COOKIES_FROM_BROWSER}, "
            f"and that {COOKIES_FROM_BROWSER} was fully closed while this ran."
        )


if __name__ == "__main__":
    main()
