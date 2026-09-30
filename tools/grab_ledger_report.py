"""Summarise tools' grab_ledger.jsonl (written by basiq_agent.run_grab).

Read-only; never contacts YouTube or anything else. Run on the droplet:

    cd /var/www/basiq-studio-web/tools && .venv/bin/python grab_ledger_report.py [--since HOURS]

Answers the questions single real grabs can't: is one proxy IP bad for video
(403 / bot-check) or captions (429)? How often does a grab need a retry? How
often do official captions survive vs. fall back to Whisper?
"""
from __future__ import annotations

import argparse
import collections
import json
import statistics
import time
from pathlib import Path

# Same files basiq_agent.py writes into its DATA_DIR -- this folder, on the
# droplet (not imported from basiq_agent: that import is heavy).
HERE = Path(__file__).resolve().parent
_GRAB_LEDGER_FILE = HERE / "grab_ledger.jsonl"
_PROXY_HEALTH_FILE = HERE / "proxy_health.json"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", type=float, default=0, help="only grabs from the last N hours")
    args = ap.parse_args()

    rows = []
    try:
        for line in _GRAB_LEDGER_FILE.read_text(encoding="utf-8").splitlines():
            try:
                rows.append(json.loads(line))
            except ValueError:
                pass
    except OSError:
        print(f"no ledger yet at {_GRAB_LEDGER_FILE}")
        return
    if args.since:
        cutoff = time.time() - args.since * 3600
        rows = [r for r in rows if r.get("started", 0) >= cutoff]
    if not rows:
        print("no grabs in range")
        return

    ok = [r for r in rows if r.get("result") == "Complete"]
    first_try = [r for r in ok if len(r.get("attempts", [])) == 1]
    print(f"grabs: {len(rows)}   complete: {len(ok)}   first-attempt: {len(first_try)}   "
          f"failed: {len(rows) - len(ok)}")
    if ok:
        secs = [r.get("total_secs", 0) for r in ok]
        print(f"time to complete: median {statistics.median(secs):.0f}s, max {max(secs):.0f}s")

    video = collections.defaultdict(collections.Counter)
    for r in rows:
        for a in r.get("attempts", []):
            video[a.get("proxy") or "?"][a.get("outcome") or "?"] += 1
    print("\nvideo attempts by route (outcome counts):")
    for label, c in sorted(video.items()):
        print(f"  {label:28s} " + "  ".join(f"{k}={v}" for k, v in c.most_common()))

    caps = collections.defaultdict(collections.Counter)
    results = collections.Counter()
    kinds = collections.Counter()
    for r in rows:
        cap = r.get("captions")
        if not cap:
            continue
        results[cap.get("result") or "?"] += 1
        if cap.get("kind"):
            kinds[cap["kind"]] += 1
        for t in cap.get("tries", []):
            caps[t.get("proxy") or "?"][t.get("outcome") or "?"] += 1
    if results:
        print("\ncaption results: " + "  ".join(f"{k}={v}" for k, v in results.most_common()))
        print("caption track kinds: " + "  ".join(f"{k}={v}" for k, v in kinds.most_common()))
        print("caption tries by route:")
        for label, c in sorted(caps.items()):
            print(f"  {label:28s} " + "  ".join(f"{k}={v}" for k, v in c.most_common()))

    try:
        health = json.loads(_PROXY_HEALTH_FILE.read_text(encoding="utf-8"))
        now = time.time()
        print("\ncurrent proxy health (benched = failed in the last 20 min):")
        for label, purposes in sorted(health.items()):
            for purpose, h in sorted(purposes.items()):
                age = now - h.get("last_fail", 0)
                state = f"BENCHED ({h.get('last_fail_kind')}, {age / 60:.0f} min ago)" if age < 20 * 60 else "ok"
                print(f"  {label:28s} {purpose:9s} ok={h.get('ok', 0)} fail={h.get('fail', 0)}  {state}")
    except (OSError, ValueError):
        pass


if __name__ == "__main__":
    main()
