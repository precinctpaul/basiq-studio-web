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
  A **SUBS ON/OFF** toggle next to EXPORT CLIP burns the transcript into the
  exported clip as subtitles (Recoleta Bold, acid green on a dark box; larger,
  raised text for 9:16). It is OFF on every page load and greyed out until the
  video has a finished transcript. While it's ON, the Precision Player shows a
  live preview of the subtitles inside the export frame (16:9, the 9:16 crop
  box, or the 9:16 blur frame), built by the same code that burns them in;
  CC captions hide while it shows. Subtitles are regrouped from the words
  themselves, broadcast-style. A new subtitle starts at a sentence end, at a
  `>>` speaker change (kept on screen), or after a pause, with at most two
  lines. A **SUBTITLES** tab (shown while SUBS is ON) lists the transcript
  lines between IN and OUT for hand fixes, such as a missing period, a
  misheard word, or an added `>>`. Fixes update the preview live and save
  automatically per video in `subtitle_edits` (migration `0015`). HTML codes
  in imported captions (`&gt;&gt;`) are decoded for display. They are keyed to
  the exact transcript version, so a re-transcription quietly retires them.
  The transcript itself is never edited. Transcripts are only **read** for this:
  [`lib/burn-subs.ts`](lib/burn-subs.ts) builds a one-off `.ass` file in
  memory per export, and nothing writes back to transcripts or segments. The
  agent needs an ffmpeg built with libass, and the font in `tools/fonts/`
  (bundled into the installer by the PyInstaller specs). Run
  `supabase/migrations/0014_clip_burn_subtitles.sql` to record which clips
  had subtitles. Exports with subtitles OFF work without it.
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

## Other docs

- [GUIDE.md](GUIDE.md) — how to actually use the finished product day to day, including a full walkthrough of `/codegen`. Start here if you just want to use the site.
- [SETUP.md](SETUP.md) — deploying the website and installing the local agent, for a non-technical operator.
- [HANDOFF.md](HANDOFF.md) — living session notes: what's done, what's pending, in priority order. Read this first when picking up work.
- [NEXT_TASKS.md](NEXT_TASKS.md) — longer-term installer/agent hardening follow-ups.
