## Living status — keep this section current (last updated 2026-09-12 morning)

This is the actively-maintained section of this file. Update it as things change; don't let it go stale like the 2026-08-28 dump below did. Everything below the next `---` is historical (Archive-consolidation handoff, superseded — see its own note).

### 2026-09-12 morning — real root cause found for "stuck waiting to sync" grabs: LucidLink itself wasn't running, and a new hourly pipeline doctor now watches for exactly this

**What was actually happening:** two real grabs (Instagram reels) both sat on "Waiting for file to finish syncing to the shared drive…" indefinitely, with the droplet 404ing on `/agent/media/<id>.mp4` every few seconds. Confirmed the real cause directly on the worker machine (`CommandCenter`), not guessed: **LucidLink itself was not running** (`Lucid.exe status` → "Lucid is currently not running") **and was not installed as a Windows service** (`Lucid.exe service --status` → "not installed as a service") — it only ever ran as the interactive tray app, so once it was closed/crashed, nothing was left to bring it back. `basiq_worker.py` kept writing finished downloads straight into what used to be the LucidLink mount folder (`C:\Volumes\md-pac\media\Archive\Basiq-Studio-Hub`), which without LucidLink attached is just an ordinary local folder — the grabs succeeded locally, Supabase got a real `status: "ready"` row for each, and the files simply never left this machine. None of the three existing self-healing layers (`worker_tray.py`'s heartbeat, Task Scheduler restarting the tray, the droplet's `systemd Restart=on-failure`) could have caught this — all three only ever watch processes this project itself starts; LucidLink is a separate application none of them supervise.

**Fixed for today:** relaunched LucidLink (`Start-Process LucidLink.exe`) — it reconnected on its own using its saved session, no login needed (`Client state: Linked`, filespace `media.md-pac` remounted at `C:\Volumes\md-pac\media`). The two already-"ready" videos did NOT survive the remount, though — LucidLink's mount took over the folder rather than adopting what was already sitting in it, so both files became unreachable (confirmed: `/agent/media/<id>.mp4` still 404'd, and the files were gone from the mount even locally). Fixed by re-grabbing both original URLs (both Instagram reels) fresh — this time landing correctly and confirmed reachable (`200`, first try) — and deleting the two dead `videos` rows (`42e2dd2314b546878805a14d8e9d145a`, `f77958f64a8e4b948ef0ca685bf54010`; no tags/transcripts existed yet on either, so nothing else needed cleaning up).

**New: `tools/pipeline_doctor.py`**, run once an hour forever by a new Windows Scheduled Task ("Basiq Pipeline Doctor", registered and verified firing on schedule — originally every 15 minutes, changed to hourly per the user's follow-up ask) — this is the check the user explicitly asked for after this incident ("it needs to check if it's running... if it's not, shut the system down, clean itself up, and turn it back on"). Each run checks, and heals what it safely can:
1. **LucidLink** — running, filespace actually mounted? If it's installed as a service but stopped, starts it. If it isn't installed as a service at all (today's actual state), this can't be healed unattended — logged loudly instead of silently retried every hour forever, since starting a brand-new session might need a real login this script has no way to complete.
2. **The worker/tray process stack** — heartbeat freshness, a coarser 10-minute backstop behind `worker_tray.py`'s own 90-second one. If stale, does the literal "shut down, clean up, turn back on": kills the tray's whole process tree, clears `worker.lock`/`worker_heartbeat.txt`/`worker_tray.lock`, relaunches the tray fresh.
3. **The "Basiq Worker" Scheduled Task itself** — re-enables it if it's gone Disabled (confirmed this happened silently once before, 2026-09-11).
4. **The cloud agent** — a read-only `GET /agent/health` (never a grab site, per the standing YouTube-testing rule).
5. **Free disk space** at `MEDIA_ROOT`.

Logs to `tools/pipeline_doctor.log`. Verified live: a real manual `schtasks /run` triggered it successfully end-to-end against the actual running worker without disturbing it (heartbeat was fresh, so nothing got killed); separately unit-tested the kill+cleanup+relaunch path in isolation against throwaway dummy processes (confirmed it kills the stale process, clears all three lock files, and relaunches) without ever touching the real running worker to do so.

**LucidLink is now installed as a Windows service** — the user ran, from an elevated Command Prompt (installing/modifying a Windows service is a system-settings change, deliberately left to the user rather than done automatically):
```
"C:\Program Files\LucidLink\bin\Lucid.exe" service --install
"C:\Program Files\LucidLink\bin\Lucid.exe" service --start
```
Confirmed working: `Lucid.exe service --status` → "LucidLink is running as a service."

**One nuance found right after, not yet closed out:** `Lucid.exe list` shows *two* daemon instances now — instance `2000` (the GUI/"application"-mode one, already linked and live, from the `Start-Process LucidLink.exe` fix above) and instance `1` (the new service-mode daemon) sitting **unlinked**. The LucidLink GUI dashboard only shows instance 2000's linked state, which reads as "everything's fine" but isn't the whole picture — the service (the part that's actually supposed to survive a reboot/logoff with nobody there) has nothing linked yet. Needs, one time:
```
"C:\Program Files\LucidLink\bin\Lucid.exe" --instance 1 link --fs media.md-pac --mount-point C:\Volumes\md-pac\media
```
run **after** fully closing the GUI app first (so its instance 2000 releases the mount point before the service instance claims it) — will prompt for the normal LucidLink login interactively. Once that's done, the service instance persists the link across reboots on its own and the doctor's LucidLink check gains the ability to actually restart it unattended (right now it can `service --start` a stopped service, but that alone doesn't help until the service side has its own link).

### 2026-09-11 night — worker made resilient to network blips, yt-dlp bumped to nightly, and the worker turned into an invisible always-on tray app instead of a console window

1. **Worker poll GET now retries transient network/TLS failures** (`basiq_worker.py`) — a dropped/slow TLS handshake to the cloud agent (confirmed live: `_ssl.c:1064: The handshake operation timed out`) already couldn't crash the worker (`main()`'s loop catches every exception and keeps going), but with no retry inside one cycle it both printed an alarming error and burned a full `POLL_SECONDS` doing nothing. `_get_with_retry()` retries the polling GET up to 3 times, 2s apart, before giving up — a real HTTP response (e.g. a 409 on claim) is never retried, only genuine network-layer failures.
2. **yt-dlp bumped to the latest nightly** (`2026.8.19` stable → `2026.8.30.232658.dev0` via `pip install --pre --upgrade yt-dlp`) in the same venv the live worker runs from, chasing a reported TikTok "audio downloads, no video" issue. Not confirmed fixed — no automated test was run against TikTok (same posture as YouTube: only a real, human-initiated grab verifies this), and it's possible the original video was a slideshow post (images + audio, no real video stream) rather than a fixable extractor bug at all.
3. **The worker is now a tray icon, not a console window you have to leave open.** New `tools/worker_tray.py`: a supervisor with no console (`pythonw.exe`) that spawns and watches exactly one `basiq_worker.py` child, relaunching it if it exits for any reason, or if it's alive but its heartbeat has gone stale (hung, not actually iterating) — the same distinction `basiq_worker.py`'s own singleton lock already draws for a second *launch* arriving mid-hang, now applied continuously. Tray icon color is at-a-glance status (green running / amber starting / red down-and-restarting); right-click for a manual restart and the log (`worker_tray.log` — there's no console anymore, so this is the only place output goes). Has its own singleton lock (`worker_tray.lock`) so a stray second launch can't spawn a duplicate icon. New `tools/requirements-tray.txt` (`pystray`, `Pillow`) is worker-machine-only, kept out of `requirements.txt` on purpose so the droplet's `pip install -r requirements.txt` never pulls in a GUI toolkit it can't use. `tools/start-tray.bat` is the manual double-click entry point (installs the tray deps on first run); `start-worker.bat` still exists for watching raw console output directly when debugging.
4. **`tools/build/deploy/basiq-worker-task.xml` updated** to launch the tray (`pythonw.exe worker_tray.py`, `Hidden=true`) instead of `start-worker.bat` at logon, and re-imported on CommandCenter. Discovered while doing this: the previously-imported "Basiq Worker" scheduled task had gotten **disabled** at some point (last run 9/9, `Status: Disabled`) — the actual Task-Scheduler-level safety net had not been protecting anything for at least two days; all uptime since then was from manual `start-worker.bat` double-clicks. Re-importing needs an elevated prompt (`schtasks /create ... /f` failed with Access Denied from a non-elevated session) — **the user needs to run the three `schtasks` commands in SETUP.md's Step 10 themselves from an elevated Command Prompt** to make the tray survive a reboot/logoff; until then, it's running (verified: singleton lock holds, heartbeat fresh, a deliberate second-launch attempt correctly no-opped) but only for the current logged-in session.

**Verified live** (no YouTube/TikTok grabs run, per standing instruction — this only exercises supervisor mechanics against the real idle-polling worker, not any platform): worker poll-retry code compiles and was restarted+confirmed healthy before this round of changes; the tray was launched for real multiple times while iterating, confirmed exactly one logical tray+worker pair running (Windows' venv launcher stubs make `tasklist` show 2 PIDs per logical process — stub + real interpreter — which looked like duplicates at first but isn't one), heartbeat updating every few seconds, and a second tray launch attempt exiting immediately (code 0) without disturbing the running instance.

**Not yet done**: the elevated `schtasks` re-import (see #4) — flagged to the user as the one remaining step for full weekend-proof always-on coverage.

### 2026-09-11 evening — Recently Downloaded rebuilt as a real folder, person-level manual bucket assignment, a universal DOWNLOAD link, one-time Uncategorized reclassification, UI cleanup

Direct follow-up to this morning's session (below), acting on real usage feedback once actually live:

1. **"Recently Downloaded" is now its own folder**, not a fixed-length list bolted onto the sidebar — it sits above Majority Democrats in the root folder view, opens like any other bucket, and paginates via the same infinite-scroll `rows`/`onLoadMore` the rest of the sidebar already uses. The SHOW 25/CLEAR buttons and the inline per-row bucket dropdown are gone — reported as "basically broken" (visually overlapping/spilling into the folder list) and "too big, too prevalent, too bright" respectively.
2. **Manual bucket assignment now goes down to a specific person, with type-ahead**, and lives ONLY in the Details panel (removed entirely from Recently Downloaded, per explicit ask — "that is a MUCH better spot for it"). `POST /api/videos/[id]/bucket` accepts an optional `person` (a roster display name); the person's bucket is derived server-side from `lib/rosterData.json`, never trusted from the client, so the two can never disagree. The combobox (`DetailsPanel.tsx`) shows the 7 bare buckets by default and switches to a filtered roster-people list (capped at 40) once you start typing.
3. **A universal DOWNLOAD link** (`DetailsPanel.tsx`, using `agentMediaUrl(..., {download:true})`) — the actual fix for "how do people get the file onto their own computer to repost/edit," since COPY PATH/OPEN FILE LOCATION only ever worked for someone running a local agent. This one's a plain HTTPS file transfer through the browser, so it works identically whether the browser's agent is local or the shared cloud one.
4. **Removed "Filter this list…" entirely** (per explicit ask — "I don't know what it does, it's just confusing") and its person/uncategorized-level scoped-search behavior, which was redundant with the always-visible global search box (already scopes itself to the current folder). Also fixed the "All Issues" button showing two overlapping dropdown arrows — `.select`'s own CSS already draws one via `background-image`; the button was also appending a literal "▾" character on top of it.
5. **Fixed a real precision bug in `lib/bucketClassifier.ts`'s transcript-fallback pass** (added just this morning): a video's NER-derived `people` tags were matched using the full strict/alias/**surname-fallback** pipeline, and surname fallback is far riskier against free-text transcript output than against a curated field like a channel handle — confirmed live, re-running the improved classifier against the whole Uncategorized backlog: a mis-transcribed "Richard John Neuhaus" surname-matched Rep. Dan Newhouse, and a Jon Meacham book club mentioning "James Madison" surname-matched Rep. John James. Surname fallback is now skipped for the peopleTags stage specifically (strict + alias only) — uploader/channel/title matching is unaffected.
6. **One-time reclassification of the Uncategorized backlog**, using the now-corrected classifier: scanned all 3,537 Uncategorized videos, found 143 newly classifiable, manually excluded 5 more by eye that were still real people mentioned in passing rather than the video's actual subject (a Denzel Washington commentary piece and two Obama clips misattributed to Trump, a debt explainer, a primary-night speech), and applied the remaining 138. Script was a temporary `tools/_reclassify_uncategorized.ts`, deleted after running — not committed. Real remaining risk worth knowing about: "Notable Figures"/Trump absorbed most of the 138, and a passing mention in an otherwise-unrelated video can still outrank a real but untracked subject (e.g. Kash Patel, JD Vance's own remarks) — this is a precision/recall tradeoff inherent to the peopleTags signal itself, not a bug.

**Verified live** against the real production data — the "Recently Downloaded" folder, infinite scroll, the type-to-find person combobox (assigned "James Talarico" for real, confirmed via the network response), and the DOWNLOAD link all confirmed via the actual dev browser session, not just code review. `npx tsc --noEmit` and `npx next build` both clean.

### 2026-09-11 morning — bucket auto-classification + manual override, Recently Downloaded list, RESCAN/COPY PATH root-path bug fixed, search UI cleanup, roster data cleanup

**What shipped:**
1. **Bucket classification now has a transcript fallback.** `lib/bucketClassifier.ts`'s three-stage name matcher (strict/alias/surname) is reused a third time from `app/api/videos/[id]/tags/route.ts`'s POST handler: once a video's transcript-derived auto-tags land, if it still has no bucket tag, its `kind="people"` auto-tags are matched against the same roster. Catches aggregator reposts (Instagram, C-SPAN, news accounts) whose uploader/channel/title never name the actual subject, as long as the transcript (or on-screen chyron text) does. Deliberately not relied on alone — see #2.
2. **Manual "move to bucket" control**, since there was previously no way to fix a mis-filed video's bucket by hand at all (typing a bucket name into the regular tag box wrote `kind=null`, not `kind="bucket"` — looked like it should work, didn't). New `POST /api/videos/[id]/bucket` (clears any existing bucket tag, sets the new one, leaves person tags alone) backs a BUCKET dropdown in `DetailsPanel` and an inline one on every row of the new Recently Downloaded list.
3. **"Recently Downloaded" list** at the top of the library sidebar (`LibraryPanel.tsx`) — the 10 (expandable to 25) most recently downloaded videos, each showing its current bucket inline so "where did it go" is answerable at a glance. Reads straight from the `rows` the page already has — no new fetch, nothing stored twice. "CLEAR" just hides the list until the next download (a `localStorage` timestamp); never deletes anything.
4. **RESCAN and COPY PATH's real root-cause bug fixed.** A past DB-first refactor (`agentLibrary()` in `lib/agent.ts`) made the "shared drive root path" lookup hit our own `/api/library` instead of the local agent — which always returned `root: ""` and `exists: true` unconditionally. That silently broke three things: COPY PATH (fell back to a bare filename), RESCAN's status message ("undefined file(s) on the drive" — the now-no-op `/api/library/sync` route doesn't return a `total`), and `requireSharedDrive()`'s pre-flight mount check (could never actually fire, since `exists` was hardcoded true). Restored a real `agentDiskLibrary()` call straight to the local agent's own `/library` endpoint for all three call sites.
5. **"Open File Location" button**, new — asks the local agent (`tools/basiq_agent.py`'s new `/reveal` endpoint) to open Explorer/Finder with the file pre-selected, since the shared drive is one flat 11,000+ file folder where Explorer's "most recent" sort doesn't help you find what you just grabbed.
6. **Search UI cleanup**, per explicit ask: the global search placeholder no longer substitutes the current bucket name ("Search Majority Democrats…" → just "Search…"); the second, confusing box ("Filter names…") renamed to "Filter this list…" (it's a client-side substring filter over the visible bucket/person names — real, just unlabeled); default sort changed from Date: Newest to Relevance (behaves identically to Newest outside an active search, via the existing tie-break, so this is a safe default).
7. **Bucket data cleanup:** removed 5 stray `Majority Democrats` bucket tags on videos whose person tag (Mark Kelly, Tim Sheehy ×2, Bernie Moreno, Dan Crenshaw) already correctly carried a Senate/House bucket tag too — leftover from before the roster source was corrected, never cleaned up in the DB. Fixed with a surgical, scoped delete (5 specific rows) rather than a full `bulk_tag_buckets.py --apply` re-run — lower risk, and re-running the full script would also wipe out the new manual bucket overrides from #2 (both are stored as `source="manual"`, which the script's clear step can't tell apart). Also fixed `/api/library/buckets` fabricating a fake "Unsorted" person entry for any bucket-tagged video with no person tag — it now just counts toward the bucket's total without inventing a name for the sidebar to list.

**Verified live:** dev server + real browser click-through against the actual production Supabase data (not a test DB) — confirmed the Recently Downloaded list surfaced the exact "Video by newsweek" clip (a Trump swearing-in video via an Instagram/Newsweek repost) reported as stuck in Uncategorized; used the new inline bucket dropdown to move it to Notable Figures live (real `POST /api/videos/.../bucket` → 200, sidebar counts refreshed automatically via a new `basiq:library-changed` window event); confirmed via a direct `/api/library/buckets` fetch that Majority Democrats no longer lists "Unsorted" or any of the 4 flagged names (4959 people, was 4963). `npx tsc --noEmit` and `npx next build` both clean; `basiq_agent.py` still compiles.

**Not yet exercised live** (no local agent running in this session, and per standing instruction nothing here touches YouTube to test it): RESCAN's new status message, the transcript-fallback classify path end-to-end (needs a real grab → transcribe → tag cycle to produce `kind="people"` tags), and the local agent's `/reveal` → Explorer call itself. All reviewed carefully in code.

### 2026-09-10 overnight — search punch list items 1-4 shipped and verified live; #5 (true semantic search) deliberately not started

Per explicit instruction, only items 1-4 of the punch list below were worked
tonight — #5 stays its own future project, not touched:

1. **Transcript search auto-seeds from the library search term.** Open a
   result while a library search is active (`TranscriptPanel`'s new
   `externalSearch` prop, threaded through `app/page.tsx` and
   `LibraryPanel.tsx`'s `onSelect`/`onActivate`) and the transcript panel's
   own search box, hit count, and highlighting are already populated with
   that term — no retyping. Also auto-scrolls to the first match once
   segments finish loading (was previously silent/empty on open).
2. **Real position, not just a total.** The hit counter now reads "3 of 12"
   instead of "12 hits", and the current match is visually distinct
   (outlined) from the other highlighted matches — both back by a real
   per-render match cursor, not a guess.
3. **The real Filter dropdown, built on the issue-category data from
   tonight's classification batch.** New `app/api/library/issues/route.ts`
   (real counts per category, aggregated from `kind="issue"` tags) backs a
   searchable multi-select combobox in `LibraryPanel.tsx` (checkboxes,
   counts, a text filter for the list, "Clear all").
4. **Search results (and normal bucket/person browsing) actually respect
   it now.** `app/api/library/route.ts` gained an `issues` filter, applied
   to both the videos and clips queries via a plain deduplicated id list —
   deliberately NOT PostgREST's `tags!inner(...)` embedded-join filter,
   confirmed that approach duplicates a video's row once per matching tag
   (would double-count anything tagged with 2+ selected categories).

**Real bugs hit and fixed along the way, not just clean sailing:**
- **Turbopack crashed outright, unrelated to any of this** — `tools/`
  holds a live Chrome profile (the *other* branch's browser-refreshed
  session work, running concurrently in this same checkout tonight) whose
  leveldb LOCK file was exclusively held while that process ran. Tailwind
  v4's zero-config content auto-detection scans the whole project (minus
  `.gitignore`) and choked reading through the lock. Fixed for real by
  adding `tools/youtube_profile` to `.gitignore` (Tailwind respects it);
  also added `outputFileTracingExcludes` for `tools/`/`.claude/` in
  `next.config.ts`, though that alone did not fix this specific crash.
- **The `issues` query param broke on category names containing a comma**
  (`"National Security, Defense & Foreign Policy"`) — was being parsed with
  a naive `.split(",")` on one joined string, which silently split that one
  category into two garbage fragments matching nothing (zero results, no
  error — the dangerous kind of bug). Fixed by using repeated `?issues=`
  params instead of a comma-joined list, both sides (`URLSearchParams.append`
  / `searchParams.getAll`) — sidesteps the delimiter collision entirely
  rather than trying to escape it.
- **Search + issue filter together crashed the whole request** (a raw
  `TypeError: fetch failed`, not even a clean PostgREST error) — two
  separate ~200-id lists (search's `transcriptVideoIds` and the new
  `issueVideoIds`) landing in one URL reliably broke it, the same class of
  problem the existing 200-id cap was already there to prevent, just not
  accounted for stacking. Fixed with an adaptive `ID_LIST_CAP` (halved to
  100 each when both filters are simultaneously active) rather than
  guessing at one bigger combined number.

**Verified live, not just via API calls:** real browser click-through —
drilled into Elissa Slotkin, searched "iran" (48 real, correctly-scoped
results), opened a result and watched the transcript panel arrive with
"iran" already searched, highlighted, and positioned ("1 of 1"); on a
longer video, arrow-navigated through 21 real hits with the position
counter and highlight both advancing correctly; selected the "National
Security, Defense & Foreign Policy" filter while searching "iran" in
Majority Democrats and got exactly the 3 real, correct results (confirmed
against a direct API call first, then confirmed the same number again
through the actual UI).

**Not yet done, worth doing next:** the OLD single-select tag dropdown
(`tag`/`ALL_TAGS`, the messy `kind="topics"` auto-tags) still doesn't apply
to search results either — deliberately left alone tonight since the new
Filter dropdown on `kind="issue"` was the actual ask; worth a decision at
some point on whether that old dropdown still earns its place at all now
that a real one exists.

### 2026-09-10 evening — multi-identity YouTube worker infrastructure designed + first pass built, paused for the night on its own branch (nothing on master, nothing pushed)

**Why this started:** the team is about to grow from just Paul to 2-3 people,
and today's two real incidents above (YouTube flagging this one account/IP,
twice) made clear that a durable fix has to spread GRAB across multiple
independent identities, not just patch the one that's currently broken.
Explored a bunch of options (residential proxy alone, real-time browser
screen-capture, distributed teammate IPs, mobile hotspots) before landing on
a combination — see the full design reasoning in this session's transcript
if it's ever needed; what matters for picking this back up is the plan
below, which is self-contained.

**The decided architecture — no code changes needed to the hardest part:**
the droplet's existing `/worker/jobs` claim/reclaim protocol
(`basiq_agent.py`'s `claim_job()`/`list_worker_jobs()`, `basiq_worker.py`'s
`_poll_once()`) **already safely supports multiple concurrent workers** —
confirmed by reading it, not assumed. So the plan is: stand up 2-3
independent identities (dedicated Google account + own machine + own
browser-refreshed cookies), all polling that same existing queue. Whichever
worker is free claims the next job — that alone spreads YouTube traffic
across identities, with zero new "who submitted this" logic needed (the app
has no user accounts and doesn't need one for this).

**Where the work actually is:** branch `feat/multi-worker-youtube-resilience`,
commit `9b2b72b` — **not on master, not pushed anywhere.** To resume:
`git checkout feat/multi-worker-youtube-resilience`. The full plan this was
built from is also saved locally at
`C:\Users\plcon\.claude\plans\noble-noodling-cocoa.md` if that's still
around, but everything essential is repeated here.

**What's built on that branch:**
- **`tools/youtube_session.py`** (new) — replaces manually re-exporting
  `cookies.txt` from a browser extension. Uses a persistent Playwright
  Chrome profile (real Chrome via `channel="chrome"`, not the bundled
  Chromium — deliberately, since a real browser is less bot-detectable);
  `--login` is the one-time interactive step (visible window, a human logs
  into a dedicated Google account), `--refresh` re-validates unattended.
  Self-validates against `check_cookies.py`'s cookie list before ever
  overwriting a known-good `cookies.txt` — a bad refresh leaves the old file
  untouched.
- **`tools/basiq_worker_tray.py`** (new) — replaces the old
  `start-worker.bat` console-window/no-auto-restart pattern (the user
  explicitly flagged that pattern as not good enough for a non-technical
  team). A tray icon that supervises the real worker as a child process,
  **auto-restarts it if it crashes** (verified), shows real status (reads a
  new `worker_status.json` the worker writes), and has a menu: Pause/Resume,
  Restart, "Log into YouTube…", Open Logs, Quit. Auto-launches at login via
  a Startup-folder shortcut (no admin needed).
- **`tools/basiq_agent.py`** — one new opt-in `YTDLP_PROXY` env key in
  `base_opts()`, off by default for every identity. Only meant to be turned
  on, per-identity, if/when that one identity's home IP actually gets
  flagged — not bought proactively for everyone.
- **`tools/basiq_worker.py`** — fixed to work when frozen/launched directly
  (no `.bat` wrapper): reads `worker_config.txt` itself now, fixed
  `LOCK_PATH` to use the frozen-aware `HERE`. Added the cookie-staleness
  check (kicks `youtube_session.ensure_session()` in a background thread
  when `cookies.txt` is stale) and the `worker_status.json` writer.
- **`tools/check_cookies.py`** — refactored to expose a reusable
  `missing_required()` (same behavior, just importable now).
- **`tools/build/`** — a full second PyInstaller + Inno Setup pipeline
  (`basiq_worker.spec`, `build_worker_windows.bat`, `installer_worker.iss`,
  `requirements-worker.txt`) producing `Basiq-Worker-Setup.exe`, separate
  from the existing per-person agent installer. Deliberately built from its
  own lean `.venv-worker` (yt-dlp/playwright/pystray/Pillow only — never
  torch/spaCy) rather than reusing `tools/.venv`.

**Verified tonight, all without a single automated call to real YouTube**
(per the standing rule — every check below is a fake, a mock, or a local
stub): the cookie Netscape serializer round-trips through
`missing_required()` correctly; the `YTDLP_PROXY` branch has real unit tests
(`tools/test_base_opts_proxy.py`); `basiq_worker.py`'s config-loading and
cookie-refresh-trigger logic were verified with `youtube_session` faked out
entirely; the tray supervisor's full lifecycle **and its actual
crash-auto-restart behavior** were verified against a harmless dummy child
process; `installer_worker.iss` compiles cleanly with Inno Setup — that
compile step caught two real bugs along the way (a line that broke Inno's
preprocessor, and a missing guard so a scripted/silent install can't hang
forever waiting on a dialog box).

**Explicitly NOT yet verified — flagged honestly, not swept under the rug:**
- **No real PyInstaller freeze has been run yet.** Everything above was
  checked by reading/unit-testing the Python source directly, not by
  actually building `Basiq-Worker-Setup.exe` for real. That's the single
  biggest unknown left.
- **The installer's actual silent-install/uninstall run couldn't be
  exercised end-to-end in this sandbox** — the Setup.exe GUI process hung or
  failed inconsistently when launched from this tool's shell (looks like a
  sandbox/window-station limitation, not a bug in the `.iss` script itself,
  but genuinely unconfirmed either way). Needs one real run on an actual
  Windows desktop session.
- **`pystray`'s Windows tray-icon backend has zero track record in this
  codebase's PyInstaller builds** — `basiq_worker.spec` already does a
  defensive `collect_all("pystray")`, but this is the first place to look if
  the tray icon doesn't show up in a real frozen build.
- **`channel="chrome"` + a runtime `playwright install chrome` step is a new
  pattern here** — the existing, already-proven Playwright usage in
  `basiq_agent.py` uses the bundled default Chromium, not a real installed
  Chrome. Worth watching closely on the first real login test.

**Tomorrow, in order:**
1. `cd tools && python -m venv .venv-worker && .venv-worker\Scripts\python.exe -m pip install -r requirements-worker.txt`, then `cd build && build_worker_windows.bat` — the first real freeze. Expect to spend time here; PyInstaller hidden-import surprises (especially around `pystray`) are the likely first speed bump.
2. Silently install the result on a real Windows desktop session (not through this tool's shell) and confirm shortcuts/config-merge/uninstall actually work as designed.
3. Prepare `worker_config.seed.txt` (the four shared values: `AGENT_URL`/`AUTH_TOKEN`/`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`) and drop it next to the installer output on the shared drive — never commit it, it's already gitignored.
4. Run `youtube_session.py --login` against **Paul's own existing identity first** — lowest risk, already a warmed account. Verify with `check_cookies.py`, exactly as before — **not** a test grab.
5. Only once that's proven stable for a few days: create and warm up a second dedicated Google account, build/distribute the installer to teammate #2, and let **one real, human-initiated grab** (never automated — see the standing rule right below this section) be the actual proof it works.
6. Don't buy any proxy subscription yet — only if/when a specific identity's home IP is actually confirmed flagged.

### 2026-09-10 afternoon — C-SPAN grab fixed (real root cause, not a retry/luck problem); X/Instagram/Facebook/TikTok spot-checked clean

Same day's second real incident: right after the YouTube failure above, C-SPAN
grabs started failing too (`ERROR: Unsupported URL`), on URLs like
`c-span.org/clip/campaign-2026/...-5205731`. Diagnosed properly rather than
guessed at:

- **Real root cause:** C-SPAN's newer `/clip/campaign-.../slug/id` URL
  format isn't covered by yt-dlp's own dedicated `CSpan` extractor at all —
  that extractor only recognizes the old `c-span.org/video/?id-1/slug`
  scheme (yt-dlp has a documented history of lagging C-SPAN's URL changes;
  a near-identical gap was reported for `/program/` URLs previously, see
  [yt-dlp#11839](https://github.com/yt-dlp/yt-dlp/issues/11839)). Every
  `/clip/` URL was falling through to yt-dlp's generic HTML-scrape fallback
  extractor, which is inherently heuristic — confirmed by watching the
  *exact same URL* succeed once and then fail on an immediate retry with
  nothing else changed.
- **The fix:** `resolve_cspan_clip()` in `tools/basiq_agent.py`, wired into
  `_grab_once()`. C-SPAN's clip pages embed a reliable (if nonstandard)
  JSON-LD block — `{"video": {"contentUrl": "...m3u8", ...}}`, wrapped one
  level under a "video" key rather than being the top-level VideoObject
  schema.org actually specifies, which is plausibly exactly what trips up
  generic's own JSON-LD handling inconsistently. Reading it directly and
  handing yt-dlp the resolved CDN m3u8 URL bypasses the fragile scrape
  entirely. Confirmed consistent 6/6 across both of today's failing clips
  (3 attempts each) before wiring it in. Falls back to yt-dlp's original
  (flaky) behavior if the page's shape ever changes again or the fetch
  fails for any reason — this can only make C-SPAN clips more reliable,
  never less.
- **Not yet re-verified end-to-end after wiring in**, and deliberately not
  pushed further tonight: immediately after confirming the resolver 6/6
  clean, a full pipeline retest started getting empty `202` responses from
  C-SPAN's own server — almost certainly a temporary rate-limit from the
  sheer volume of automated requests this diagnosis itself generated in
  ~15 minutes (curl tests, repeated Python fetches, the bisection loop,
  three real grab attempts). Backed off rather than keep testing through
  it. The next real grab of a C-SPAN `/clip/` URL is the real verification,
  not more automated hammering from here — same posture this file already
  takes with YouTube, extended to any site under active, repeated testing.

**X, Instagram, Facebook, TikTok — spot-checked with one real URL each per
the user's request ("make sure everything but YouTube works every time"),
all four extracted cleanly on the first try, no cookies needed:**
- X: `x.com/gtwhitesides/status/2097800332021497897` — up to 1920x1080.
- Instagram: `instagram.com/reels/DdFGMfjyy6C/` — dash video+audio formats.
- Facebook: `facebook.com/reel/1894313417840524` — resolved via the
  `m.facebook.com/watch` redirect yt-dlp follows automatically.
- TikTok: `tiktok.com/@therightinsights/video/7683596390848662805` — up to
  1080p.

Deliberately only one attempt per URL, not a real reliability guarantee —
the C-SPAN incident above is itself proof that "worked when tested" and
"works every time" are different claims, since a site changing its own URL
scheme is the actual recurring failure pattern today (this, and YouTube's
evolving bot detection, are both fundamentally "the site changed and the
extractor/session didn't keep up" stories). The honest ongoing mitigation
for all of these is routine yt-dlp version upkeep, not a one-time fix.

### 2026-09-10 midday — first real grab today failed all 3 retries; fresh cookies rule out yesterday's root cause

Followed this morning's plan: re-exported cookies from an actual youtube.com
video page after browsing normally on a new account first, verified locally
with `check_cookies.py` (clean — `LOGIN_INFO` and all 74 expected cookies
present), installed at `tools/cookies.txt` (old export kept as
`cookies.txt.bak-2026-09-09`). Then the user ran the one real, human-initiated
grab this plan called for.

**It failed immediately, and all 3 of the worker's own auto-retries failed
identically** — confirmed by reading the agent's `/jobs/<id>` status directly
(read-only, no additional YouTube calls made to check this):
`Sign in to confirm you're not a bot`, same message every time, on
`youtube.com/watch?v=7xOURK7-UMs`.

**This is a different, more serious situation than 2026-09-09's incident.**
That one was a bad cookie export (missing `LOGIN_INFO`) — a fixable data
problem. This time the cookie export is verified complete and still fails on
the very first attempt. That rules out cookie quality as the cause and points
squarely at the account and/or this machine's IP being flagged by YouTube's
own bot detection — exactly the "if it fails again" branch this morning's
plan anticipated, just arriving faster and more conclusively than hoped.

**Next step, not yet done:** the isolating test already scoped this morning
— try the identical grab from a phone hotspot instead of this network, same
account. Whichever way it goes locates the real problem:
- Works on the hotspot → this machine's IP/connection is flagged. Fix is a
  paid residential proxy service (a consumer VPN would likely make it worse
  — most VPN exit nodes are datacenter IPs YouTube already distrusts more
  than a home connection).
- Still fails on the hotspot → the account itself is flagged, even after
  today's deliberate "warm it up by browsing normally first" attempt. A more
  sobering result: it would mean one browsing session isn't enough warm-up
  anymore, not that warm-up doesn't matter at all.

Both branches are real cost/time decisions (a proxy subscription, or an
account that needs to age for longer before being trusted) — deliberately
not decided here, same posture as every other YouTube-adjacent decision in
this file.

### 2026-09-10 — search scoping + real relevance ranking shipped and verified; tag-filter work paused on a real data finding

Cracked open the data-normalization/search conversation flagged as "the big
one" in the 2026-09-08 entry below. Two of three pieces are done tonight,
verified against the real dev server (not just code-reading):

- **Global search now respects wherever you're browsing, throughout the
  system.** Searching from inside a person's folder (e.g. Elissa Slotkin)
  used to run the exact same unscoped, library-wide query as searching from
  the root — a real, confirmed bug, not a perception issue. Fixed in
  `components/studio/LibraryPanel.tsx`: the global search box now scopes to
  whatever bucket/chamber/person/uncategorized view is currently open
  (chamber falls back to scoping by its parent bucket, since there's no
  chamber-specific view server-side). Verified live: searching
  "infrastructure" from Elissa Slotkin's folder returns 12 results vs. 227
  unscoped from the root — same term, same server, correctly different
  result sets. The search box's placeholder now names the active scope
  ("Search Elissa Slotkin's videos…") so it's visible, not just functional.
- **Real relevance ranking, not a made-up heuristic.** Added "Relevance" as
  a sort mode, auto-selected the moment a search goes active and reverted to
  "Date: Newest" the moment it's cleared (both confirmed live). Backed by a
  real Postgres `ts_rank()` score via a new RPC function
  (`supabase/migrations/0012_transcript_search_rank.sql`) rather than
  guessing client-side. **This migration has NOT been run yet — needs the
  user to paste it into Supabase Dashboard → SQL Editor → Run, same as
  0009/0011 before it.** Until then the app falls back gracefully to the old
  unranked match (confirmed live: the missing-RPC case logs a clear warning
  and search keeps working) — nothing is broken in the meantime, but
  "Relevance" won't actually reorder anything until the migration runs.

**Tag/issue filter dropdown — paused on a real finding, not started yet.**
The consolidation table used to plan this (57 raw tags → ~12-15 categories)
turned out to be a rough pass done elsewhere, not a live query — checked the
real tag data directly and it's a different problem than it looked like:
**6,862 distinct auto-generated "topic" tags** exist (raw NLP keyphrase
extraction off transcripts), e.g. `"affordability crisis"`,
`"affordability case"`, and `"health care affordability"` are three separate
strings, not one "Affordability" tag — most distinct tags occur exactly
once. There is no clean list to merge; real "Member Issue" categories need
each video classified into a fixed taxonomy, not existing strings renamed.
Costed out an LLM classification pass (title + existing tags, since median
transcript length is only ~1,930 characters but the long tail runs past
300K) over all 11,239 videos: ballpark **$5-10 one-time** on Claude Haiku
4.5, less with the Batch API — cost is not the constraint here, coverage
quality for tag-sparse videos is. Decision on approach, and the exact
category list, still pending the user.

**Also found, not acted on:** `public.transcripts.search_tsv` (the Library's
own search index) still uses the `'english'` stemming config — the same
class of bug (`0009_simple_transcript_search.sql` fixed "helene" collapsing
into "helen" for the separate, parked Archive feature) was never applied
here. Flagging so it isn't lost; not fixed tonight since it wasn't asked for
and changes existing search behavior.

### 2026-09-09 evening — where GRAB actually stands, and the plan for tomorrow

**Status as of tonight: GRAB is still not reliable. Two real bugs got fixed today (both stay fixed, see the section right below this one), but a real grab still failed again after both fixes were in place, with the PO-token server confirmed never even contacted.** That means the current best explanation is YouTube's own anti-bot enforcement being aggressive against this specific account and/or this machine's connection — not a code bug still hiding somewhere. The Windows Scheduled Task for the worker was briefly re-enabled today, then explicitly switched back off by the user ("that is a nightmare") — leave it **Disabled**, manual `start-worker.bat` only, until decided otherwise.

**Tomorrow's plan, in order:**

1. **Don't touch YouTube again tonight.** No re-exports, no test grabs. Time away from it is the one free lever available.
2. **Re-export cookies properly before doing anything else** — load an actual youtube.com *video* page while logged in (not the homepage, not a Google account page), export, then run `python tools/check_cookies.py` locally. Zero YouTube calls, catches a bad export (missing `LOGIN_INFO`) in under a second instead of burning a real attempt to find out.
3. **Let the very first real grab of the day be a single, quiet, low-stakes one.** Not a demo, not back-to-back with anything else.
4. **If it works, try a second one at a normal pace** (not immediately back-to-back) to see whether it holds up this time — this is the actual test of whether today's two fixes (missing `LOGIN_INFO`, yt-dlp's cookie-jar self-destruction) were the whole story or not.
5. **If it fails again — this is the important branch, planned out in advance so there's no scrambling:**
   - **First, figure out which one is actually the problem — account, or network — before spending money or creating anything new.** Try the exact same Google account from a different connection (a phone hotspot is the fastest way to test this, five minutes). If that works, it's this machine's IP/connection that's flagged, not the account. If it still fails, try a different Google account from the normal network instead. Whichever swap fixes it tells you where the real problem lives.
   - **If it turns out to be the account:** stand up one dedicated Google account just for this tool (not personal), and "warm it up" first — actually browse YouTube as a real person for a while before ever exporting cookies from it. A brand-new account exported immediately can look just as suspicious as an overused one.
   - **If it turns out to be the network:** a normal consumer VPN will likely make it *worse* (most VPN exit nodes are datacenter IPs, which YouTube already distrusts more than a home connection). The real fix there is a **residential proxy service** (paid — e.g. Bright Data, Smartproxy) or running the worker from a genuinely different real connection. This is a cost/complexity decision to make deliberately, not something to sign up for reflexively.
   - **If neither swap fixes it**, that points to something broader than this account or this IP, and the honest answer at that point is it needs more time, not another workaround.

**Separately, verified and fixed tonight, unrelated to the GRAB issue above — safe to demo:**
- Transcript search, highlighting text to set clip IN/OUT points, and exporting a clip from that selection were all tested live against production and confirmed working (Sununu NBC clip: transcript loaded with real synced timestamps, highlighting a line set the IN/OUT range, Export Clip activated).
- Found and fixed a real bug while doing that verification: searching a common word (e.g. "infrastructure") that matches hundreds/thousands of transcripts returned a 500 error instead of results — the search was folding every matching video id into a single filter clause, building a URL long enough for PostgREST to reject outright. Capped at 200 ids in `app/api/library/route.ts`, deployed, and re-verified live (`infrastructure` now returns 227 real results instead of erroring). Safe to demo search on anything now, not just narrow terms.

### 2026-09-09 — GRAB fixed for real: the actual root cause was a missing cookie, not staleness

**🔴 If GRAB ever starts failing again with "Sign in to confirm you're not a bot," read this whole section before doing anything else.**

**Root cause, finally nailed down:** it was never really about cookies being *stale* — it was about the exported cookie file missing `LOGIN_INFO`, the specific cookie YouTube sets once it recognizes a session as logged-in on youtube.com itself, separate from just having valid Google account cookies (SID/APISID/etc.). A cookie export can look completely normal — hundreds of real login cookies, a legitimately signed-in Google session — and still fail 100% of grabs with the bot-check error if this one cookie is missing. It goes missing when an export extension's "include HttpOnly cookies" option is off, or when the export is taken from a Google account page rather than an actual youtube.com video page.

**The fix, and how to redo it fast next time:**
1. Actually load a real youtube.com **video** page while logged in (not the homepage, not a Google account page) — then export cookies.
2. Before trusting the export, run `python check_cookies.py [path]` (new script, tools/) — it checks locally for `LOGIN_INFO` and the other required login cookies, makes zero network calls, and would have caught this in seconds instead of the hours it actually took today.
3. Drop the export at `tools/cookies.txt` (path in `COOKIES_FILE` in `worker_config.txt`).
4. **Do not test it.** Let the very next real, human-initiated grab from the actual UI be the first use. See the next item for why.

**🔴 Standing rule now, not just a one-off lesson: never run an automated/test grab against YouTube, for any reason, including "just to verify a fix."** This is what actually caused today's multi-hour outage — a fresh, good cookie export got run through two automated test grabs immediately after being installed, and that burst of automated calls is exactly the pattern YouTube's bot detection flags. It burned the export within about 15 minutes, on top of already having burned last night's export the same way. Confirmed to matter twice in the same 24 hours. Any future Claude session working on this: this is saved in Claude's own memory now too, but it's worth knowing it's not superstition — verify a YouTube-facing fix only through the user's own real usage, or through checks that never call out to YouTube at all (`check_cookies.py`, the agent's job-status API, the PO-token server's own health/logs).

**Also fixed along the way (unrelated bug, real one):** an old cookie file had been committed to the repo root and pushed to this **public** GitHub repo since 2026-08-25 — see the entry a few sections below for the full writeup. Untracked and gitignored now; the leaked session itself still needs the user to invalidate it by hand.

**Confirmed working end to end:** a real grab (an NBC News clip) completed cleanly through the whole pipeline — download, transcribe, tag, filed to the shared drive — using a cookie export that passed the `LOGIN_INFO` check above.

**Then a second real grab (the very next one, still human-initiated, not automated testing) failed the same way minutes later.** Root cause #2, found by rechecking the cookie file with `check_cookies.py` rather than guessing: yt-dlp doesn't just *read* `COOKIES_FILE` -- it loads it as a live cookie jar and **saves it back**, possibly modified, when it's done. After that one successful grab, the saved-back file had `LOGIN_INFO`/`SID`/`HSID`/`SSID`/`APISID`/`SAPISID` **stripped out entirely** -- a good export degrading into a broken one after a single real use, with no testing or automation involved at all this time.

**Fixed in `basiq_agent.py`'s `base_opts()`:** it now copies the real `COOKIES_FILE` to a disposable `cookies.txt.working` and hands *that* to yt-dlp, every single grab. Whatever yt-dlp's save-back does to its own working copy no longer touches the real export -- every future grab starts from the same known-good cookie file instead of an increasingly-degraded one. `cookies.txt.working` is gitignored (machine-local, regenerated automatically). This is a mitigation based on the evidence (cookies broke after exactly one successful use, and the master export was otherwise untouched on disk) -- like everything else YouTube-related, it's verified by the user's own next real grab, not by an automated test here.

**Still open, worth deciding on:**
- Full git-history scrub for the leaked cookie file (rewrite + force-push) — not done, needs the user's sign-off since it rewrites shared history.

### 2026-09-09 morning — verified last night's 275-video batch for real, not just from the log

Checked directly against Supabase (queried `transcripts` for all 275 target video
IDs from `tools/session-2026-09-08/genuinely-remaining.json`) rather than trusting
the overnight narrative: **274/275 have real transcript rows.** The 1 missing is
exactly the pre-existing-bad-`local_path` video flagged last night
(`a2c2818c-21a6-4268-bbcc-cd406d37fbfa`) — still needs a human to find the real
file, nothing new. No transcription process is running right now (confirmed via
`tasklist`); the batch is genuinely finished, not stalled.

One loose end from last night's copy-out-before-session-ends step:
`tools/session-2026-09-08/transcribe-remaining.log` and
`-progress.json` only captured an early mid-run snapshot (27/275, timestamped
4:44pm 9/8) — the run that actually finished the batch (ending 3:41am 9/9, 13/14
ok on the final stragglers) happened in that session's own temp scratchpad and
never got copied over. Left as-is rather than reconstructed, since the Supabase
check above is the real source of truth; flagging so nobody reads that file as
"the batch only got to 27."

Committed the 5 files flagged last night as ready
(`ec74532`, not pushed): `basiq_agent.py`, `import_archive_items_to_library.py`,
`transcribe_remaining.py`, `check_no_speech_audio.mjs`, `HANDOFF.md`.

**Ran the 82-video no-speech-bug batch — 74/82 confirmed fixed.** Matched all
82 flagged filenames (`tools/session-2026-09-08/no-speech-catalog.json`,
`classification: "has-real-audio"`) to real video IDs first (100% match), list
saved to `tools/session-2026-09-09/no-speech-82-list.json`. Ran locally via
`transcribe_remaining.py` (local Whisper, no cloud/API cost, ~10 minutes wall
time). Verified directly against Supabase afterward rather than trusting the
run's own log, per last night's lesson: **74/82 now have real transcript
rows.** The other 8 still have none, even with the VAD-off retry — but their
titles (fireworks shows, a casket-carrying ceremony, a drone show, ambient
B-roll clips) line up with "genuinely no spoken words," not a repeat of the
VAD bug. Full list of the 8 in `tools/session-2026-09-09/no-speech-82.log`.
Not investigated further; flagging in case one of these titles looks wrong to
a human who knows the actual clip.

Also fixed a portability issue in `transcribe_remaining.py` found while
setting this up: it hard-coded its list/log/progress paths into the
*previous* session's temp scratchpad folder, which could vanish at any time.
Added `--list`/`--log`/`--progress` CLI args instead.

**🔴 Found a real, live secret leak while doing the above — fixed the
tracking, but the underlying credential still needs the user's own action.**
A root-level `cookies.txt` (real Google/YouTube session auth cookies, not the
already-gitignored `tools/cookies.txt`) has been committed and pushed to this
repo's **public** GitHub remote since `0dbd5bd` (2026-08-25) — publicly
visible for about two weeks. Untracked it and added `/cookies.txt` to
`.gitignore` so it can't happen again, but that only stops it going forward;
the value itself has been public this whole time and needs to be treated as
compromised regardless of anything done in git. **User action needed: sign
out of that Google account's sessions (or change its password) to invalidate
the leaked cookies.** Separately, a full git-history scrub (rewriting history
to remove the old commit + force-push) would still be worth doing before
teammates clone this repo — not done yet, flagged for the user to decide on
since it rewrites shared history.

### 2026-09-08 — big cleanup/completeness session. Read this whole section before doing anything else tonight/tomorrow.

Long session, lots landed, one real thing broken at the very end. In priority order:

**🔴 GRAB is currently broken for real YouTube videos — needs a human, not more code.** Last thing tested tonight: two completely ordinary (non-restricted, popular) videos both failed with YouTube's "Sign in to confirm you're not a bot" error, through the real worker, after every code-side fix below was already in place. Diagnosis: the cookie-based login session got hit by dozens of automated yt-dlp calls in a few hours (mine, testing things, plus the worker's own retries) — exactly the pattern YouTube's bot detection flags. The code is right; this specific browser session is burned. **Fix: export fresh cookies from Firefox after actually browsing YouTube normally as a logged-in human for a bit first** (`tools/cookies.txt`, `COOKIES_FILE` in `tools/worker_config.txt`), then test with a real GRAB. Do **not** hammer it with a string of automated test calls again afterward — that's very likely what caused this. If a fresh cookie export *still* fails broadly, the account itself may need a cooldown period, not just new cookies.

**Storage reclaimed tonight: ~194 GB**, all moved to `D:\basiq_ingest_batch_1\` before deleting (per the user's standing preference — always move-then-delete for bulk storage cleanup, never a straight delete, drive-space allowing):
- `_hdrive_staging` folder (an old, fully-superseded downloader tool's output — confirmed every one of its 990 videos already existed elsewhere in Library, verified both by ID *and* real ffprobe duration match on a 40-file sample) — deleted outright, ~34GB, nothing moved since it was 100% redundant.
- 247 duplicate video-file copies scattered through the Hub root → `D:\basiq_ingest_batch_1\duplicate_copies` → deleted from Hub. ~160GB, took ~3 hours (one 8.8GB file in the middle, not a hang).
- The old downloader tool's own program files/logs/state → `D:\basiq_ingest_batch_1\old_downloader_tool`.
- **Still open, not started: 874GB in `.pre-fragment-backup`/`.orig-ts`/`.pre-fix-backup` files** — confirmed safe (spot-checked ffprobe on 4 replacements, all good), explicitly deferred because the external drive didn't have room for this on top of the 160GB above. Move-then-delete, same as everything else, once there's room.

**Transcript completeness — big real progress:**
- 462 archive-sourced videos backfilled with **real, timestamp-synced transcripts** (not just full-text) — 1,235,965 real `transcript_segments` rows, reading each item's local `.srt` file directly rather than Supabase's flattened `full_text`. See the updated pending-item note below (was item 12).
- Found and removed **59 genuine duplicate videos** (same real content ingested twice under different filenames/IDs — confirmed by matching both transcript content *and* actual playback duration to within 2 seconds, not just title text, which turned out to vary across ingestion sources for the same real video). Deleted the newer/lesser-named copy each time, kept the properly-named one. 34 *other* same-titled pairs were checked and left alone — their durations differed by more than a few seconds, so they're real, different recordings, not duplicates.
- The "no speech detected" transcription failures (127 videos) got a **real audit, not a sample**: 46 are genuinely silent (tiny clips, nothing to transcribe, fine as-is), **82 have real audible speech and were failing because of a real bug** — `faster-whisper`'s VAD (voice-activity filter) was misjudging real speech as silence on some files and dropping the whole thing. **Fixed** in `tools/basiq_agent.py`'s `run_transcribe()`: now retries once without VAD if the first pass comes back empty, before giving up. Those 82 videos are ready to be queued for transcription now that the bug's fixed — **not yet run**, on purpose (didn't want to compete with the batch below for CPU). Full catalog of which-is-which: `tools/session-2026-09-08/no-speech-catalog.json`.
- **A 275-video transcription batch — two real bugs found and fixed after the "good night" message, both now confirmed working, batch finishing itself out.** Sequence, since this is important:
  1. The first overnight run crashed at video 47/275 — not a transcription problem, a `print()` on this console's cp1252 encoding choking on a video title containing a character it can't represent. Fixed in `transcribe_remaining.py`: `sys.stdout.reconfigure(encoding="utf-8", errors="replace")` at the top.
  2. Restarting it (with a resume check added so it doesn't redo already-finished videos) surfaced a **second, worse bug**: the same VAD-retry fix from earlier tonight had a real regression — `run_transcribe()` in `basiq_agent.py` referenced the whisper `info` object outside the scope it now lived in after that edit, throwing `NameError` on literally every single video, but that error got caught by basiq_agent's OWN internal broad except-and-log block and never reached this script as a raised exception. **Net effect: dozens of videos got logged "successfully transcribed" with ZERO actual rows written to `transcripts`/`transcript_segments`.** Confirmed directly against a live sample (3 "successful" ids had 0 transcript rows in Supabase). Fixed in `basiq_agent.py`: `_run_whisper()` now returns the detected language string instead of trapping the whole `info` object. Also hardened `transcribe_remaining.py` itself: it no longer trusts "`run_transcribe` didn't raise" as success — it directly checks Supabase for a real transcript row before counting anything as OK, specifically so this class of silent-failure can't happen again undetected.
  3. Re-verified end to end after both fixes (real transcript rows confirmed in Supabase, not just "no crash"), then resumed the batch. **Finished clean: 13/14 ok, 1 real failure** (the safety check from fix #2 correctly caught it as a genuine failure this time, not a false "OK"). Combined with the earlier legitimately-completed portion, this whole 275-video population is now done except for one item (below) and whatever's still mid-flight from the *other*, independent transcription effort that's been running in parallel all along (a different session's job — 258 of these 275 already had a real transcript by the time this one re-checked, most of that from that other effort, not this script).
  - **One real, pre-existing data problem surfaced, not caused by tonight:** video `a2c2818c-21a6-4268-bbcc-cd406d37fbfa` ("34_2025-06-12_gabe_vasquez_hegseth_house_armed_services_budget...") has `local_path` pointing at `34_2025-06-12_gabe_vasquez_hegseth_house_armed_services_budget_fixed_temp_16k.wav` — a whisper-intermediate temp audio file, not a real video, and one that got correctly identified and deleted as junk earlier this same session. This video's database row was already wrong before that cleanup; deleting the junk file just made the existing problem visible (a "media file never finished syncing" error, since the file it points at doesn't exist). Needs a human to find the real video file for this content and correct `local_path` — not urgent, one video.
  - **Take-away for future work on `run_transcribe()`:** its own error handling swallows exceptions silently (logs "[transcribe ERROR]" and moves on) rather than propagating them — anything calling it directly (like this script) needs to verify the actual DB write independently, the way `transcribe_remaining.py` now does, rather than trusting a clean return.
- Still fully untouched: **90 videos over 4 hours long** — no plan, no attempt, genuinely just parked.

**YouTube PO-token infrastructure — properly fixed, two real bugs found along the way:**
- Turned out a PO-token server (Deno-based, `bgutil.service`) was already running on the droplet since Sept 1st — nobody (including me, initially) knew, since it was never checked into this repo. Updated it to the current version (was badly out of date), fixed it defaulting to localhost-only after that update (added `--host 0.0.0.0` to its systemd `ExecStart`), confirmed it's externally reachable again.
- Wired `tools/basiq_agent.py`'s yt-dlp `extractor_args` to actually use it (`youtubepot-bgutilhttp` pointing at the droplet, override via `BGUTIL_POT_BASE_URL`).
- **Real bug caught late:** the worker runs its own separate Python venv (`tools/.venv`), completely different from the system Python everything else in this session used — the PO-token *plugin* (`bgutil-ytdlp-pot-provider`, a pip package, separate from the server) was only ever installed into the system Python, never the worker's venv, so none of the above actually helped real GRABs until this got caught and fixed (`tools/.venv/Scripts/python.exe -m pip install bgutil-ytdlp-pot-provider`). **If yt-dlp behavior ever needs testing again, test through `tools/.venv/Scripts/python.exe`, not the system one** — they can silently disagree.
- The "Basiq Worker" scheduled task is **deliberately left Disabled** — user wants manual control while testing. To run it: `cd tools && start-worker.bat`. A leftover `tools/worker.lock` from an earlier crashed/closed run can block a fresh start — delete it if `start-worker.bat` seems to hang or refuses to start.

**Real code changes sitting uncommitted** — review and commit when convenient, nothing has been pushed:
- `tools/basiq_agent.py` — the PO-token wiring + the VAD-retry transcription fix, both above.
- `tools/import_archive_items_to_library.py` — upgraded to read local `.srt` files for real segment-level transcript import (used for the 462-video backfill above).
- `tools/transcribe_remaining.py` (new) — the whisper batch runner used for the 275-video run.
- `tools/check_no_speech_audio.mjs` (new) — the audio-reality-check tool used to catalog the 127 no-speech videos.

**The big one, still waiting:** the actual data-normalization/schema conversation (one clean schema instead of `videos` + `archive_items` as two parallel systems) — explicitly not started. User's words: "this is the BIG one once everything is organized and ready to be treated with this sort of respect." Cleanup above was largely in service of getting there; not there yet.

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

    **Update (2026-09-08):** both gaps addressed. The video-import half turned out to already be done (by some other process, before this session even started digging back in) — 0 new videos needed importing. The real remaining gap was transcripts: extended `tools/import_archive_items_to_library.py` to read each item's local `.srt` file directly (the real per-cue timing already existed there, just never got pushed to Supabase at the segment level) instead of only copying flattened `full_text`. Ran the real backfill: **462 videos got a full, verified, timestamp-synced transcript — 1,235,965 real transcript_segments rows inserted**, zero duplicates introduced (checked directly: cross-referenced every new transcript's content against every other transcript in the table, confirmed none of tonight's overlap with each other or anything pre-existing). Also found, separately, **93 pairs of transcripts elsewhere in the table sharing near-identical content** — all dated Aug 18–Sept 1, predating this fix entirely, not caused by it — worth its own look at some point, not urgent.

13. **874 GB of backup files (`.pre-fragment-backup`, `.orig-ts`, `.pre-fix-backup`) still sitting on the shared drive (2026-09-08).** Leftovers from the already-completed, already-verified long-video remux fix (see the 2026-08-31→09-01 entry above) — safe to reclaim, spot-checked 4 replacement files with ffprobe and all played back correctly. Explicitly not done yet: user prioritized a smaller 160GB duplicate-copy cleanup first (done, moved to `D:\basiq_ingest_batch_1`) given limited space on the external backup drive, and this bigger one got parked rather than actioned. Same treatment when it happens: move to the external drive first, verify, then delete — not a straight delete.

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
