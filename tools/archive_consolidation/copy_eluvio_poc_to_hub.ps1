# One-off: copy the "good" Eluvio POC items' files (video + captions +
# metadata + transcripts, junk .part/.ytdl/.sha256 already excluded when the
# list was built) from the standalone "Eluvio POC" folder directly into the
# canonical LucidLink hub root (Archive\Basiq-Studio-Hub) -- flat, alongside
# everything else already there, not into a new "Eluvio POC\" subfolder.
# Per-item source folders reuse generic names (proxy.mp4, manifest.json,
# catalog_row.json, ...), so every destination filename is prefixed
# "<source>_<canonical_id>__<original name>" (falling back to the full
# relative path for the rare case where even that collides) to land flat
# without colliding with each other or the 25k+ files already in the hub --
# verified against both before this list was built. That's what the fixed
# archive detail route (app/api/archive/[id]/route.ts) expects: it only
# hands out a play link for files under Basiq-Studio-Hub itself, not the
# wider drive. Copy-only -- the Eluvio POC originals are never touched.
#
# Scope: only the 1,539 videos (and their ~6,267 sibling files) that already
# have both metadata and an available transcript -- the "good" half of the
# split. The 193 "bad" ones (unresolved / failed / missing transcript) stay
# put until those are fixed.
#
# SERIAL, deliberately: a 10-way parallel attempt at this same list wedged
# 9 of 10 worker processes hard enough that they wouldn't even die under
# Stop-Process -Force -- a sign LucidLink itself doesn't tolerate concurrent
# access well, not a bug in the copy logic. One file at a time avoided that
# entirely and made steady (if slow, ~33s/file) progress with zero failures.
# The list is pre-sorted video-first (see eluvio_poc_copy_list.csv) so the
# 1,539 videos that actually unblock playback land before the ~6,267
# sidecar files that don't.
#
# Skip-check only stats the DESTINATION now, comparing against the exact
# source byte size recorded in the list when it was built (size_bytes) --
# halves the round trips against LucidLink for every already-copied file
# versus stat'ing both sides every time this is resumed.
#
# Idempotent: skips a file if it already exists at the destination with a
# matching size, so this can be safely re-run if interrupted partway.
#
# IMPORTANT: after this finishes, full_path in the sqlite index (and
# therefore Supabase's archive_item_files) still points at the OLD Eluvio
# POC location -- run update_paths_after_eluvio_copy.py next, then re-run
# export_to_supabase.py (safe, upsert-only) to push the corrected paths.

$listPath = "C:\dev\basiq-studio-web\tools\archive_consolidation\output\eluvio_poc_copy_list.csv"
$logPath = "C:\dev\basiq-studio-web\tools\archive_consolidation\output\eluvio_poc_copy_log.txt"

$rows = Import-Csv -Path $listPath
$total = $rows.Count
$copied = 0
$skipped = 0
$failed = 0
$done = 0

"Starting SERIAL copy of $total files at $(Get-Date)" | Out-File -FilePath $logPath -Encoding utf8

foreach ($row in $rows) {
    $src = $row.source_path
    $dst = $row.dest_path
    $expectedSize = [int64]$row.size_bytes
    try {
        if (Test-Path $dst) {
            $dstSize = (Get-Item $dst).Length
            if ($dstSize -eq $expectedSize) {
                $skipped++
                $done++
                continue
            }
        }
        $dstDir = Split-Path $dst -Parent
        if (-not (Test-Path $dstDir)) {
            New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
        }
        Copy-Item -Path $src -Destination $dst -Force -ErrorAction Stop
        $copied++
    } catch {
        $failed++
        "FAILED: $src -- $($_.Exception.Message)" | Out-File -FilePath $logPath -Append -Encoding utf8
    }
    $done++
    if ($done % 25 -eq 0) {
        "progress: $done/$total (copied=$copied skipped=$skipped failed=$failed) at $(Get-Date)" | Out-File -FilePath $logPath -Append -Encoding utf8
    }
}

"DONE at $(Get-Date): copied=$copied skipped=$skipped failed=$failed total=$total" | Out-File -FilePath $logPath -Append -Encoding utf8
