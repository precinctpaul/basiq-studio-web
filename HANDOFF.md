## Living status — keep this section current (last updated 2026-09-03)

This is the actively-maintained section of this file. Update it as things change; don't let it go stale like the 2026-08-28 dump below did. Everything below the next `---` is historical (Archive-consolidation handoff, superseded — see its own note).

### Clip Mode Lite — real-world test caught a bug, fixed (2026-09-03, ~4am)

First live test on production (basiq.51st.media) failed. What actually
happened, and what's fixed vs. still open:

**Bug found and fixed:** `requireSharedDrive()` (called at the top of both
`runGrab` and `runLiveCapture`, in *both* modes) was the one call site missed
when gating clip mode's `/api/library` traffic in the "Phase 1 shipped" work
above — it unconditionally called `agentLibrary()`. Confirmed via the user's
own HAR export (`Downloads/basiq.51st.media.har`) that this fired on every
grab attempt and, because it maps *any* failure to "Shared drive not
mounted" (a `.catch(() => ({exists:false}))` that swallows the real error),
turned an unrelated 500 into a hard block on every single grab — this is
exactly the error message the user saw. Fixed the same way as the other call
sites: skip the check entirely in clip mode (`if (clipMode) return;`); the
agent's own job status now surfaces a real error instead if the drive
genuinely isn't mounted. Re-verified locally: a grab attempt in clip mode now
reaches `POST /agent/grab` directly with zero `/api/library` calls anywhere
in the sequence (confirmed via network capture) — it only fails in this dev
sandbox because no local agent is reachable here, which is expected.

**Separate, NOT fixed (no DB access from here) — likely the actual root
cause of tonight's failure:** the HAR shows `/api/library` and
`/api/library/buckets` both returning 500 with the literal Postgres/PostgREST
error `"Could not query the database for the schema cache. Retrying."` —
this is a real backend error, not something clip mode's code caused (it
would have blocked normal Studio-mode grabs too, via this same
`requireSharedDrive` call, since gating it only helps clip mode). Timing
lines up closely with `0011_lock_down_public_relations.sql` (the RLS/REVOKE
migration run by hand in the Supabase SQL editor earlier tonight, per the
`8e53741`/`907f470` commits) — though that migration's own author verified
the app's queries (all via the service-role key, which bypasses RLS/grants
entirely) shouldn't be affected, so this is a correlated hypothesis, not a
confirmed mechanism. **Recommended first step: Supabase Dashboard → Project
Settings → API → "Reload Schema Cache"** (or `NOTIFY pgrst, 'reload
schema';` in the SQL editor) — safe, non-destructive, and the standard fix
for PostgREST stuck in this state. If that doesn't clear it, it may be
transient connection-pool pressure (see `lib/supabase-errors.ts`, which
already documents a related schema-cache error class this project has hit
before) rather than the migration at all.

**Unrelated to any of this — a local-machine finding, not a code issue:**
the "CLI terminal windows kept popping up" / "one's already open, try again
in 10 seconds" symptom is the Windows Scheduled Task **"Basiq Worker"**,
confirmed via `schtasks` to already be running `basiq_worker.py`
continuously in the background on this machine. The manual
`cd tools && start-worker.bat` step in the usual 4-command test sequence is
redundant now and collides with that already-running instance (the
singleton lock — see the 2026-08-31 "no more duplicate workers" entry below
— is doing exactly what it's supposed to). Worth dropping that manual step
from the usual sequence; nothing to fix in code.

**Still not done:** a real end-to-end grab against the actual agent/worker —
blocked tonight by the bug above, not yet re-attempted. Next test should
work now that the pre-flight check is gone, assuming the schema-cache issue
either doesn't block it (it shouldn't, now) or has cleared by then.

### Clip Mode Lite — New Branch (2026-09-02)

**Branch:** `feat/clip-mode-lite`

**Problem:** Main Studio is feature-rich but fragile — goes down periodically because it's trying to do too much:
- Heavy `/api/library` calls exhaust the DB connection pool (code guards against this: `app/page.tsx:175-180`)
- State bloat from thousands of archived rows in memory
- Concurrent async operations (library refresh, tags, transcription, grabs) fight for resources
- Background operations (RESCAN, auto-tag) add unpredictable load

**Solution:** Build a **parallel, minimal-scope "Clip Mode"** that eliminates archive/discovery entirely and keeps only the linear capture→clip→export path. Different users pick based on need:
- Main Studio (`/`): Power users needing discovery + tagging + archive browsing  
- Clip Mode (toggle within Studio, or `/clip` later): Fast capture + quick clipping for "I know what I want" users

**Why this helps stability:** No `/api/library` calls at all (the main bottleneck), zero archive state in memory, linear predictable async flow — stays up while the main app is optimized.

**Scope (Phase 1):**
- Add `clipMode` state in `app/page.tsx`
- Toggle button in header
- Conditionally hide LibraryPanel when `clipMode === true`
- Adjust column widths (center expands when left is hidden)
- Save preference to localStorage
- Est. 1 hour total

**Success:** Can paste URL → grab → mark in/out → export. No archive/library queries. Stays stable under sustained use.

**Next:** See handoff note at end of this section and hand off to new thread with full implementation plan.

### Repo tidy-up (2026-09-01)

The long-stray untracked files noted in the old handoff's §9 below are
resolved. `tools/check_moov.py`, `check_ts.py`, `scan_ts_files*.py`,
`fix_ts_files.py`, `diagnose_unprobed_videos.py`, and
`cleanup_zombie_live_captures.py` (one-off diagnostics from the TS-file and
unprobed-pile investigations) moved into `tools/media_health/` with a
README. `resolve_metadata.py` moved into `tools/archive_consolidation/`,
its actual home. `components/studio/files.zip` (a superseded pre-fix backup
of `page.tsx`/`QueuePanel.tsx`) and a stray `tools/Volumes...` directory
(4.6MB of leftover hardening-test video files, created by a path-building
bug) were pulled out of the repo entirely into
`C:\dev\basiq-cleanup-2026-09-01\` rather than deleted. Also wrote
`GUIDE.md` — a plain-English daily-use walkthrough, including `/codegen`.

### Done and verified this session (2026-08-31 → 2026-09-01)

- **Long-video slow-start fix — closed out.** The real fix for the "moov box too big" problem noted 2026-08-29: remux affected files to fragmented MP4 via `tools/fragment_long_videos.py` (scratchpad). Ran overnight, deliberately stopped 2026-09-01 to free the machine for the transcription backfill (below), now the sole priority. Final tally: **1,325 / 1,562 fragmented (84.8%)**, 235 remaining (~307 GiB, skews long — 97 of the 235 are 8hr+, five are 26–35hr multi-day C-SPAN captures), 2 source files missing entirely (see pending item #7). Idempotent and safe to resume any time with `python fragment_long_videos.py --apply --workers N` — no rush, since videos under ~5hrs are effectively all done already. Team-facing line: "any video longer than 5 hours may take a little longer to load" is accurate for what's left unfragmented.
- **Live capture: universal fallback resolver.** yt-dlp only covers sites with a dedicated extractor; added a Playwright-based generic resolver (network-sniffs the page's own player for its manifest URL) as a fallback in `basiq_agent.py`. Fixes CBS News, ABC News, and any other live page yt-dlp doesn't know — confirmed working for CBS. ABC's own CDN still 404s on sub-manifests even with this (see Pending below).
- **Live capture: STOP button fixed.** Two separate real bugs, both fixed and deployed: (1) `_handle_stop` in `basiq_agent.py` was clobbering an already-Complete job's status back to "Stopping…" — fixed by checking for a terminal state first. (2) `basiq_worker.py`'s stop-bridge thread had a startup race that could make it exit immediately without ever polling, permanently disabling STOP for that capture — confirmed to actually happen on a 12-minute open-ended X.com capture. Fixed by not gating the poll loop on a dict entry that might not exist yet.
- **Live capture: no more duplicate workers.** The worker's singleton lock was check-then-write, not atomic — two instances starting close together (e.g. a manual restart racing the Scheduled Task's own once-a-minute watchdog) could both pass the check. Replaced with an atomic `O_CREAT|O_EXCL` file claim. Confirmed the old bug recurred once mid-session (four instances at once) and hasn't since the fix.
- **Live-in-progress transcription and clipping — parked, not deleted.** Watching the transcript grow and clipping from a still-recording file were both removed from the live-capture flow (they required the incremental-transcribe step, which could freeze the whole polling loop for minutes waiting on file sync — see the STOP button bug above for a related symptom). Transcription/tagging now only starts after a capture finishes, through the same pipeline a regular download uses. The parked backend support code (`/api/videos`' "recording"-status row, "recording" allowances in `/api/clips` and `/api/videos/[id]/transcripts`) is left in place, untouched, if this gets revisited.
- **LucidLink backlog cleared, throttle retuned.** A ~170 GiB backlog (H-drive migration + this session's own file rewrites) plus a too-aggressive upload throttle (unlimited → 1MB/s → 20MB/s, each a reaction to the previous problem) caused real collateral damage: SSL handshake timeouts, a stuck-recording playback bug (files complete locally but zero-byte on the droplet for hours), and likely contributed to a severe system memory squeeze (0.7GB free at the worst point). Backlog is now fully drained; throttle settled at a moderate 12MB/s / 4 connections, confirmed stable. Memory pressure resolved once the user closed several RAM-heavy apps (Chrome/etc.) unrelated to anything code-side — not a standing issue, was never really about Item 3 or the throttle.
- **Transcription backfill batch — now the sole active background job, running.** The 798-video estimate from 2026-08-29 was stale — the H-drive migration alone added ~2,200 videos, most transcript-less, so the real number is **2,043 videos, ~3,870 hours of audio** (grew ~2.8x). Deliberately NOT run against the droplet (only 1.9GB RAM / 1 CPU, and it also runs live capture's control plane — bulk whisper there risked crashing the thing we spent all night stabilizing). Instead built `transcribe_missing_videos.py` (scratchpad), which imports `basiq_agent.py` directly and calls its `run_transcribe()` — already does its own direct Supabase writes (transcript + segments + tags), no droplet/HTTP involved at all. Runs on this machine (8-core/16-thread, 32GB). Benchmarked against real backlog videos to find the actual throughput ceiling: `basiq_agent.py`'s shared Whisper model defaults to `num_workers=1`, which serializes inference regardless of app-level thread count — added an env-gated override (`WHISPER_NUM_WORKERS`/`WHISPER_CPU_THREADS`, defaults unchanged so the droplet is unaffected). Real results on similar-length (~32min) videos: default (1 worker) = 69s/video avg; **4 workers × 2 cpu_threads (matches the 8 physical cores) = 51s/video avg, the winner**; 8 workers × 1 thread = worse, didn't even finish a same-size batch in the time the 4-worker config took. Now running at `--concurrency 4` with `WHISPER_NUM_WORKERS=4 WHISPER_CPU_THREADS=2`. Validated end-to-end on a real 22-minute C-SPAN video before trusting it at scale (~39s to transcribe, confirmed segments actually landed in Supabase). Two real gotchas found and fixed during that validation: (1) `run_transcribe`'s `language=""` gets rejected outright by faster-whisper — needs `basiq_agent.DEFAULT_LANGUAGE` instead; (2) a small number of candidates (~7) have DB rows whose file doesn't exist at all — `run_transcribe`'s own sync-wait would burn 20 minutes per one of these before giving up, so the script pre-filters them. Also found ~15 candidates with suspiciously near-zero `duration_seconds` (a probe-failure artifact, not genuinely short) that get excluded rather than counted as real failures. Check progress: `Get-Content <scratchpad>\transcribe_full_run.log -Wait -Tail 20`.

### Clip Mode Lite — Phase 1 shipped (2026-09-02, Thread 3)

**Status: implemented and verified on this branch, not yet committed.** All
checklist items below are done. Changed only [`app/page.tsx`](app/page.tsx),
per plan — no backend/route/agent changes.

What actually landed:
- `clipMode` boolean state, persisted to `localStorage` under `basiq.clipMode`
  (same load-effect-then-guarded-save-effect shape already used for
  `cols`/`queueHeight`, to avoid a hydration mismatch — see the code comment
  at its declaration).
- A `CLIP MODE` toggle button in the header next to the wordmark, reusing the
  existing `.btn-ghost` / `data-checked` pattern (same look as the CAPTIONS
  and MUTE toggles) — no new CSS.
- `LibraryPanel` and the right-hand tab panel (Transcript / Key Moments /
  Details, which is also where manual tag add/remove/retag lives) are not
  rendered at all when `clipMode` is on; the center column expands to fill
  the freed width. `ShareBar` (the post-export share link) stays visible —
  it renders in the center column, not the right panel, so hiding tags/
  transcript doesn't cost you the export/share flow.
- `IngestBar` and `QueuePanel` are untouched and fully functional in both
  modes, as planned.
- Closed the actual stability gap, not just the visible one: hiding
  `LibraryPanel` alone would NOT have stopped the `/api/library` traffic —
  `refreshLibrary()`, `rescan()`, and `checkAgent()`'s library sub-call are
  called from inside the *shared* `runGrab`/`runLiveCapture`/`doExport`
  functions (used by both modes), not from `LibraryPanel` itself. Each is now
  gated on `!clipMode` (early-return / skip, default behavior for Studio
  mode is unchanged). Confirmed via a live network capture: toggling Clip
  Mode on, then reloading with it persisted on, fires zero `/api/library`
  calls other than one unavoidable pair on cold reload (see caveat below).
- **The background archival pipeline is untouched and confirmed still
  automatic in both modes** — this was the new requirement added when this
  thread kicked off. `runGrab`, `runLiveCapture`, and `onUploadFinished` all
  end by calling `transcribeAndTag()` unconditionally; that function isn't
  gated on `clipMode` anywhere. So any clip grabbed, captured, or uploaded
  from Clip Mode still gets transcribed and auto-tagged and lands in the same
  Supabase-backed library as a normal Studio grab — nothing extra was needed
  to make that true, it was already true by construction ("Same app, just a
  different UI mode" from Thread 2's plan). Only the UI for *manually*
  editing tags (in DetailsPanel) is hidden.
- No new API/compute cost: this reuses the exact same grab → transcribe →
  tag calls (local Whisper + the existing tagger) that main Studio already
  makes per ingest. Clip Mode doesn't add a second pipeline or call anything
  new — it just doesn't also fire the library-browsing calls alongside it.

Decisions made on Thread 2's three open questions (none blocked on the
user — reasonable defaults, flagged here for visibility):
1. **Right panel:** hidden entirely (Transcript/Key Moments/Details, including
   tag editing) — matches the "excludes: Transcript panel, Tag operations"
   scope. `ShareBar` kept, since it's structurally separate and is how you
   actually get the exported clip's link.
2. **IngestBar simplification:** skipped — left untouched per the "already
   works great, don't touch" note. Revisit only if the full title/max-minutes
   fields prove distracting in practice.
3. **Route split:** stayed a toggle, not a separate `/clip` route. Simplest
   thing that satisfies "parallel runway" without duplicating the shell.

Known minor caveats (not regressions, inherent to the approach):
- **One-time cold-reload flash.** Because `clipMode` loads from `localStorage`
  in an effect (not the `useState` initializer, to avoid a hydration
  mismatch — same tradeoff already accepted for `cols`/`queueHeight`), a full
  page reload with Clip Mode persisted on still briefly mounts `LibraryPanel`
  for one render before it's hidden, which fires its own internal
  `/api/library/buckets` fetch once. This is a single harmless pair of
  requests on cold load only, not a repeat cost during a working session, and
  there's no way to remove it without either an SSR opt-out for the panel or
  accepting a hydration warning — not worth either trade for Phase 1.
- **File-upload path still does one `/api/library` lookup.** `onUploadFinished`
  finds the newly-uploaded row by fetching the whole library and matching on
  `local_path` (pre-existing behavior, not something Clip Mode introduced —
  grab's own equivalent lookup was already fixed to a direct by-id fetch, see
  the comment at `runGrab`'s `/api/videos/${jobId}` call). Fixing this would
  mean changing the upload endpoint's response contract to return the row id
  directly, which touches a backend route — out of scope for a page.tsx-only
  Phase 1 change. Only matters if someone drag-drops a file while in Clip
  Mode; paste-a-URL (the mode's main use case) doesn't hit this at all.

Verified: toggle on/off and reload-persistence confirmed visually (real
screenshots, not just DOM inspection) via the dev server; `tsc --noEmit`
clean; `npm run lint` on the changed file shows the same 3 pre-existing
`react-hooks/set-state-in-effect` / `no-explicit-any` errors this file
already had on `master` plus one new instance of the identical
already-accepted pattern (`setClipMode` in a mount effect, same shape as the
pre-existing `setCols`) — not a new class of problem. Did not test an actual
grab/capture/export end-to-end — this dev sandbox has no local agent
reachable (`Can't reach the local agent at http://127.0.0.1:8000`) and the
dev DB returned schema-cache errors unrelated to this change; that pipeline
itself (`runGrab`/`transcribeAndTag`/etc.) was not modified, only gated for
`clipMode`, so real end-to-end testing on a machine with the agent running is
still worth doing before calling this fully proven in production.

**Next:** commit (not yet done — waiting on an explicit go-ahead), then
ideally a real grab/capture/export smoke test against a running local agent.

### Clip Mode Lite — Implementation Handoff (Thread 2)

**Branch:** `feat/clip-mode-lite` (fresh, just created)

**Architecture:** Same app, different UI mode. No backend changes needed. Existing grab/capture/export pipeline already perfect for this.

**What Clip Mode Includes:**
- IngestBar (URL paste + Live stream capture)
- PlayerPanel (play, mark in/out, adjust aspect ratio)
- Quick export (clip the marked range)
- QueuePanel (show job progress)

**What Clip Mode Excludes:**
- LibraryPanel (left sidebar with search/filter/sort) — **deleted from render tree**
- Archive discovery UI
- Transcript panel (or minimal)
- Tag operations
- RESCAN/library sync
- All `/api/library` calls

**Data Flow:**
```
User pastes URL → Grab/Capture job → Media loads → Mark in/out → Export → Done
```

**Files to Modify:**
- `app/page.tsx` — Add `clipMode` state, toggle button, conditional rendering, column width logic
- No other files need changes

**Files to NOT Touch:**
- Backend routes
- IngestBar, PlayerPanel, QueuePanel (already work great)
- Agent pipeline

**Implementation Checklist:** (done — see "Phase 1 shipped" note above)
- [x] Add `clipMode` boolean state
- [x] Add toggle button in header (next to wordmark)
- [x] When `clipMode === true`: hide `<LibraryPanel />` element entirely
- [x] Adjust column widths: `{left: 0, center: 100, right: 0}` or hide right panel
- [x] Save/restore from localStorage (`basiq.clipMode`)
- [ ] Test grab flow (paste URL, download, mark, export) — **not done, no local agent in this sandbox**
- [ ] Test live capture flow (paste live URL, start capture, mark, export) — **not done, same reason**
- [x] Verify no `/api/library` calls fire when in clip mode (check Network tab)
- [x] Toggle works and persists on reload

**Open Questions for Next Thread:**
1. Hide right panel entirely in clip mode, or keep it for export/share info?
2. Simplify IngestBar (hide title/maxMinutes fields until needed)?
3. Once proven stable, spin into separate `/clip` route, or keep as toggle?

**Success Criteria:**
- ✅ Paste URL → grab works
- ✅ Live stream capture works
- ✅ Mark in/out and export works
- ✅ Toggle persists
- ✅ Zero archive queries in clip mode
- ✅ Stays up under sustained use (unlike main app)

---

### Pending, prioritized

1. **Fetch-timeout audit.** The STOP-button investigation above surfaced a real pattern: `startTranscription()`'s client-side fetch to `/api/transcribe` (in `lib/agent.ts`) has no timeout at all, and neither does that route's own server-side fetch to `WHISPER_URL` (`app/api/transcribe/route.ts`). That's what let one slow backend call freeze the entire live-capture UI. Worth sweeping the rest of the codebase for the same class of gap before it bites again somewhere else.
2. **Check `basiq-web`'s pm2 restart count.** Noticed in passing while deploying tonight's fixes: 175 restarts over a 20-hour uptime on the droplet. Never investigated whether that's a real recurring instability or leftover history from before tonight — worth a quick look.
3. **"Right-click → Open Containing Folder"** (carried over from 2026-08-29, still not started). Needs the *local* agent, not the shared production one, to expose an "open this folder" action — only works for someone running their own local agent with the drive mounted.
4. **The "back" button stale-rows bug** (carried over from 2026-08-29, still unreproduced). User report: inside a person view, searched, played results, clicked back repeatedly to the root bucket list, saw stale rows from the person view rendered above the bucket row. Tried twice against production, including a rapid-fire no-delay version — could not reproduce either time. Needs a repeat occurrence with precise steps, or a screen recording.
5. **Item 5: proxy vs. high-res workflow decision.** Explicitly parked pending an actual decision from the user — not something to just start on.
6. **Fresh hardening pass** over a new HAR capture, now that tonight's fixes are live, to catch anything else the same way the STOP button and freeze bugs were caught.
7. **Video-completeness repair pass — done (2026-09-01).** Checked all 11,273 `videos` rows against the actual files on disk: 3 (`cspan_662803.mp4`, `cspan_443365.mp4`, `cspan_667238.mp4`) had a duplicated-prefix `local_path` (`Archive/Basiq-Studio-Hub/Archive/Basiq-Studio-Hub/...`) pointing at the wrong location even though the real file existed — fixed by stripping the duplicate prefix, verified against disk before writing. 6 more (`df5ae12c853c…mp4` and 5 others, all bare-GUID-named) had no file on disk at all and no path-bug explanation — deleted (cascades to their transcripts/segments/clips/tags/key_moments via existing FK constraints). **11,267 videos remain, all confirmed playable.** Still open, low priority: ~15 transcription-backfill candidates with a suspiciously near-zero `duration_seconds` (a probe-failure artifact, not genuinely short) — excluded from the backfill rather than counted as real failures; would need re-probing before transcription makes sense for them.
8. **889 `archive_items` have no video file under `Archive/Basiq-Studio-Hub` at all** (carried over from 2026-08-29, still not started). Low priority — tied to the Archive feature, which is parked. Their only copy lives in `C:\Majority Democrats\basiq_ingest` or the separate "Eluvio POC" folder; `tools/import_archive_items_to_library.py` will pick them up automatically once/if someone copies those files over — no code changes needed, just the file move.
9. **ABC News live capture still doesn't work.** The generic resolver (see Done, above) finds ABC's manifest fine, but its sub-playlists 404 even fetched through the real browser's own authenticated session — likely additional signing/indirection specific to ABC's Akamai/Disney video platform. Low priority: CBS + the generic resolver already deliver "capture from any live source," which was the actual goal.
10. **Untested live-capture sites.** Only YouTube, Bloomberg, CBS, and X.com are actually confirmed working end-to-end tonight. The generic resolver should cover other sites with the same live-page-plus-manifest pattern, but that's untested, not confirmed.
11. **Raise `MAX_CLIP_SECONDS` (2026-09-01 evening).** Currently 180s (`lib/export-settings.ts`), paired with `FUNCTION_MAX_DURATION_SECONDS=300` — both sized around Vercel's serverless function timeout, which no longer applies now that `basiq-web` runs as a persistent process on the droplet under pm2. Confirmed via a real HAR capture tonight: an export attempt on a ~5m12s in/out selection correctly got rejected with `"clip too long — 180s max per export"` — working as designed, not a bug, but worth revisiting now that render time isn't actually wall-clock-capped the way it was on Vercel. User wants this extended; explicitly not done tonight (no changes right before tomorrow's presentation) — do it as its own deliberate change, and re-check whether `FUNCTION_MAX_DURATION_SECONDS`'s reasoning (see its comment in `lib/export-settings.ts`) still needs to move in step or can be dropped now that there's no serverless ceiling.
12. **Merging `archive_items` into Library — explicitly parked, not even a dry run (2026-09-02).** User asked what running `tools/import_archive_items_to_library.py` would actually do; investigation surfaced two real gaps neither the script nor any migration currently handles: (1) its dedupe is exact-filename-only (via `videos.local_path`'s unique index) — it does **not** catch the same real-world hearing existing as two different files across sources (e.g. a live GRAB capture already in `videos` vs. a YouTube/C-SPAN copy of the same event pulled into `archive_items` by the old consolidation sweep), so running it could create visible duplicate search results for the same event; (2) the archive's transcript pipeline never pushed per-segment (timestamped) rows to Supabase, only flat `full_text` — and `TranscriptPanel.tsx` renders strictly from segments, so any video backfilled via `--with-transcripts` would be full-text-searchable but show the empty-transcript state in the actual player, a real user-visible inconsistency. Neither has a fix designed. User's explicit call: hold off entirely, no dry run, revisit later as its own deliberate task — not before a presentation.

---

(Everything below this line is the prior, 2026-08-28 handoff and is now substantially out of date — Archive has since been parked rather than redesigned further, the file-copy job referenced in §4 completed, and Library's own bucket taxonomy and video list were rebuilt to match. Kept for history rather than rewritten.)

# Archive Consolidation — Handoff (2026-08-28)

Written to close out a long session and start fresh in a new thread. Paste this whole file into the new thread as the first message.

## 1. What this project is

Basiq Studio Hub is a political video tool. There are **two separate systems** in this repo — do not confuse them:

- **Library** (the main home page, `/`) — the original, actively-used product. Videos/clips/tags schema, live capture pipeline, synced-transcript player. This is the one the user likes and wants other pages to look/work like.
- **Archive** (`/archive`) — a new, separate read-only view over a newly-consolidated historical dataset: ~9,032 video items pulled together from C-SPAN, YouTube, and old Basiq uploads, going back further than what Library ever ingested live. Different Supabase tables (`archive_items`, `archive_item_files`, `archive_item_transcripts`, `archive_item_tags`, `people`), different API routes (`app/api/archive/**`), different UI component (`components/archive/ArchivePanel.tsx`).

**The user's current, strongly-stated position: Archive is "sort of useless" and they "much much much prefer the main home page."** Multiple UI rebuild attempts this session did not close that gap. See §3.

## 2. Archive UI — the open problem

Do not attempt another from-scratch redesign. Instead: **open the Library/home page, catalog its actual UI conventions, and replicate them for Archive** — same person/bucket explorer feel, same item-list columns, same transcript display, same interaction patterns. The user has said this directly and repeatedly; guessing at "what a newsroom would want" from first principles is what led to multiple rejected rebuilds already. Confirm the plan (e.g. a quick before/after comparison) before investing heavily in more layout work.

Known concrete gaps as of the last build:
- Transcript view only shows plain paragraphs split at sentence boundaries (`paragraphize()` in `ArchivePanel.tsx`) — **not** timestamp-synced to the video like Library's player. Real fix needs per-segment data pushed to Supabase (~2.7M rows across the corpus — confirmed via `sum(transcript_segment_count) where transcript_status='available'` = 2,707,933 across 8,096 items). Deliberately not attempted yet — big, separate task.
- Search result rows were reported as needing "breathing room" (visual spacing) — not yet addressed.
- General layout/information density still doesn't match what the user wants from Library.

## 3. What IS fixed and verified on production (basiq.51st.media/archive)

Transcript/title search was broken in two independent ways; both are fixed and confirmed live:

- **Wrong results**: Postgres's `'english'` text-search config stems words, so "helene" and "helen" collapsed to the same match — a search for Hurricane Helene silently included every transcript merely mentioning someone named Helen. Fixed via `supabase/migrations/0009_simple_transcript_search.sql`, rebuilding `archive_item_transcripts.search_tsv` with the `'simple'` config (no stemming) — **user has already run this migration successfully** ("Success. No rows returned").
- **Slow / occasionally erroring**: an interim ILIKE-based scan of the raw `full_text` column (rows up to 250KB, no index) took 6–11+ seconds and sometimes hit a hard Postgres statement timeout (500), which the code's non-fatal error handling silently swallowed as "0 results." Fixed by switching back to the GIN-indexed `search_tsv` column now that it's correct.
- Verified directly against production after deploy: `helene` → 43 matches in 2.1s, `strikeout` → 2 matches in 0.97s, `landslide` → 87 matches in 1.1s, `medicaid` → 817 matches in 1.6s. All previously wrong and/or 6–11s+.

Also fixed and verified this session: duplicate bucket listing on the Archive landing page (root view was rendering the same 7-bucket list twice), and infinite scroll silently capping at 100 rows for large person lists (nested `overflow-y:auto` containers, `onScroll` was on the wrong element).

## 4. File copy job — STOPPED BY USER, do not auto-resume

442 video files live only in a local folder (`C:\Majority Democrats\basiq_ingest`), not on the shared LucidLink drive, so they're invisible/unplayable to anyone else and to the deployed Archive. A PowerShell script (`tools/archive_consolidation/copy_basiq_ingest_to_lucidlink.ps1`) was copying the underlying files (1,077 files once `.mp4`/`.srt`/`.info.json` triplets are counted individually, ~300GB total) from that folder to `C:\Volumes\md-pac\media\Archive\Basiq-Studio-Hub`.

**The user stopped this job.** Last confirmed progress before it stopped: **600 / 1,077 files copied, 0 skipped, 0 failed** (log: `tools/archive_consolidation/output/basiq_ingest_copy_log.txt`). It was taking too long (some individual C-SPAN files took 15–20+ minutes each).

This is an **open decision for the new thread**, not something to just restart:
- Resume the remaining ~477 files as-is (it's idempotent — skips files that already exist with a matching size, so re-running is safe)?
- Run it in smaller batches, or overnight, or on a different machine/connection?
- Deprioritize entirely — these 442 items were already resolved (person-matched) in the local SQLite index; they just aren't reachable from the deployed app until the files land on LucidLink. Nothing is broken by leaving this paused, it just means those specific items are not yet playable in Archive.

Whatever is decided, once files DO finish landing on LucidLink: (1) update the local SQLite index's file paths for those 442 items to the new LucidLink location, (2) re-run `tools/archive_consolidation/export_to_supabase.py` so those rows' paths/playability flags reflect the new location, (3) spot-check a few actually play in `/archive`.

## 5. Data pipeline status (all otherwise complete)

- Whisper transcription batch: 1,172/1,276 succeeded.
- Rolling-caption dedup (`fix_rolling_captions.py`): 5,176/8,096 items fixed.
- `archive_item_tags` exported to Supabase.
- Person-resolution pass run on the 35 previously-unresolved `basiq_ingest` items (2 false-positive last-name collisions caught and reverted before export — see §6).
- `source_url` backfilled for 8,720/9,032 items (1,220 from parsing the old `notes` field, 7,500 constructed directly from YouTube `canonical_id`).
- Bucket taxonomy exported and verified: Majority Democrats, The Bench, House, Senate, Notable Figures, Institutional, Uncategorized — mutually exclusive, counts sum to exactly 9,032. Roster lives in `lib/archiveBuckets.ts`.

## 6. Standing rules learned the hard way this project

- **Copy, never move** original media files. Always.
- **Never match people by last name only.** Confirmed real collisions in this dataset: Don Scott ≠ Sen. Tim Scott, Kayla Young ≠ Rep. Don/Todd Young, Johnny Garcia ≠ Rep. Robert Garcia (and earlier, Sherrill/Paige/Mallory). Exact full-name matching only, cross-checked by hand.
- Reuse existing product code/pipelines instead of reinventing (e.g. the bucket taxonomy mirrors the Library schema's existing MD/Bench roster handling in `bulk_tag_buckets.py`).
- Validate against real data before reporting something fixed — several bugs this session (duplicate buckets, "helene" returning 1 result, a swallowed 500 read as "0 results") were things that *looked* plausible from code/API/console inspection alone but were only actually caught via literal screenshots or direct curl/SQL evidence. **Always take a real screenshot for UI changes, not just DOM/API/console checks** — programmatic introspection alone has already let a visibly-obvious bug (duplicate buckets rendered twice) through once.
- User prefers itemized, scannable updates over long narrative write-ups — this file is formatted accordingly.

## 7. Key files

- `app/api/archive/route.ts` — list/search endpoint (bucket filters, tag filter, transcript+title search, snippet extraction)
- `app/api/archive/[id]/route.ts` — detail endpoint (full transcript text, capture date, source URL)
- `app/api/archive/buckets/route.ts` — the 7-bucket taxonomy counts/people lists
- `app/api/archive/facets/route.ts` — tag facets only
- `lib/archiveBuckets.ts` — hardcoded MD/Bench roster (real archive `people.full_name` values)
- `components/archive/ArchivePanel.tsx` — the Archive UI itself
- `supabase/migrations/0007_archive_consolidation.sql`, `0008_archive_item_tags.sql`, `0009_simple_transcript_search.sql` — schema for this feature (0009 already run by the user)
- `tools/archive_consolidation/` — the whole Python offline pipeline (enrichment passes, `export_to_supabase.py`, the file-copy PowerShell script, person-resolution, dedup, etc.)

## 8. Deployment process (unchanged)

Local commit → push to GitHub (`precinctpaul/basiq-studio-web`, public repo) → SSH to droplet (`root@137.184.99.201`) → `git pull -q && npm run build` → `pm2 restart basiq-web`. Note: `MEDIA_ROOT=/mnt/lucidlink` was added to `/etc/basiq-agent.env` on the droplet this session (was missing entirely, which is why video previews 404'd — separate from `LUCID_MOUNT_PATH`, which is only used for the `/health` check). Don't rediscover this; it's fixed and confirmed live.

## 9. Not part of this work

`git status` currently shows several pre-existing untracked files unrelated to Archive (`components/studio/files.zip`, `copy`, `route.ts` at repo root, various `tools/*.py`/`.xlsx`/`.csv` files). These predate this session's Archive work — leave them alone unless the user raises them specifically.
