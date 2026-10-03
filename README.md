# Basiq Studio Hub

Grab, cut, transcribe, and clip video — a Next.js app for pulling in live streams
and uploads, transcribing them, and cutting shareable clips.

Live at **[basiq.51st.media](https://basiq.51st.media)**.

## Pages

- **`/`** — Studio (Library). The main product: grab/upload video, browse the
  library, play back with a synced transcript, tag, and cut clips. Every other
  page follows this one's UI conventions. A **CLIP MODE** toggle in the header
  switches to a minimal capture → clip → export view (no library browsing,
  transcript panel, or tag UI) for fast, low-overhead clipping — grabs made in
  either mode still transcribe and tag automatically in the background and
  land in the same shared archive.
  Clip exports can burn in subtitles; see [Burned-in subtitles](#burned-in-subtitles).
- **`/videos`** — an audit/QA view over the archive dataset for the
  digital-archivalist workflow (filter by transcript status, source, etc.).
- **`/codegen`** — a small internal tool that turns a plain-English request
  into either a read-only PostgreSQL query (against this project's schema) or
  a self-contained HTML email preview, via Gemini. See
  [`app/codegen/page.tsx`](app/codegen/page.tsx) and
  [`app/api/codegen/route.ts`](app/api/codegen/route.ts) — nothing it
  generates is ever executed against the database or sent anywhere; it's
  generate-and-copy only. Requires `GEMINI_API_KEY` in `.env.local`.
- **`/share/[token]`** — public clip-download links generated from the
  Studio's EXPORT CLIP flow.

The **Archive** feature (a separate historical dataset/UI, `/archive`) has
been parked, not deleted — see [`_parked/archive-feature`](_parked/archive-feature).

## Burned-in subtitles

A **SUBS ON/OFF** toggle next to EXPORT CLIP burns the transcript into the
exported clip.

- **Look.** Recoleta Bold in acid green (`#E7EB94`) on a `#111111` box.
  Landscape uses the burned_in_subs side project's look. 9:16 uses shorter
  lines (about 24 characters), with the text raised about 25% from the bottom
  to clear TikTok, Reels and Shorts overlays. Sizes are set on a
  288-high ASS canvas, so they scale with any output resolution.
- **Defaults.** OFF on every page load, and greyed out until the video has a
  finished transcript.
- **Live preview.** While SUBS is ON, the Precision Player draws the
  subtitles inside the export frame: the whole picture for 16:9, the crop
  box for 9:16 Crop, or a true 9:16 frame for 9:16 Blur. It uses the same
  code as the export. CC captions hide while the preview shows.
- **How lines are built.** Subtitles are rebuilt from the words, not from
  transcript segment boundaries, which Whisper cuts by duration rather than
  grammar. A new subtitle starts at a sentence end, at a `>>` speaker change
  (the marker stays on screen), after a pause of 0.75s or more, or when two
  lines are full (never more than two lines). Line breaks avoid leaving the
  last word or two of a sentence alone. Initials and titles ("Donald J.",
  "Sen.") don't end a sentence. Short subtitles hold for 1s where there's
  silence, and subtitles never overlap.
- **SUBTITLES tab (hand fixes).** Shown while SUBS is ON. It lists the
  transcript lines between IN and OUT. You can add a period, fix a word,
  or type `>>`. The preview updates live, and edits save automatically
  (about 0.6s after typing stops, on blur, or on Enter), with per-line
  status and RESET. Edits are stored per video in `subtitle_edits`
  (migration `0015`). They are keyed to the exact transcript version and
  line, so a re-transcription quietly retires them.
- **HTML codes.** Imported YouTube captions store `>>` as `&gt;&gt;`. These
  are decoded for display, in subtitles and in the TRANSCRIPT tab. The stored
  text is left as-is.
- **Transcripts are only ever read.** [`lib/burn-subs.ts`](lib/burn-subs.ts)
  builds a one-off `.ass` file in memory for each export, and
  [`lib/subtitle-edits.ts`](lib/subtitle-edits.ts) overlays hand fixes on a
  copy. Nothing writes to `transcripts` or `transcript_segments`. Search,
  graphics and the member command center depend on them.
- **Rendering.** The web route builds the args plus the `.ass` text. The
  agent writes `subs.ass` and copies `fonts/` into its export temp dir, then
  runs ffmpeg from there. It needs an ffmpeg built with libass; the agent
  checks first and fails with a clear message if it's missing. The font is
  `tools/fonts/Recoleta Bold.otf`, bundled into the installer by both
  PyInstaller specs. Every character burned in must exist in Recoleta,
  because the droplet has no fallback fonts and missing glyphs draw as
  boxes. That's why line padding is a transparent "n", not non-breaking
  spaces.
- **Database.** Migration `0014` adds `clips.burn_subtitles`, written only
  when ON. Migration `0015` adds `subtitle_edits`. Both are already run in
  production.
- **Tests.** [`tests/burn-subs.test.mjs`](tests/burn-subs.test.mjs) and
  [`tests/subtitle-edits.test.mjs`](tests/subtitle-edits.test.mjs). With
  SUBS OFF, the export argv is checked to be byte-identical to before.

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Copy `.env.example` to
`.env.local` and fill in Supabase + (if using `/codegen`) `GEMINI_API_KEY`.

Video capture/transcription/tagging is handled by a separate local Python
agent (`tools/basiq_agent.py`) that the web app talks to over HTTP — see
[SETUP.md](SETUP.md) for installing and running it.

## Deploying

Self-hosted on a DigitalOcean droplet behind Caddy, running under `pm2` as
`basiq-web`:

```bash
ssh root@137.184.99.201 "cd /var/www/basiq-studio-web && git pull origin master && npm run build && pm2 restart ecosystem.config.js --update-env && pm2 logs"
```

Changes to `tools/basiq_agent.py` (or anything else the agent loads, like
`tools/fonts/`) also need the agent restarted, since it runs under systemd and
not pm2:

```bash
ssh root@137.184.99.201 "systemctl restart basiq-agent"
```

Teammates' installed agents only pick up agent changes when the installer is
rebuilt (`tools/build/`).

## Other docs

- [GUIDE.md](GUIDE.md) — how to actually use the finished product day to day, including a full walkthrough of `/codegen`. Start here if you just want to use the site.
- [SETUP.md](SETUP.md) — deploying the website and installing the local agent, for a non-technical operator.
- [HANDOFF.md](HANDOFF.md) — living session notes: what's done, what's pending, in priority order. Read this first when picking up work.
- [NEXT_TASKS.md](NEXT_TASKS.md) — longer-term installer/agent hardening follow-ups.
