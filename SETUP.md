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

## Part 2 — Install the agent (each person, ~2 minutes on Windows)

The agent does the work a website cannot: downloading, live capture,
transcription, tagging, and reading the shared drive.

> **The one shared-drive copy lives at `C:\Volumes\md-pac\media\Scripts\`.**
> That is the only place teammates should ever get it from. After building
> a new installer (`tools\build\build_windows.bat`), publish it with
> `scripts\publish-tools-to-shared-drive.bat` — the repo in GitHub is the
> source of truth, the shared-drive copy is just its published output. Run
> it again after any change to `basiq_agent.py`.

### Windows

1. Copy `Basiq-Agent-Setup.exe` from `C:\Volumes\md-pac\media\Scripts` to
   their machine and double-click it. There is nothing to extract — it's a
   normal Windows installer.
2. It asks one question (where's the shared drive — pre-filled with a
   sensible default), installs to `%LocalAppData%\BasiqAgent` (no admin
   needed), drops a **"Start Basiq Agent"** icon on the Desktop, and offers
   to start the agent right there.
3. From then on: double-click that Desktop icon whenever they want to work,
   and open `basiq-studio-web.vercel.app`. Leave the black window open.

Python, pip, and every model-serving library the agent needs are already
inside the installer — nobody installs Python, builds a venv, or has to
remember to tick "Add python.exe to PATH". Re-running the installer later
(e.g. to change the shared folder, or to pick up a new build) is safe: it
reuses the answer from last time as the default and reinstalls in place.

FFmpeg is the one thing still not bundled — the installer checks for it on
PATH and tells you to run `winget install --id Gyan.FFmpeg -e` if it's
missing. Live capture and clip export need it; everything else works
without it. (Bundling FFmpeg too is tracked as follow-up work.)

See [`tools/build/README.md`](tools/build/README.md) for how the installer
itself is built.

### macOS

**No compiled installer yet** — `tools/build/basiq_agent_macos.spec` and
`build_macos.sh` exist but need someone with an actual Mac to build and fix
up the first working `.app`/`.dmg` (PyInstaller can't cross-compile from
Windows, so this repo's Windows build couldn't produce or test one). Until
then, macOS still uses the source install:

1. Copy the `tools` folder from `C:\Volumes\md-pac\media\Scripts` (shows as
   `/Volumes/md-pac/media/Scripts` in Finder) to their Mac.
2. Double-click **`Basiq-Setup.command`** inside it. The first time, macOS
   may say it's from an unidentified developer — right-click it and choose
   **Open** instead, then confirm. That's the whole install: it installs
   Homebrew, Python and FFmpeg if missing, builds the agent, downloads the
   models, asks once for the shared drive folder, and drops a **"Start Basiq
   Agent"** icon on the Desktop.
3. From then on: double-click that Desktop icon whenever they want to work,
   and open `basiq-studio-web.vercel.app`. Leave the Terminal window open.

Running `Basiq-Setup.command` again later (e.g. to change the shared folder)
is safe — it skips the parts already installed and just re-asks the one
question.

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
or the models didn't finish downloading. On Windows, re-run
`Basiq-Agent-Setup.exe`; on macOS, re-run `Basiq-Setup.command` (or
`install.sh` from a CLI checkout).
