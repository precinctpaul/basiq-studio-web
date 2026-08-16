# Basiq local agent

Basiq Studio Hub does its heavy media work **on your own machine**: pulling
video with yt-dlp and transcribing it with Whisper. Neither can run on Vercel
— a C-SPAN hearing is hours long and hundreds of megabytes, and a serverless
function is capped at five minutes with no persistent disk. This agent is the
piece that does that work, and it's why your audio never leaves your computer.

## Setup

```bash
cd tools
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python basiq_agent.py
```

You should see:

```
Basiq agent listening on http://127.0.0.1:8000
  whisper: ready   yt-dlp: ready
```

Leave it running while you work. The web app points at `http://127.0.0.1:8000`
by default, so there's usually nothing to configure.

The first time you transcribe, the agent downloads the speech-to-text model
(~150MB) into `tools/whisper_cache/`. Every transcription after that is fully
offline.

## What it does

| Endpoint | Used by |
|---|---|
| `GET /health` | the app checking whether both engines are up |
| `POST /grab` | **GRAB** — yt-dlp downloads, then uploads straight to storage |
| `POST /capture` | **GO LIVE** — records a running stream with FFmpeg |
| `POST /jobs/<id>/stop` | the **STOP** button on a running capture |
| `GET /jobs/<id>` | the queue's live status and progress bar |
| `POST /transcribe` | **AI Transcribe** — faster-whisper, locally |
| `POST /probe` | deciding whether a pasted link is live |

A grab or capture never routes the media through your browser: the app hands
the agent a one-time signed upload URL and the agent PUTs the finished file
directly, so a multi-gigabyte hearing doesn't pass through the tab you're
working in.

## How live capture behaves

Paste a live URL and the button becomes **GO LIVE**. Two ways that happens:

- A direct `.m3u8`/`.mpd` manifest or an `rtmp://`/`srt://` address is
  recognised instantly, offline, with no network call at all.
- A watch page (YouTube, CBS News, C-SPAN) is ambiguous, so the button stays
  on GRAB and the agent is asked. If it comes back live, the button changes.
  It is never disabled while that check runs — pressing it always does the
  sensible thing for what's known right then.

Set **Stop after** to cap the recording in minutes, or leave it at `0` to
record until you press **STOP** in the queue. Both are supported and both end
the same way.

**Stopping is how a capture succeeds** — it is not a cancel. FFmpeg is asked
to close the file properly, the recording is remuxed to MP4, uploaded, and
transcribed if AI Transcribe is on.

Recordings land as MPEG-TS first and are converted to MP4 at the end. That is
deliberate: an MP4 keeps its index at the *end* of the file, so an MP4 that
was never closed cleanly — crash, power cut, closed laptop — is not a partial
video, it is an unplayable one. MPEG-TS carries its timing inline, so every
byte already written stays playable no matter how the recording ends. The
worst case is an awkward file, never a lost press conference.

## Options

All set as environment variables before starting the agent.

- **Bigger/better transcripts:** `WHISPER_MODEL=small` (or `medium`,
  `large-v3`). Default is `base`, matching the desktop build.
- **GPU:** `WHISPER_DEVICE=cuda` and `WHISPER_COMPUTE=float16` if you have an
  NVIDIA card. CPU is the default and runs roughly real-time on the base model.
- **Sites that need a login** (age-gated, members-only):
  `COOKIES_FROM_BROWSER=chrome` — also `firefox`, `edge`, `brave`. This is the
  same escape hatch as the desktop app's `cookies_from_browser` setting.
- **Port:** `PORT=8010` if 8000 is taken. Update the URL in the app to match.

## Notes

- **Only reachable from your own machine.** The agent binds `127.0.0.1`, so
  nothing on your network or the internet can talk to it.
- **YouTube** is fetched through yt-dlp's `android` player client. The default
  web client returns `403 Forbidden` on the actual media fetch even when the
  format list resolves fine — this is already handled, no action needed.
- **Live capture (`GO LIVE`) is not implemented yet.** Pasting a `.m3u8` or
  `rtmp://` link correctly flips the button, but pressing it reports that
  plainly rather than pretending to record.
