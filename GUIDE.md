# Using Basiq Studio Hub

A plain-English walkthrough for tomorrow morning: what's already running, what
each page does, and — since it's brand new — a full walkthrough of Codegen.

---

## 1. The one thing to know: the website never needs "starting"

Open **[basiq.51st.media](https://basiq.51st.media)**. It's always live —
hosted on a DigitalOcean droplet, not your laptop. Playback, transcripts,
tags, summaries, clip export, `/videos`, and `/codegen` all work the moment
you open the page. There's no server to start, no terminal to leave open,
nothing to remember.

## 2. The one thing that depends on this PC: new downloads and live capture

**GRAB** (pasting a link to download) and **GO LIVE** (recording a live
stream) are the two exceptions. YouTube blocks the droplet's own internet
connection (it looks like a datacenter, gets flagged as a bot), so those two
jobs get handed off to a small background program — `basiq_worker.py` —
running on this Windows machine, which has a normal home/office connection.

**It's already running and looks after itself.** It's registered as a
Windows Scheduled Task called **"Basiq Worker"** that starts automatically
when you log in and rechecks itself every minute — if it were ever to crash,
it restarts within 60 seconds on its own. You don't need to click anything,
open a terminal, or remember to start it. The only way it stops is if this
PC itself is off, asleep, or logged out.

If a GRAB or GO LIVE job ever sits at "Queued" and never moves: that means
either this PC is off, or (rarely) the task needs a nudge. Open Task
Scheduler, find **"Basiq Worker"**, right-click → **Run**. That's the entire
fix.

Everything else — transcribing, tagging, summarizing, checking whether a
link is live — runs on the droplet itself and never depends on this PC being
on.

## 3. The pages, in plain terms

- **`/` (Studio/Library)** — the main product. Paste a link or upload a file
  to add it to the library, browse everything you've got, play back with the
  transcript scrolling alongside the video, tag things, and cut/export
  shareable clips. Everything else in the app follows this page's look and
  feel.
- **`/videos`** — an audit view for going through the archive systematically:
  filter by whether something has a transcript, who uploaded it, how long it
  is, sort any column, spot anything that looks broken (a missing transcript,
  an unplayable file). Built for going through the library methodically, not
  for day-to-day browsing — that's what `/` is for.
- **`/codegen`** — brand new, see the full walkthrough below.
- **`/share/[token]`** — the public download links your exported clips get.
  Nothing to operate here; it's what you send someone else.

## 4. Codegen — what it is and how to use it

**In one sentence:** you type a plain-English request, and it hands back
either a database query or an email, written by Google's Gemini AI. It never
runs anything on its own — it only ever writes something for you to look at,
copy, and use yourself.

Open `/codegen`. There are two modes, switched with the two buttons at the
top.

### Mode 1 — SQL QUERY

Use this when you want to look something up in the database but don't know
how to write the query yourself. Type your question in plain English, e.g.:

> videos with no transcript, grouped by uploader, ordered by size descending

> hearings from the last 30 days that mention "agriculture" in the transcript

Press **GENERATE** (or `Ctrl/Cmd + Enter`). A few seconds later you get:

- The actual SQL query, ready to copy.
- A one-line explanation of what it does.
- Which tables it touches.

**It only ever writes a read-only lookup — a `SELECT`.** If your request
would require changing data (an `INSERT`, `UPDATE`, `DELETE`, etc.), the tool
refuses and tells you why instead of writing one. Nothing is ever run
against the real database from this page — copying the query is the whole
point. To actually run it, paste it into the Supabase dashboard's **SQL
Editor** (the same place migrations get run) and press run there, on
purpose, once you've read it and it looks right.

If you see a small blue banner under the query, it means the tool couldn't
confirm the SQL parses cleanly — not a sign it's wrong, just a "read this one
a little more carefully before using it" flag.

### Mode 2 — EMAIL HTML

Use this when you need a quick email draft. Type what you want, e.g.:

> a plain email announcing 3 upcoming committee hearings

Press **GENERATE**. You get a subject line and a full email body, shown as a
live preview (exactly how it'd look opened in an email client). Press **VIEW
CODE** to see the raw HTML instead, and **Copy** to grab either one.

**It only ever generates and previews — it never sends anything, to
anyone, ever.** There's no "send" button on this page on purpose. Paste the
copied HTML into whatever you actually send email through.

### Why it's safe to hand to anyone on the team

Both modes are look-then-act by design: nothing Codegen produces executes,
saves, or sends itself. A wrong or nonsensical answer just means you don't
use it — there's no way for a bad prompt here to change anything in the
product or the database.

## 5. If something looks off

- **Bottom-left doesn't say "Agent ready"** — the droplet's own agent is
  temporarily down; it isn't tied to anything on your PC. Give it a minute
  and refresh.
- **A GRAB/GO LIVE job stuck at "Queued"** — see §2 above: this PC's worker
  isn't reachable. Check it's on and logged in; nudge the "Basiq Worker"
  scheduled task if needed.
- **Codegen gives an error about the model being overloaded** — this is
  Google's servers being busy, not a problem with this app; wait a few
  seconds and press GENERATE again.

## 6. Want the deeper technical version?

- [`README.md`](README.md) — project overview, all pages, deploy command.
- [`SETUP.md`](SETUP.md) — installing the local agent from scratch on a new
  machine. Note: its "deploy the website" section still describes an older
  Vercel-based path; production today actually runs on the DigitalOcean
  droplet described in `README.md`'s Deploying section — worth a cleanup
  pass whenever you're touching deploy docs next, so a future reader isn't
  misled.
- [`HANDOFF.md`](HANDOFF.md) — the living log of what's been fixed, what's
  pending, in priority order.
