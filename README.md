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
