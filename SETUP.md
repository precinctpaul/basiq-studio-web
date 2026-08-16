# Basiq Studio Hub — setup

Two parts: the **website** (deployed once, by you) and the **agent** (installed
once, by each person).

---

## Part 1 — Deploy the website (you, ~15 minutes)

The site is stateless. Everything it stores lives in Supabase, so a deploy is
just pointing Vercel at the repo.

### 1. Run the migrations

In the Supabase dashboard → **SQL Editor**, paste and run every file under
`supabase/migrations/`, **in order** (`0001` through the highest-numbered
one). Each is idempotent, so re-running one already applied is harmless.

`0005` and `0006` are required for the shared drive. Without them the
library still works, but RESCAN will report
`column videos.local_path does not exist`.

### 2. Push the repo to GitHub

```bash
cd C:\dev\basiq-studio-web
gh repo create basiq-studio-web --private --source=. --push
```

### 3. Import into Vercel

At [vercel.com/new](https://vercel.com/new), pick the repo. Framework detects
as Next.js — leave every build setting alone.

Add these three environment variables (copy the values from your local
`.env.local`):

| Name | Where to find it |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | same page |
| `SUPABASE_SERVICE_ROLE_KEY` | same page — **secret**, never in the browser |

Deploy. You'll get a URL like `basiq-studio-web.vercel.app`.

> **Why the agent still works over HTTPS.** Browsers treat `127.0.0.1` as a
> trustworthy origin, so an HTTPS page is allowed to call it — this is not
> blocked as mixed content. The agent already sends the
> `Access-Control-Allow-Private-Network` header that Chrome's preflight
> requires.

---

## Part 2 — Install the agent (each person, ~10 minutes)

The agent does the work a website cannot: downloading, live capture,
transcription, tagging, and reading the shared drive.

### Windows

1. Copy the `tools` folder to their machine (or have them clone the repo).
2. Double-click **`Basiq-Setup.bat`**. That's the whole install: it installs
   Python and FFmpeg if missing, builds the agent, downloads the models,
   asks once for the shared drive folder (no file editing), and drops a
   **"Start Basiq Agent"** icon on the Desktop.
3. From then on: double-click that Desktop icon whenever they want to work,
   and open `basiq-studio-web.vercel.app`. Leave the black window open.

Nobody needs to open Notepad or touch a `.bat` file by hand — that manual
`MEDIA_ROOT` edit was the single biggest source of "why isn't this working"
reports, because it's easy to get subtly wrong (e.g. leaving a `REM` comment
marker on the line) with no error to signal it. `Basiq-Setup.bat` also clears
out any agent left running from a previous session before starting a new
one, so a stale process can't silently keep answering the website with an
old folder path.

Running `Basiq-Setup.bat` again later (e.g. to change the shared folder) is
safe — it skips the parts already installed and just re-asks the one
question.

### macOS

1. Copy the `tools` folder to their Mac — the shared drive itself is the
   easiest way, since a Finder-to-Finder copy between two mounted volumes
   keeps the file permissions the installer needs.
2. Double-click **`Basiq-Setup.command`**. The first time, macOS may say it's
   from an unidentified developer — right-click it and choose **Open**
   instead, then confirm. That's the whole install: it installs Homebrew,
   Python and FFmpeg if missing, builds the agent, downloads the models,
   asks once for the shared drive folder (no file editing), and drops a
   **"Start Basiq Agent"** icon on the Desktop.
3. From then on: double-click that Desktop icon whenever they want to work,
   and open `basiq-studio-web.vercel.app`. Leave the Terminal window open.

Nobody needs to open a text editor or touch a `.sh` file by hand — same
reasoning as the Windows installer above. Running `Basiq-Setup.command` again
later (e.g. to change the shared folder) is safe — it skips the parts
already installed and just re-asks the one question.

(`install.sh` / `start-agent.sh` still work as a CLI-only alternative, and
are the only option on Linux.)

### Check it worked

Open the site and press **CHECK AGENT** in the bottom-left. It should read:

```
Agent ready · whisper · yt-dlp · summaries · tags · L:\MajorityDems\Media
```

Then press **RESCAN** to pull the shared drive into the library.

---

## How the shared drive works

**Masters live on LucidLink. Clips live in Supabase.**

That split is deliberate. A hearing is hours long and hundreds of megabytes —
putting those in Supabase would blow through the 1GB free tier almost
immediately, and the team already keeps footage on the shared drive where
their editing tools can reach it. Exported clips are seconds long, and a share
link has to work for someone with no agent and no drive access, so those go to
the bucket.

What this means day to day:

- **GRAB** files the download straight onto the shared drive.
- **RESCAN** indexes the drive, so everyone sees the same library.
- Anything already in that folder appears too — drop files in from anywhere.
- Playback streams from that person's own agent, so it's local-network fast.
- **EXPORT CLIP** encodes on their machine and uploads only the finished clip.
- Transcripts, tags and key moments are shared through Supabase, so if one
  person transcribes something, everyone sees it.

A file that's missing because someone has the volume unmounted is **reported,
never deleted** — losing a transcript because a drive was offline would be
unacceptable.

---

## Costs

| | |
|---|---|
| Vercel | Free (Hobby) is fine for a handful of people |
| Supabase | Free tier is 1GB. With masters on LucidLink, only clips count — a clip is a few MB, so this lasts a long time |
| Models | One-time ~2GB download per machine, then fully offline |

---

## Troubleshooting

**"Local agent not running"** — the `start-agent` window is closed. Reopen it.

**RESCAN says "Shared drive not found"** — `MEDIA_ROOT` points somewhere that
isn't mounted. Check the drive letter; LucidLink can mount differently on
different machines.

**A download failed** — it retries automatically after 1 minute, then 5.
Doing several grabs at once gets rate-limited; that's what the retry is for.
A private or removed video fails immediately, because waiting won't help.

**Key Moments show keywords instead of sentences** — the agent isn't running,
or the models didn't finish downloading. Rerun `install.bat`.
