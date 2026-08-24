import os
import json
import uuid
from pathlib import Path
from supabase import create_client, Client

# --- CONFIGURATION ---
SUPABASE_URL = "https://tijwokimlrglufjqiwok.supabase.co"
# STOP! Replace the key below with your SUPABASE_SERVICE_ROLE_KEY from .env.local
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRpandva2ltbHJnbHVmanFpd29rIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NjgyMDQ0OSwiZXhwIjoyMTAyMzk2NDQ5fQ.vD586cg84F9LuNRb7AegIiu5Cn843wezSKmnX23Q1pw"

# The root where the agent mounts the drive
AGENT_MEDIA_ROOT = Path(r"C:\Volumes\md-pac\media")
# The specific folder you want to scan today
SCAN_TARGET = Path(r"C:\Volumes\md-pac\media\Archive\Basiq-Studio-Hub")
BATCH_SIZE = 500

def get_media_file(base_path: Path, base_name: str) -> Path:
    """Finds the matching video file for a given info.json"""
    for ext in ['.mp4', '.mkv', '.webm', '.m4v', '.mov', '.ts', '.m4a']:
        candidate = base_path / f"{base_name}{ext}"
        if candidate.exists():
            return candidate
    return None

def main():
    print("Connecting to Supabase...")
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
    
    print(f"Scanning directory: {SCAN_TARGET}")
    # Using rglob to recursively find files in subfolders
    info_files = list(SCAN_TARGET.rglob("*.info.json"))
    total_files = len(info_files)
    print(f"Found {total_files} .info.json files. Starting ingestion...")

    records = []
    inserted_count = 0

    for index, info_path in enumerate(info_files):
        base_name = info_path.name.replace(".info.json", "")
        
        # 1. Check if the actual video file exists next to the JSON
        full_media_path = get_media_file(info_path.parent, base_name)
        if not full_media_path:
            print(f"Skipping {info_path.name} - No matching media file found.")
            continue

        # 2. Calculate the path relative to the agent's media root
        try:
            local_path = full_media_path.relative_to(AGENT_MEDIA_ROOT).as_posix()
        except ValueError:
            print(f"Skipping {info_path.name} - Not inside AGENT_MEDIA_ROOT.")
            continue

        # 3. Extract metadata
        try:
            with open(info_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except Exception as e:
            print(f"Error reading {info_path.name}: {e}")
            continue

        # 4. Format to match the Supabase 'videos' table schema
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

        # 5. Insert in batches
        if len(records) >= BATCH_SIZE or (index == total_files - 1):
            if not records:
                continue
            try:
                supabase.table("videos").insert(records).execute()
                inserted_count += len(records)
                print(f"Inserted {inserted_count}/{total_files} records...")
                records = []
            except Exception as e:
                print(f"Batch insert failed! Error: {e}")

    print(f"\nIngestion Complete! Successfully injected {inserted_count} videos into the database.")

if __name__ == "__main__":
    main()