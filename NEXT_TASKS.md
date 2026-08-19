# Next tasks

Follow-ups from the first round of install testing. #1 (ship a compiled
installer instead of a source zip) is done — see
[`tools/build/README.md`](tools/build/README.md) and
[`SETUP.md`](SETUP.md). These four are next, roughly in the order they'll
be felt:

## 2. The dependency chain is still fragile outside the installer

The new Windows installer sidesteps this — Python, FFmpeg-for-transcoding,
and every pip dependency are already frozen inside `Basiq-Agent-Setup.exe`.
But FFmpeg itself is *not* bundled (see #5 below, they're related): the
installer still checks `where ffmpeg` and tells people to
`winget install --id Gyan.FFmpeg -e` if it's missing, same as
`Basiq-Setup.bat` used to. And macOS has no compiled installer yet (Next
Task 1's build scaffolding exists but is untested — see
`tools/build/README.md`), so `Basiq-Setup.command` there still depends on
Homebrew installing cleanly.

**Fix:** once a mac build exists, freeze it the same way as Windows so
Homebrew is no longer a dependency at all. For FFmpeg on both platforms,
download a static build directly in the installer (or bundle it) instead of
relying on winget/brew — a real fix, not a documented workaround.

## 3. The visible console window is still how the agent runs

`basiq-agent.exe` (and the planned mac `.app`) still opens a console/Terminal
window that has to stay open. Closing it — which is the natural reflex when
tidying up a desktop — kills the agent, and the website then reports "Local
agent not running" with no obvious cause from the user's side.

**Fix:** run as a background process with a system tray icon (e.g. via
`pystray`), with "Open Studio" and "Quit" as the only two actions. This also
removes the mac console-window question from Next Task 1's `.app` build,
since a tray app has no equivalent doubt about what happens when you
"close" it.

## 4. The shared-drive path is still typed, not detected

The installer asks the shared-drive question once and remembers the answer,
which is better than editing `MEDIA_ROOT` by hand, but it's still a typed
path with a suggested default — drive letters and LucidLink mount points
still drift across machines and OS updates.

**Fix:** place a marker file (e.g. `.basiq-root`) at the root of the actual
LucidLink volume, and have the agent scan available drives for it at
startup. When found, set `MEDIA_ROOT` automatically and skip the question
entirely; fall back to asking only when no marker is found anywhere.

## 5. Missing AI models still fail silently until first use

`setup_models.py` pre-downloads ~1.5GB of models at install time, but a
network blip during that step is swallowed ("some models are missing;
they'll retry on first use") with no visible consequence until someone's
first transcription attempt appears to hang for minutes while a 1.2GB model
downloads in the background with no progress shown anywhere.

**Fix:** add a status field to `GET /health` reporting whether model weights
are actually cached on disk (not just whether the libraries are importable —
`/health` already reports `whisper`/`tagger`/`summarizer` as available based
on package presence, not cache presence). When they aren't, the web UI
should show a visible "Downloading AI models…" progress state instead of
looking broken.
