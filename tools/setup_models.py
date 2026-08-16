"""
setup_models.py — pull every model down once, at install time.

Without this the first transcription looks like a hang: faster-whisper,
spaCy and the sentence embedder each fetch hundreds of megabytes on first
use, with no progress reported anywhere the operator can see. Doing it here
means the install is the slow step (where a wait is expected) and every later
action is fast.

Safe to re-run: everything is cached, so a second run is a no-op.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Importing the agent applies its Hugging Face cache configuration, which is
# load-bearing on Windows — the default cache location under %USERPROFILE% is
# unwritable on some machines and aborts downloads outright.
import basiq_agent  # noqa: E402  (import order is deliberate)


def step(label: str, fn) -> bool:
    print(f"  {label}…", flush=True)
    try:
        fn()
        print(f"    done.", flush=True)
        return True
    except Exception as exc:  # noqa: BLE001 — report and continue
        print(f"    could not finish: {exc}", flush=True)
        return False


def main() -> int:
    print("\nDownloading models into", basiq_agent.HF_CACHE, "\n", flush=True)
    ok = True

    ok &= step("Speech recognition (Whisper)", lambda: basiq_agent.get_model())
    ok &= step("Entity tagger (spaCy)", lambda: basiq_agent.load_spacy())
    ok &= step("Keyphrase model", lambda: basiq_agent.load_keybert())
    ok &= step("Headline selector", lambda: basiq_agent.load_embedder())

    print("\nAll set." if ok else "\nSome models are missing; they'll retry on first use.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
