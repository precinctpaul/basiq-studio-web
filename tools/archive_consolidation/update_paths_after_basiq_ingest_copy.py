"""Run this AFTER copy_basiq_ingest_to_lucidlink.ps1 finishes (or partway
through -- it only touches rows whose destination file actually exists on
disk).

copy_basiq_ingest_to_lucidlink.ps1 copies bytes only -- it never touches the
index. Once a file physically lands on Basiq-Studio-Hub, its full_path in
the `files` table (and therefore Supabase's archive_item_files, once
export_to_supabase.py is re-run) still points at the old local-only
C:\\Majority Democrats\\basiq_ingest location. Since the archive detail
route derives playability by checking whether full_path falls under
Basiq-Studio-Hub, a stale row would still show these items as unplayable
even after the copy succeeded.

Safe to re-run: only updates a row if its recorded full_path still matches
the pre-copy source path (a second run after paths are already updated is
a no-op), and only for rows whose destination file is confirmed present.

Usage:
    python update_paths_after_basiq_ingest_copy.py            # apply
    python update_paths_after_basiq_ingest_copy.py --dry-run  # report only
"""

import argparse

import config
import schema

COPY_LIST = config.OUTPUT_DIR / "basiq_ingest_copy_list.txt"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    con = schema.connect(config.INDEX_DB)

    updated, not_copied_yet, already_updated = 0, 0, 0
    with open(COPY_LIST, encoding="utf-8") as f:
        for name in f:
            name = name.strip()
            if not name:
                continue
            src = str(config.BASIQ_INGEST_ROOT / name)
            dst = config.BASIQ_STUDIO_HUB / name
            if not dst.is_file():
                not_copied_yet += 1
                continue
            (still_at_src,) = con.execute(
                "select count(*) from files where full_path = ?", (src,)
            ).fetchone()
            if not still_at_src:
                already_updated += 1
                continue
            if not args.dry_run:
                con.execute(
                    "update files set full_path = ? where full_path = ?",
                    (str(dst), src),
                )
            updated += 1

    if not args.dry_run:
        con.commit()
    con.close()

    print(f"{'would update' if args.dry_run else 'updated'}: {updated}")
    print(f"not copied yet (left as-is)         : {not_copied_yet}")
    print(f"already pointing at the hub          : {already_updated}")
    if updated and not args.dry_run:
        print("\nNow re-run export_to_supabase.py to push the corrected paths.")


if __name__ == "__main__":
    main()
