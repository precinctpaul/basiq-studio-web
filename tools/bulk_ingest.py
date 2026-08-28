import os
import json
import uuid
from pathlib import Path
from supabase import create_client, Client

# --- CONFIGURATION ---
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "https://tijwokimlrglufjqiwok.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
if not SUPABASE_KEY:
    raise SystemExit("SUPABASE_SERVICE_ROLE_KEY must be set in the environment (see .env.local).")

# The root where the agent mounts the drive
AGENT_MEDIA_ROOT = Path(r"C:\Volumes\md-pac\media")

# CONFIRMED CANONICAL LOCATION: every video considered part of this project
# lives here, or eventually will. Files elsewhere (Eluvio POC, local
# staging folders, etc.) get moved in here over time — this script only
# ever needs to look here, now and in future runs.
SCAN_TARGET = Path(r"C:\Volumes\md-pac\media\Archive\Basiq-Studio-Hub")
BATCH_SIZE = 500
PAGE_SIZE = 1000


def get_media_file(base_path: Path, base_name: str) -> Path:
    """Finds the matching video file for a given info.json"""
    for ext in ['.mp4', '.mkv', '.webm', '.m4v', '.mov', '.ts', '.m4a']:
        candidate = base_path / f"{base_name}{ext}"
        if candidate.exists():
            return candidate
    return None


def fetch_existing_filenames(supabase: Client) -> set:
    """SAFE-TO-RERUN GUARD, filename-based rather than exact-path. The
    project has (at least) two local_path conventions in use — bare
    filename vs. the full Archive/Basiq-Studio-Hub/... prefix — depending
    on which tool originally ingested a given row. An exact-string
    comparison silently lets duplicates through whenever the same file
    is recorded under a different convention than this script uses;
    comparing by filename alone closes that gap regardless of prefix."""
    names = set()
    page = 0
    while True:
        res = (
            supabase.table("videos")
            .select("local_path")
            .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
            .execute()
        )
        batch = res.data or []
        for r in batch:
            lp = r.get("local_path")
            if lp:
                names.add(lp.split("/")[-1])
        if len(batch) < PAGE_SIZE:
            break
        page += 1
    return names


def main():
    print("Connecting to Supabase...")
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

    print("Loading already-ingested filenames (so this run only adds what's new)...")
    existing_names = fetch_existing_filenames(supabase)
    print(f"  {len(existing_names)} videos already in the database.")

    print(f"Scanning directory: {SCAN_TARGET}")
    info_files = list(SCAN_TARGET.rglob("*.info.json"))
    total_files = len(info_files)
    print(f"Found {total_files} .info.json files. Starting ingestion...")

    records = []
    inserted_count = 0
    skipped_existing = 0
    skipped_no_media = 0

    for index, info_path in enumerate(info_files):
        base_name = info_path.name.replace(".info.json", "")

        full_media_path = get_media_file(info_path.parent, base_name)
        if not full_media_path:
            skipped_no_media += 1
            continue

        try:
            local_path = full_media_path.relative_to(AGENT_MEDIA_ROOT).as_posix()
        except ValueError:
            print(f"Skipping {info_path.name} - Not inside AGENT_MEDIA_ROOT.")
            continue

        if full_media_path.name in existing_names:
            skipped_existing += 1
            continue

        try:
            with open(info_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except Exception as e:
            print(f"Error reading {info_path.name}: {e}")
            continue

        record = {
            "id": str(uuid.uuid4()),
            "title": data.get("title", "Untitled").strip(),
            "duration_seconds": data.get("duration", 0),
            "uploader": data.get("uploader", "")[:255],
            "channel": data.get("channel", "")[:255],
            "status": "ready",
            "local_path": local_path,
            "created_at": f"{data.get('upload_date', '20240101')[:4]}-{data.get('upload_date', '20240101')[4:6]}-{data.get('upload_date', '20240101')[6:]}T00:00:00Z" if data.get('upload_date') else None
        }

        records.append(record)

        if len(records) >= BATCH_SIZE or (index == total_files - 1):
            if not records:
                continue
            try:
                supabase.table("videos").insert(records).execute()
                inserted_count += len(records)
                print(f"  ...{inserted_count} new videos inserted so far ({index + 1}/{total_files} files scanned)")
                records = []
            except Exception as e:
                print(f"Batch insert failed! Error: {e}")

    print(f"\nIngestion Complete!")
    print(f"  Newly inserted:          {inserted_count}")
    print(f"  Already in DB (skipped): {skipped_existing}")
    print(f"  No matching media file:  {skipped_no_media}  (an .info.json with no video file next to it)")


if __name__ == "__main__":
    main()
