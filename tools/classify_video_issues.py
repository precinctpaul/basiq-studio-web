"""Classify a sample of Library videos into a fixed "Member Issue" taxonomy,
using a LOCAL model (Ollama) rather than a paid API -- see HANDOFF.md's
2026-09-10 entry for why: the real auto-tag data turned out to be ~6,862
distinct raw NLP keyphrases (not a clean 57-term list), so a real filter
dropdown needs each video actually CLASSIFIED into a small taxonomy, not
existing tag strings merged/renamed.

Two modes:

  - Default (no --write): the VALIDATION pass. Samples --limit random
    videos, classifies them, writes the result to a JSON file (plus a
    readable console summary) so a human can eyeball the taxonomy and the
    model's calls. Makes zero writes to Supabase.
  - --write: the REAL run. Classifies every video that doesn't already have
    an `issue`-kind tag, and writes each result as a real row in the
    existing `tags` table (kind="issue", source="auto") -- a new, clean
    lane alongside the existing messy kind="topics" auto-tags, left
    untouched. Resumable by construction: it re-derives "what's left" from
    the database itself on every run (which video ids already have an
    issue tag) rather than trusting a separate progress file, same lesson
    learned the hard way in transcribe_remaining.py (2026-09-08) -- so a
    crash or interruption partway through just means running it again.

Setup (one-time): Ollama installed via winget, model pulled with
    ollama pull qwen2.5:14b-instruct
Ollama's own background service runs automatically after install
(http://localhost:11434) -- nothing else to start.

Usage:
    python classify_video_issues.py                    (60 random videos, dry)
    python classify_video_issues.py --limit 100 --seed 7
    python classify_video_issues.py --write             (real run, all remaining videos)
    python classify_video_issues.py --write --max-write 10   (small real-write smoke test)
"""

import argparse
import datetime
import json
import os
import random
import sys
import time
import urllib.request
from pathlib import Path

from supabase import create_client

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# --- CONFIGURATION -----------------------------------------------------
ENV_PATH = Path(__file__).resolve().parent.parent / ".env.local"
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
TRANSCRIPT_EXCERPT_CHARS = 3000  # median full_text is ~1,930 chars -- this
# covers most videos in full and gives the long tail (some run past 300K
# chars) a meaningful front excerpt instead of the whole thing.

# Draft taxonomy, grounded in the REAL auto-tag data pulled from Supabase
# tonight (6,862 distinct "topics" tags), not guessed from first principles.
# A meaningful chunk of that raw data is congressional PROCEDURE boilerplate
# ("unanimous consent", "morning hour debate", "electronic device") rather
# than a substantive issue -- hence its own category below instead of
# forcing it into "Other" or into a real issue bucket it doesn't belong in.
# This list is a DRAFT for review, not a final answer -- expected to change
# once a human looks at real classification results against it.
CATEGORIES = {
    "Economy, Jobs & Cost of Living": "Inflation, affordability, wages, tariffs/trade, small business, labor, taxes.",
    "Housing & Homelessness": "Housing costs, affordable housing policy, homelessness.",
    "Transportation & Infrastructure": "Roads, bridges, aviation, rail, transit, NTSB/DOT/FAA matters, infrastructure spending and construction projects.",
    "Healthcare & Public Health": "Health insurance, drug pricing, public health, Medicare/Medicaid.",
    "Immigration & Border Security": "Border policy, asylum, deportation, visas.",
    "Public Safety, Crime & Justice": "Policing, crime, courts, criminal justice reform, gun policy.",
    "National Security, Defense & Foreign Policy": "Military, wars/conflicts abroad, diplomacy, terrorism, intelligence.",
    "Environment, Energy & Climate": "Climate policy, energy production, natural disasters, public lands.",
    "Technology & AI": "AI policy/governance, tech regulation, data privacy, cybersecurity.",
    "Agriculture & Rural Affairs": "Farming, rural economic development, agriculture policy.",
    "Elections & Political Process": "Campaigns, voting policy, election administration, redistricting.",
    "Government Shutdown, Budget & Appropriations": "Federal budget, spending bills, shutdown fights, debt ceiling.",
    "Congressional Procedure": "Floor votes, unanimous consent, parliamentary/procedural business with no substantive policy content.",
    "Civil Rights & Social Issues": "Civil rights, LGBTQ+ issues, reproductive rights, discrimination.",
    "Veterans & Military Affairs": "Veterans' benefits, VA policy, servicemember issues (domestic side, not foreign deployments).",
    "Education": "K-12 and higher education policy, student loans, school funding.",
    "Other": "Doesn't clearly fit any category above, or too generic/ceremonial to classify (e.g. a tribute, an intro, ambient B-roll).",
}

SYSTEM_PROMPT = f"""You are tagging a C-SPAN/political video archive with a FIXED set of issue categories, for a filter dropdown. You do not invent new categories.

Categories (name: what it covers):
{chr(10).join(f'- {name}: {desc}' for name, desc in CATEGORIES.items())}

Given a video's title, its existing (often messy, auto-extracted) tags, and an excerpt of its transcript, choose the 1-4 categories that best describe what the video is actually ABOUT -- not just words it happens to mention in passing. Use "Other" alone if nothing substantive fits.

Respond with ONLY a JSON object of this exact shape, no other text:
{{"categories": ["Category Name", "Category Name"]}}"""


def load_env() -> dict:
    env = {}
    with open(ENV_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def chunked(seq: list, size: int):
    for i in range(0, len(seq), size):
        yield seq[i : i + size]


def retry(fn, attempts=3, delay=2, label="operation"):
    last_err = None
    for i in range(attempts):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001 -- a multi-hour unattended
            # batch must never die on one flaky network call; log and retry
            # rather than let a transient blip take the whole run down.
            last_err = e
            if i < attempts - 1:
                time.sleep(delay * (i + 1))
    print(f"    !! {label} failed after {attempts} attempts: {last_err}")
    return None


def fetch_all_video_ids(sb) -> list:
    ids = []
    page = 0
    page_size = 1000
    while True:
        res = (
            sb.table("videos")
            .select("id")
            .range(page * page_size, page * page_size + page_size - 1)
            .execute()
        )
        rows = res.data or []
        ids.extend(r["id"] for r in rows)
        if len(rows) < page_size:
            break
        page += 1
    return ids


def fetch_ids_with_issue_tags(sb) -> set:
    """Every video id that already has a kind="issue" tag -- the resume
    marker for --write mode. Re-derived from the database itself on every
    run rather than a separate progress file (see the module docstring)."""
    ids = set()
    page = 0
    page_size = 1000
    while True:
        res = (
            sb.table("tags")
            .select("video_id")
            .eq("kind", "issue")
            .range(page * page_size, page * page_size + page_size - 1)
            .execute()
        )
        rows = res.data or []
        ids.update(r["video_id"] for r in rows)
        if len(rows) < page_size:
            break
        page += 1
    return ids


def classify_one(video: dict) -> dict:
    tags_str = ", ".join(video["tags"]) if video["tags"] else "(none)"
    transcript_excerpt = (video["transcript"] or "")[:TRANSCRIPT_EXCERPT_CHARS]
    transcript_note = transcript_excerpt if transcript_excerpt.strip() else "(no transcript available)"

    user_prompt = (
        f"Title: {video['title']}\n"
        f"Existing tags: {tags_str}\n"
        f"Transcript excerpt:\n{transcript_note}"
    )

    payload = {
        "model": video["model"],
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        "format": "json",
        "stream": False,
        "options": {"temperature": 0.1},
    }
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/chat",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        body = json.loads(resp.read().decode("utf-8"))

    raw = body.get("message", {}).get("content", "")
    try:
        parsed = json.loads(raw)
        picked = parsed.get("categories", [])
    except (json.JSONDecodeError, AttributeError):
        return {"categories": [], "raw_error": raw}

    valid = [c for c in picked if c in CATEGORIES]
    dropped = [c for c in picked if c not in CATEGORIES]
    return {"categories": valid, "dropped_invalid": dropped}


def run_write_mode(sb, args):
    CHUNK = 200  # same cap app/api/library/route.ts already uses for
    # `.in.(...)` filters -- PostgREST rejects a URL built from too many ids
    # at once (confirmed 2026-09-09), so every id-scoped fetch/write below
    # stays chunked rather than passing the whole remaining list in one call.

    print("Fetching all video ids...")
    all_ids = retry(lambda: fetch_all_video_ids(sb), attempts=5, delay=5, label="fetch all video ids")
    if all_ids is None:
        print("Could not fetch the video id list after retries -- nothing to do, exiting.")
        return
    print(f"  {len(all_ids)} total videos in the library.")

    print("Checking which videos are already classified (resume support)...")
    already_done = retry(
        lambda: fetch_ids_with_issue_tags(sb), attempts=5, delay=5, label="fetch already-classified ids"
    )
    if already_done is None:
        print("Could not fetch the resume set after retries -- exiting rather than risk reclassifying everything.")
        return
    remaining = [vid for vid in all_ids if vid not in already_done]
    print(f"  {len(already_done)} already classified, {len(remaining)} remaining.")

    if args.max_write is not None:
        remaining = remaining[: args.max_write]
        print(f"  --max-write given, capping this run to {len(remaining)} videos.")

    if not remaining:
        print("Nothing left to classify.")
        return

    session_dir = Path(__file__).parent / f"session-{datetime.date.today()}"
    session_dir.mkdir(parents=True, exist_ok=True)
    failures_path = session_dir / "full_classification_failures.json"
    failures = []

    start = time.time()
    done = 0
    total = len(remaining)

    for chunk_ids in chunked(remaining, CHUNK):
        videos_res = retry(
            lambda: sb.table("videos").select("id, title").in_("id", chunk_ids).execute(),
            label="fetch videos chunk",
        )
        tags_res = retry(
            lambda: sb.table("tags").select("video_id, label").in_("video_id", chunk_ids).execute(),
            label="fetch tags chunk",
        )
        transcripts_res = retry(
            lambda: sb.table("transcripts").select("video_id, full_text").in_("video_id", chunk_ids).execute(),
            label="fetch transcripts chunk",
        )
        if videos_res is None:
            continue  # already logged by retry(); this chunk's videos stay
            # "remaining" on the next --write invocation since none of them
            # got an issue tag written.

        tags_by_video = {}
        for t in (tags_res.data if tags_res else []) or []:
            tags_by_video.setdefault(t["video_id"], []).append(t["label"])
        transcript_by_video = {t["video_id"]: t["full_text"] for t in (transcripts_res.data if transcripts_res else []) or []}

        rows_to_write = []
        for v in videos_res.data or []:
            video = {
                "id": v["id"],
                "title": v["title"] or "Untitled",
                "tags": tags_by_video.get(v["id"], []),
                "transcript": transcript_by_video.get(v["id"]),
                "model": args.model,
            }
            result = retry(lambda: classify_one(video), attempts=2, label=f"classify {video['id']}") or {
                "categories": [],
                "raw_error": "classify_one failed after retries",
            }
            done += 1
            cats = result.get("categories") or []
            if not cats:
                failures.append({"id": video["id"], "title": video["title"], "error": result.get("raw_error")})
            rows_to_write.extend(
                {"video_id": video["id"], "label": c, "source": "auto", "kind": "issue"} for c in cats
            )

            if done % 25 == 0 or done == total:
                elapsed = time.time() - start
                rate_per_min = done / elapsed * 60 if elapsed > 0 else 0
                eta_min = (total - done) / rate_per_min if rate_per_min > 0 else float("inf")
                print(
                    f"[{done}/{total}] {video['title'][:60]:<60} -> {', '.join(cats) or '(none)'}  "
                    f"({rate_per_min:.1f}/min, ~{eta_min:.0f} min left)"
                )

        if rows_to_write:
            retry(
                lambda: sb.table("tags").upsert(rows_to_write, on_conflict="video_id,label").execute(),
                label=f"write {len(rows_to_write)} issue tags",
            )

        # Written after every chunk, not just at the end, so a crash
        # partway through doesn't lose the failure list gathered so far.
        failures_path.write_text(json.dumps(failures, indent=2), encoding="utf-8")

    elapsed_total = time.time() - start
    print(
        f"\nDone. {done} videos classified in {elapsed_total / 60:.1f} minutes, "
        f"{len(failures)} produced zero categories (see {failures_path})."
    )


def run_validation_mode(sb, args):
    if args.seed is not None:
        random.seed(args.seed)

    print("Fetching all video ids for a uniform random sample...")
    all_ids = fetch_all_video_ids(sb)
    print(f"  {len(all_ids)} total videos in the library.")
    sample_ids = random.sample(all_ids, min(args.limit, len(all_ids)))

    print(f"Fetching details for {len(sample_ids)} sampled videos...")
    videos_res = sb.table("videos").select("id, title").in_("id", sample_ids).execute()
    tags_res = sb.table("tags").select("video_id, label").in_("video_id", sample_ids).execute()
    transcripts_res = (
        sb.table("transcripts").select("video_id, full_text").in_("video_id", sample_ids).execute()
    )

    tags_by_video = {}
    for t in tags_res.data or []:
        tags_by_video.setdefault(t["video_id"], []).append(t["label"])
    transcript_by_video = {t["video_id"]: t["full_text"] for t in transcripts_res.data or []}

    videos = [
        {
            "id": v["id"],
            "title": v["title"] or "Untitled",
            "tags": tags_by_video.get(v["id"], []),
            "transcript": transcript_by_video.get(v["id"]),
            "model": args.model,
        }
        for v in (videos_res.data or [])
    ]

    print(f"Classifying {len(videos)} videos with {args.model} (local, via Ollama)...\n")
    results = []
    for i, v in enumerate(videos, 1):
        result = classify_one(v)
        results.append(
            {
                "id": v["id"],
                "title": v["title"],
                "existing_tags": v["tags"],
                "had_transcript": bool(v["transcript"]),
                **result,
            }
        )
        cats = ", ".join(result.get("categories") or ["(none)"])
        print(f"[{i}/{len(videos)}] {v['title'][:70]:<70}  ->  {cats}")
        if result.get("dropped_invalid"):
            print(f"    (model invented off-list categories, dropped: {result['dropped_invalid']})")
        if "raw_error" in result:
            print(f"    (failed to parse model output: {result['raw_error'][:200]!r})")

    out_path = Path(args.out) if args.out else Path(__file__).parent / f"session-{datetime.date.today()}" / "classification_validation.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({"categories": CATEGORIES, "results": results}, indent=2), encoding="utf-8")

    no_transcript = sum(1 for r in results if not r["had_transcript"])
    no_category = sum(1 for r in results if not r.get("categories"))
    print(f"\nDone. {len(results)} videos classified, {no_transcript} had no transcript, "
          f"{no_category} got zero valid categories back.")
    print(f"Full results written to {out_path}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--limit", type=int, default=60, help="Validation mode only: how many random videos to sample")
    parser.add_argument("--seed", type=int, default=None, help="Validation mode only: random seed, for a reproducible sample")
    parser.add_argument("--model", default="qwen2.5:14b-instruct")
    parser.add_argument(
        "--out",
        default=None,
        help="Validation mode only: output JSON path (default: tools/session-<today>/classification_validation.json)",
    )
    parser.add_argument(
        "--write",
        action="store_true",
        help="Real run: classify every not-yet-classified video and write kind=\"issue\" tags to Supabase.",
    )
    parser.add_argument(
        "--max-write",
        type=int,
        default=None,
        help="--write mode only: cap how many videos this invocation processes (for a small real-write smoke test).",
    )
    args = parser.parse_args()

    env = load_env()
    sb = create_client(env["NEXT_PUBLIC_SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"])

    if args.write:
        run_write_mode(sb, args)
    else:
        run_validation_mode(sb, args)


if __name__ == "__main__":
    main()
