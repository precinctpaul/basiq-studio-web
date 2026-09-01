# Media health — one-off diagnostics and repairs

Standalone scripts (run directly, never imported) from three separate
investigations into the archive's media files, all from the same week
(2026-08-26 to 2026-08-28). Each is read-only unless noted otherwise.

## "Raw MPEG-TS saved as .mp4" files

Some files in the archive are raw MPEG Transport Stream data sitting under a
`.mp4` extension instead of being remuxed into a real MP4 container —
players can choke on these even though the bytes are fine.

- **`scan_ts_files.py`** / **`scan_ts_files2.py`** / **`scan_ts_files_threaded.py`** —
  read-only scanners that find affected files, in that order of iteration
  (the threaded version is the one worth running on a network-mounted drive;
  see its own docstring for why).
- **`check_ts.py`** — checks a single file for the TS signature.
- **`fix_ts_files.py`** — repairs affected files by remuxing with ffmpeg
  (`-c copy`, no re-encode). Never deletes the original; renames it to
  `<name>.mp4.orig-ts` only after verifying the fixed file's duration
  matches.

## "moov atom" / faststart diagnosis

- **`check_moov.py`** — reads an MP4's box structure to tell whether `moov`
  is near the front (streamable) or the end (a browser may look stuck until
  the whole file downloads).

## The 354-video unprobed staging pile

- **`diagnose_unprobed_videos.py`** — read-only: explains *why* a given
  video never got duration/codec metadata (subfolder files that
  `scan_media()`'s top-level-only glob never discovers vs. genuine probe
  failures), so a fix targets the real cause instead of just re-running the
  probe and hoping.

## Duplicate rows from live capture

- **`cleanup_zombie_live_captures.py`** — one-off fix for the
  `videos_local_path_key` bug (since fixed in `app/api/videos/route.ts` +
  `page.tsx`): merges tags/transcript from the stale "recording" row onto
  the real "ready" row it was duplicated from, then deletes the stale one.
