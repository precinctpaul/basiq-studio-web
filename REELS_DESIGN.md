# Reels — design notes (in progress, not fully built)

Building on `feature/reels-timeline`, behind a flag once one exists (same
pattern as `LIVE_CAPTURE_ENABLED` in `tools/basiq_agent.py`); master stays
exactly as deployed today. Rollback point if anything goes sideways:
`git checkout the-version-2026-09-28`.

## Progress

- [x] DB schema — `supabase/migrations/0016_reels.sql`,
      `0017_reels_local_path.sql`. Applied to the live database.
- [x] API routes — `app/api/reels/route.ts` (list/create),
      `app/api/reels/[id]/route.ts` (get-with-segments/rename/delete),
      `app/api/reels/[id]/segments/route.ts` (append/reorder),
      `app/api/reels/[id]/segments/[segmentId]/route.ts` (trim/delete).
      Verified with a live round-trip against the real database (create,
      list, get, reorder, trim, delete, rename, plus the guard rails:
      cross-reel tamper attempts 404, invalid in/out 400s, `status`/
      `progress` aren't client-editable) — test data cleaned up after.
- [x] Frontend: flag (`lib/feature-flags.ts`, `REELS_ENABLED`, off by
      default), the bottom drawer (`components/studio/ReelPanel.tsx`, same
      collapse pattern as QueuePanel), the reel switcher (+ NEW REEL, pick
      an existing one), ADD TO REEL next to the IN/OUT marks in
      PlayerPanel, remove-segment, and drag-to-reorder in the strip
      (pointer-capture on a grip, same mechanism as Splitter.tsx —
      midpoint-based hit-testing since this is reorder-by-index rather
      than Splitter's resize-by-delta). Verified live with the flag
      flipped on locally: created a reel, loaded a real video, added a
      real segment, saw it render with the right title/duration/aspect,
      removed it, dragged a 3-segment reel's first block past the others
      and confirmed the server order actually changed ([4,5,6] -> [5,6,4]),
      and confirmed the flag-off path renders nothing and makes zero
      /api/reels calls. Flag confirmed back off before committing.
- [x] Export job. TS side: `lib/export-reel.ts` (`buildReelSegmentArgs`,
      deliberately NOT sharing code with `lib/export-clip.ts`'s
      `buildClipArgs` -- see that file's own docstring for why) and
      `lib/ffmpeg-filters.ts`'s new `buildReelSegmentVideoChain` (same
      three modes as `buildVideoChain`, parameterized by the reel's fixed
      canvas instead of `settings.verticalWidth`; "native" means
      letterbox/pillarbox here, not "keep the source's own resolution" --
      there's no single source once a reel mixes videos). New routes:
      `POST /api/reels/[id]/export` (plans every segment's ffmpeg args,
      validates each source has video/is ready/has a local_path, flips
      status to "queued" -- the one place that field is server-settable
      outside `/complete`) and `POST /api/reels/[id]/complete` (mirrors
      `/api/clips/[id]/complete`: records where the agent's output landed,
      mints a share token). `0018_reels_duration.sql` adds
      `reels.duration_seconds` for parity with `clips.duration_seconds` --
      **not yet run against the live database, unlike 0016/0017**.
      `app/share/[token]/page.tsx` and
      `app/api/share/[token]/download/route.ts` both widened to resolve a
      token to either a clip or a reel (`share_tokens_one_target`) -- a
      rendered reel is shareable exactly like a clip, and leaving those
      routes clip-only would have meant every reel's minted share link was
      a dead 404.

      Agent side (`tools/basiq_agent.py`): three new, INDEPENDENT
      functions (`_run_ffmpeg_reel_step`, `run_reel_segment`,
      `run_reel_concat`) plus two new HTTP routes (`/reel/segment`,
      `/reel/concat`) and `lib/agent.ts`'s `agentReelSegment`/
      `agentReelConcat`. Deliberately not a refactor of the existing
      `run_export` (which stays byte-for-byte untouched) even though the
      ffmpeg-progress-parsing loop is duplicated almost verbatim -- see
      `_run_ffmpeg_reel_step`'s own docstring. Shares `run_export`'s own
      `_export_semaphore` so a reel export counts against the same
      concurrent-ffmpeg-encodes cap as normal clip exports, on purpose
      (the standing rule: nothing new competes with the core clipping
      pipeline for droplet CPU). Page.tsx's `exportReel()` orchestrates: N
      "cut+fit" agent calls (one per segment, one Queue row each, reusing
      `waitForJobResult`) then one "join" call, then `/complete` -- stops
      on the first failure, same as `doExport`.

      **What was and wasn't verified, and how:**
      - The actual ffmpeg filter graphs were verified for real, not just
        read -- generated real args via `buildReelSegmentArgs` for all
        three aspect modes plus a no-audio source, ran them against real
        synthetic test videos (different resolutions, a 16:9 source and a
        9:16 source) with real local ffmpeg, then ran the exact concat
        approach `run_reel_concat` uses. Confirmed via `ffprobe` that
        every normalized segment AND the final concatenated file landed
        at exactly the target canvas (1080x1920), 30fps, aac audio
        (including the no-audio source, which correctly got a generated
        silent track) -- and visually confirmed via an extracted frame
        that "native" mode actually letterboxes (black bars, source
        centered) rather than just having the right dimensions with wrong
        content. Total duration matched the sum of segment durations.
      - `POST /api/reels/[id]/export` was verified live against the real
        database: correct args/localPath/durationSeconds per segment,
        reel status flips to "queued", rejects an empty reel (400) and a
        missing reel (404).
      - The frontend's failure path was verified live (flag on, no real
        agent reachable in this environment): EXPORT REEL correctly
        disables/re-enables through a real planning-call-then-agent-call
        sequence, surfaces the agent's own "can't reach" error in the
        status bar, and leaves the reel at "queued" rather than some
        broken state.
      - **NOT verified, because this environment has no reachable local
        agent and no LucidLink-mounted shared drive: `run_reel_segment`/
        `run_reel_concat` were never actually executed by a real running
        agent process** -- syntax-checked (`python -m py_compile`) and
        import-checked (loads cleanly, all three new functions present),
        but not exercised end-to-end through the actual HTTP server. The
        one real test this needs before it's trusted: pick a small reel
        (2-3 short segments) and click EXPORT REEL for real, against a
        real agent, with the flag on.
      - `0018_reels_duration.sql` has been run against the live database.
        All three reel migrations (0016/0017/0018) are applied. The only
        thing left before this is trusted is the real test above: a real
        agent, flag on, a small reel, EXPORT REEL.

## What this is

A drag-and-drop timeline: mark IN/OUT on a video the same way you already do
today, but instead of exporting immediately, add that range to a reel — an
ordered sequence of picks, possibly from several different source videos —
then export the whole sequence as one concatenated output file.

## Product decisions already made

- **Cross-video reels.** A reel can mix clips from any videos in the library,
  not just multiple cuts of one currently-open video. This is the actual
  "highlight reel" use case; it's also what makes the export job non-trivial
  (see below).
- **One fixed output canvas per reel.** You choose the reel's output
  dimensions once (e.g. 1080×1920 for 9:16); every segment gets fit into that
  canvas regardless of its own source shape. Mixed 16:9/9:16 source clips can
  coexist in the same reel — this reuses the *existing* per-clip
  `aspect_mode`/crop machinery (`native` / `vertical_crop` / `vertical_blur`,
  see `clips` table in `supabase/migrations/0001_initial_schema.sql`) applied
  per segment, not new video math.
- **Saved projects, kept lean.** Reels persist across sessions (new DB rows),
  but a reel is *metadata only* until you export it — an ordered list of
  `(video_id, in, out, aspect settings)` pointers, no intermediate render
  files, no duplicated storage. The only real cost is the final render job.
- **Hard cuts only for v1.** No per-segment fades/transitions between
  internal cut points. A fade-in on the first segment / fade-out on the last
  can reuse `clips`' existing `fade_in`/`fade_out` idea later, at the
  reel level — not scoped now.
- **UI lives as a bottom drawer, not a new mode.** Same collapse/expand
  pattern already shipped for the Queue panel (collapsed by default, caret to
  open/close, sits at the bottom, out of the way until needed). Available
  from both normal Library view and Clip Mode — an "ADD TO REEL" button sits
  next to the existing `[` / `]` IN/OUT mark buttons regardless of which view
  you're in. Not a replacement for the single-clip PRECISION PLAYER/EXPORT
  CLIP flow, which is untouched.

## Data model (sketch)

Generalizes the existing `clips` table (one segment) to N ordered segments
feeding one render job. Two new tables, one small additive widening of an
existing one:

**`reels`** — the project itself, one row per reel.
- `id`, `title`
- `canvas_width`, `canvas_height` — fixed output pixel size for the whole
  reel (not an aspect *enum* like `clips.aspect_mode` — the canvas needs one
  concrete size regardless of any segment's own source shape)
- `status` / `progress` / `error` / `storage_path` / `size_bytes` — same
  render-lifecycle bookkeeping as `clips`, because the rendered reel is a
  deliverable file just like a clip is
- `created_at`, `updated_at`

**`reel_segments`** — the ordered picks.
- `id`, `reel_id` → `reels` (cascade), `position` (unique per `reel_id` —
  the drag-to-reorder field)
- `video_id` → `videos`, **`on delete restrict`** (see below) — points at
  the raw source video, not at a `clips` row. A segment is cut directly from
  the source at render time; pointing at `clips` instead would force every
  timeline entry through a full standalone export first, for no benefit.
- `in_point`, `out_point`
- `aspect_mode` (`native` / `vertical_crop` / `vertical_blur`) +
  `crop_offset_x` / `crop_offset_y` — identical meaning to the same fields on
  `clips`, answering "how does *this* segment fit the reel's canvas"

**`share_tokens`** (existing table, widened) — make `clip_id` nullable, add
nullable `reel_id`, check exactly one of the two is set. Reuses the existing
token/download-count/revoke machinery for reels instead of duplicating it;
no behavior change for clip-only tokens that already exist.

### Delete-blocked UX requirement (important — don't lose this)

`reel_segments.video_id` is `on delete restrict`: deleting a source video
that's used in a saved reel must fail rather than silently shrinking the
reel. **As of this writing there is no "delete a video" feature in the web
app at all** (no API route for it) — so this is a requirement for whenever
that feature gets built, not a fix to something existing:

- The lookup ("which reels use this video") is one indexed join via an index
  on `reel_segments(video_id)` — cheap, not a scan.
- The delete-video endpoint must run that lookup *first* and return a
  structured "blocked, here's why" response — naming each reel by title and
  which position in its timeline — rather than letting a raw Postgres
  FK-violation error leak to the user.
- The fix-it action is just "remove this segment from that reel" — a
  primitive needed anyway for normal timeline editing. The blocked-delete
  screen surfaces that same action per offending reel, plus a "remove from
  all N reels" convenience button, then retries the original delete.

## Export job shape (decided)

Normalize each segment separately (cut + fit to the reel's canvas, one
ffmpeg process at a time, writing a small temp file per segment), then join
those temp files with ffmpeg's concat demuxer — a free re-mux, no
re-encoding — rather than one big multi-input filter-graph command decoding
everything at once. Chosen over the single-command approach because:

- "Normalize one segment" is the exact same work the agent already does for
  a single-clip export today — same code path, reused, not new logic.
- Runs sequentially, one ffmpeg process at a time — never more decoders/
  encoders running simultaneously than today's single-clip export does,
  which matters on the single-vCPU droplet (the standing rule there is:
  nothing new competes with the core clipping pipeline).
- Segment-level failure isolation — if segment 4 of 9 fails, that's the one
  you know about and can retry, not one giant filter graph to debug.
- Maps directly onto the Queue panel's existing per-task-row UI ("Normalizing
  segment 3/9," then "Concatenating" as the last row) instead of one opaque
  spinner — reuses UI already shipped this session instead of inventing new
  progress plumbing.
- A source with no audio track gets silence inserted for that segment's
  duration during normalization, so every intermediate file has a matching
  audio stream and concat doesn't choke on a stream-count mismatch.
- Temp normalized files are deleted once the final concat succeeds — no
  lasting storage cost, only during the render itself.

So a reel export = N "cut+fit" queue tasks (one per segment, reusing today's
export logic) → 1 cheap "join" task → done.

## Frontend / UI shape (decided)

- **Drawer layout.** Open, it's a horizontal strip of ordered segment
  blocks — source title, duration, in/out timecodes, a remove (×), a drag
  handle. No thumbnails in v1 (real ffmpeg frame-extraction work, not worth
  it yet) — colored block + text. Reordering uses the same pointer-capture
  drag pattern the `Splitter` component already uses elsewhere in this app,
  not the native HTML5 drag-and-drop API.
- **Persistent active reel.** ADD TO REEL always appends to whichever reel
  is currently selected in the drawer's header switcher ("Current reel:
  [Campaign Highlights ▾]" + "+ New Reel"), from anywhere (normal view or
  Clip Mode) — it never re-prompts "which reel?" on each add. Chosen for
  speed over safety: building a reel across a sitting should be
  low-friction, not a confirmation dialog per clip.
- **State/data shape.** Page-level state in `page.tsx`, same pattern as
  `tasks` (Queue) or `tags` already use — plain `useState` + callback props,
  no new state library. Switching the active reel fetches its segment list;
  add/remove/reorder are optimistic local updates, fire-and-forget PATCHed
  to persist — same lightweight style already used for bucket/tag edits.
- **Export controls.** A title field, the canvas-size picker (16:9/9:16,
  same select styling as today's aspect-mode dropdown), and an EXPORT REEL
  button that kicks off the job described above.

## Open / not yet scoped

Nothing major left at the design-conversation level. Remaining work before
this is buildable is implementation detail, not product decisions: exact API
route shapes, the feature-flag name/mechanism, migration file naming. Pick
those up when it's time to actually start building — still on a branch,
still behind a flag, master untouched until it's proven.
