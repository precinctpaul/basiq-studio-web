"""Shared paths for the archive consolidation tooling.

Centralized so every script agrees on where the registry, the BioGuide
reference, and the working index database live.
"""

from pathlib import Path

REGISTRY_XLSX = Path(r"C:\Users\plcon\Desktop\CSPAN_YouTube_Master_Registry_v2.xlsx")
BIOGUIDE_CSV = Path(r"C:\Users\plcon\Downloads\congress_bioguide_data.csv")

LUCID_ROOT = Path(r"C:\Volumes\md-pac\media")
ELUVIO_POC = LUCID_ROOT / "Eluvio POC"
BASIQ_STUDIO_HUB = LUCID_ROOT / "Archive" / "Basiq-Studio-Hub"
CSPAN_ARCHIVE_FOLDERS = ELUVIO_POC / "CSPAN Archive"

CSPAN_DISCOVERY_ROOT = Path(r"C:\dev\cspan_discovery")
CSPAN_DISCOVERY_DB = CSPAN_DISCOVERY_ROOT / "data" / "cspan_discovery.sqlite3"

CSPAN_YOUTUBE_INDEXER_DB = Path(r"C:\dev\cspan-youtube-indexer\data\cspan_youtube_index.sqlite3")

TRANSCRIPTOR_ROOT = Path(r"C:\dev\transcriptor")
TRANSCRIPTOR_COLLECTED = TRANSCRIPTOR_ROOT / "collected_data"
TRANSCRIPTOR_CLEAN = TRANSCRIPTOR_ROOT / "clean_transcripts"

BASIQ_INGEST_ROOT = Path(r"C:\Majority Democrats\basiq_ingest")

TOOL_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = TOOL_DIR / "output"
INDEX_DB = OUTPUT_DIR / "enriched_index.sqlite3"
