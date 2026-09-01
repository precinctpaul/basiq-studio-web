import os
import glob
import pandas as pd

# ==========================================
# Configuration & File Paths
# ==========================================
BASE_DIR = r"C:\dev\basiq-studio-web\tools\archive_consolidation\output"
FILTERED_CSVS_DIR = r"C:\Users\plcon\Desktop\FilteredCSVs"

ZERO_META_FILE = os.path.join(BASE_DIR, "gap_zero_metadata_file_detail.csv")
UNRESOLVED_FILE = os.path.join(BASE_DIR, "gap_unresolved_titled_file_detail.csv")

RESOLVED_ZERO_META_FILE = os.path.join(BASE_DIR, "gap_zero_metadata_file_detail.csv")
RESOLVED_UNRESOLVED_FILE = os.path.join(BASE_DIR, "gap_unresolved_titled_file_detail.csv")

# ==========================================
# Main Execution
# ==========================================
def main():
    # 1. Loading Gap CSV Files
    print("1. Loading gap CSV files...")
    print(f"   - Zero Meta File: {ZERO_META_FILE}")
    print(f"   - Unresolved File: {UNRESOLVED_FILE}")

    # Force all columns to be read as string/text type to prevent float64 cast errors
    df_zero = pd.read_csv(ZERO_META_FILE, dtype=str)
    df_unresolved = pd.read_csv(UNRESOLVED_FILE, dtype=str)

    # Convert all columns to string type explicitly and replace 'nan' text with empty string
    df_zero = df_zero.astype(str).replace('nan', '')
    df_unresolved = df_unresolved.astype(str).replace('nan', '')

    # 2. Indexing Metadata from FilteredCSVs
    print(f"\n2. Indexing metadata from {FILTERED_CSVS_DIR}...")
    lookup = {}

    csv_files = glob.glob(os.path.join(FILTERED_CSVS_DIR, "*.csv"))

    for csv_file in csv_files:
        try:
            df_temp = pd.read_csv(csv_file, dtype=str)
            df_temp = df_temp.astype(str).replace('nan', '')

            # Detect ID / Content ID column
            id_col = None
            for candidate in ['content_id', 'id', 'cid', 'URL Extension', 'video_id']:
                if candidate in df_temp.columns:
                    id_col = candidate
                    break

            if not id_col:
                continue

            for _, row in df_temp.iterrows():
                cid = str(row[id_col]).strip()
                if cid and cid not in lookup:
                    lookup[cid] = {
                        'title': row.get('title', row.get('URL', '')),
                        'description': row.get('description', ''),
                        'channel': row.get('channel', row.get('Channel', '')),
                        'person': row.get('person', row.get('Person', '')),
                        'bioguide_id': row.get('bioguide_id', row.get('BioGuide ID', ''))
                    }
        except Exception as e:
            print(f"   Error processing {csv_file}: {e}")

    print(f"   - Indexed metadata for {len(lookup)} unique IDs from FilteredCSVs.")

    # 3. Resolving Zero-Metadata Records
    print("\n3. Resolving zero-metadata records...")
    resolved_zero_count = 0

    id_col_zero = next((col for col in ['content_id', 'id', 'cid', 'URL Extension'] if col in df_zero.columns), None)

    if id_col_zero:
        for idx, row in df_zero.iterrows():
            cid = str(row[id_col_zero]).strip()
            if cid in lookup:
                data = lookup[cid]
                
                # Assign values safely into string-coerced dataframe
                if 'title' in df_zero.columns and data['title']:
                    df_zero.at[idx, 'title'] = data['title']
                if 'description' in df_zero.columns:
                    df_zero.at[idx, 'description'] = data['description']
                if 'channel' in df_zero.columns and data['channel']:
                    df_zero.at[idx, 'channel'] = data['channel']
                if 'person' in df_zero.columns and data['person']:
                    df_zero.at[idx, 'person'] = data['person']
                if 'bioguide_id' in df_zero.columns and data['bioguide_id']:
                    df_zero.at[idx, 'bioguide_id'] = data['bioguide_id']
                
                resolved_zero_count += 1

    print(f"   - Resolved {resolved_zero_count} zero-metadata records.")

    # 4. Resolving Unresolved-Titled Records
    print("\n4. Resolving unresolved-titled records...")
    resolved_unresolved_count = 0

    id_col_unresolved = next((col for col in ['content_id', 'id', 'cid', 'URL Extension'] if col in df_unresolved.columns), None)

    if id_col_unresolved:
        for idx, row in df_unresolved.iterrows():
            cid = str(row[id_col_unresolved]).strip()
            if cid in lookup:
                data = lookup[cid]

                if 'title' in df_unresolved.columns and data['title']:
                    df_unresolved.at[idx, 'title'] = data['title']
                if 'description' in df_unresolved.columns:
                    df_unresolved.at[idx, 'description'] = data['description']
                if 'channel' in df_unresolved.columns and data['channel']:
                    df_unresolved.at[idx, 'channel'] = data['channel']
                if 'person' in df_unresolved.columns and data['person']:
                    df_unresolved.at[idx, 'person'] = data['person']
                if 'bioguide_id' in df_unresolved.columns and data['bioguide_id']:
                    df_unresolved.at[idx, 'bioguide_id'] = data['bioguide_id']

                resolved_unresolved_count += 1

    print(f"   - Resolved {resolved_unresolved_count} unresolved-titled records.")

    # 5. Saving Updated Files
    print("\n5. Saving updated CSV files...")
    df_zero.to_csv(RESOLVED_ZERO_META_FILE, index=False)
    df_unresolved.to_csv(RESOLVED_UNRESOLVED_FILE, index=False)

    print(f"   - Saved: {RESOLVED_ZERO_META_FILE}")
    print(f"   - Saved: {RESOLVED_UNRESOLVED_FILE}")
    print("\nMetadata resolution complete!")

if __name__ == "__main__":
    main()