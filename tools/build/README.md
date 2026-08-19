# Building the Basiq Agent installer

Replaces the old "copy a zip, extract it, hope the `.bat`/`.command` inside
runs" install with a single compiled installer. Nobody needs Python, pip, a
venv, or to remember to tick "Add to PATH" — `basiq_agent.py` and its whole
dependency chain (faster-whisper, yt-dlp, torch, spaCy, keybert,
sentence-transformers) are frozen into the executable by PyInstaller.

## Windows — built and tested

```
tools\build\build_windows.bat
```

Produces `tools\build\installer_output\Basiq-Agent-Setup.exe`. That single
file is everything a teammate needs: double-click it, answer one question
(where's the shared drive — pre-filled with a sensible default), done. No
admin rights required — it installs to `%LocalAppData%\BasiqAgent`.

Verified end-to-end in this repo: built, silently installed to a scratch
directory, confirmed the installed `basiq-agent.exe` serves `/health`, runs
real Whisper transcription, and does spaCy/KeyBERT tagging — then uninstalled
and confirmed the Start Menu entry, Desktop shortcut, and registry key were
all removed cleanly.

Two non-obvious things the build depends on, both already handled:

- **Onedir, not onefile.** The dependency chain is 2-3GB installed. A onefile
  build re-extracts that whole payload to a temp directory on every launch —
  several gigabytes copied before the agent could even bind its port. Onedir
  unpacks once, at install time.
- **pyinstaller-hooks-contrib.** torch, spaCy, thinc and transformers each do
  their own registry- or metadata-driven dynamic loading that PyInstaller's
  static import scanner can't see on its own. The hooks package ships vetted
  fixes for exactly these libraries; `basiq_agent.spec` collects a further
  explicit set (`en_core_web_sm`, `yt_dlp`, `faster_whisper`, `ctranslate2`,
  `sentence_transformers`, `huggingface_hub`, `keybert`) that have no
  upstream hook, or — `en_core_web_sm` — are never imported by a literal name
  a static scanner could find at all.

## macOS — written, NOT tested

`basiq_agent_macos.spec` and `build_macos.sh` exist but were authored on a
Windows machine with no Mac available to run them. PyInstaller cannot
cross-compile: a `.app` has to be built by running PyInstaller *on* macOS,
against a venv where pip has resolved the macOS wheels of every dependency —
none of what built the Windows `.exe` carries over. Whoever picks this up on
an actual Mac should expect to spend time here, and specifically check:

- **`BUNDLE(..., console=True)` behaviour.** The spec wraps the onedir build
  in a `.app` so Finder treats it as a real app, and asks PyInstaller's
  console-app-in-a-bundle mode to open Terminal.app on launch (the closest
  mac equivalent of the Windows build's visible console window — see Next
  Tasks below for the tray-icon follow-up that removes the need for a visible
  window on both platforms). This is documented PyInstaller behavior, never
  actually clicked.
- **Gatekeeper.** `build_macos.sh` ad-hoc signs the app
  (`codesign --sign -`) so it isn't flagged as fully unsigned, but that is
  *not* notarization — first launch will still need right-click → Open, same
  as `Basiq-Setup.command` requires today. Full notarization needs a paid
  Apple Developer account and is out of scope here.
- **Where the mac hook coverage differs.** pyinstaller-hooks-contrib's
  torch/spaCy/transformers hooks are cross-platform, but binary-collection
  edge cases (e.g. ctranslate2's bundled `.dylib`s vs Windows `.dll`s) are
  exactly the kind of thing that only shows up by actually running the build.
- **The `DATA_DIR` split in `basiq_agent.py`.** Windows writes its
  `hf_cache`/`whisper_cache`/`media_root.txt` beside the `.exe`, which is
  normal there. On macOS a frozen build instead uses
  `~/Library/Application Support/BasiqAgent`, because those live *inside*
  the signed `.app` on the exe-relative path, and writing runtime data into
  a signed bundle is exactly what Gatekeeper expects apps not to do. This
  was a straightforward source-level fix but has no Mac to confirm it
  against.

Once someone has a Mac to iterate on, treat the first build the same way the
Windows one was actually done: build, run it, see what PyInstaller's error
tells you, add the missing `collect_all`/hidden import, rebuild. That loop is
what got the Windows build working — there's no substitute for it here.

## Rebuilding after a change to `basiq_agent.py`

Windows: `tools\build\build_windows.bat` again — PyInstaller only re-analyzes
what changed, so an incremental rebuild is fast. Then re-run
`installer.iss` if you didn't use the batch file (it does this for you).

macOS: `tools/build/build_macos.sh` again, once someone's set up to test it.

## Known trade-off carried over from the source install

FFmpeg is still not bundled — the installer just checks whether it's on PATH
after installing and tells you to grab it via winget/brew if not, same
message `Basiq-Setup.bat` used to show. Bundling FFmpeg is tracked
separately (see the web app's SETUP.md / project Next Tasks) since it's a
different problem: a static binary to fetch and ship, not a Python packaging
one.
