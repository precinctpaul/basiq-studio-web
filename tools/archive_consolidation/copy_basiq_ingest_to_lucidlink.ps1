# One-off: copy the 442 archive items' files (video + metadata + captions,
# skipping .part/.ytdl junk) from the legacy local-only C:\Majority
# Democrats\basiq_ingest folder onto the shared LucidLink drive, so they
# become reachable by the agent's /media/* proxy (and therefore playable in
# the Archive view) from any machine, not just this one. Copy-only, per the
# project's original rule -- the local originals are never touched.
#
# Idempotent: skips a file if it already exists at the destination with a
# matching size, so this can be safely re-run if interrupted partway.
#
# Time-boxed: pass -MaxMinutes to cap how long a single invocation runs (it
# still finishes copying whichever file is in progress, then stops cleanly).
# Re-run the same command to pick up where it left off -- skip-by-size makes
# that safe. Omit -MaxMinutes to run until every file is done.

param(
    [int]$MaxMinutes = 0
)

$sourceDir = "C:\Majority Democrats\basiq_ingest"
$destDir = "C:\Volumes\md-pac\media\Archive\Basiq-Studio-Hub"
$listPath = "C:\dev\basiq-studio-web\tools\archive_consolidation\output\basiq_ingest_copy_list.txt"
$logPath = "C:\dev\basiq-studio-web\tools\archive_consolidation\output\basiq_ingest_copy_log.txt"

$files = Get-Content $listPath
$total = $files.Count
$copied = 0
$skipped = 0
$failed = 0
$done = 0
$startTime = Get-Date
$timeBoxed = $MaxMinutes -gt 0

"Resuming copy run of $total files at $startTime$(if ($timeBoxed) { " (time-boxed to $MaxMinutes min)" })" | Out-File -FilePath $logPath -Append -Encoding utf8

foreach ($name in $files) {
    $src = Join-Path $sourceDir $name
    $dst = Join-Path $destDir $name
    try {
        if (Test-Path $dst) {
            $srcSize = (Get-Item $src).Length
            $dstSize = (Get-Item $dst).Length
            if ($srcSize -eq $dstSize) {
                $skipped++
                $done++
                continue
            }
        }
        Copy-Item -Path $src -Destination $dst -Force -ErrorAction Stop
        $copied++
    } catch {
        $failed++
        "FAILED: $name -- $($_.Exception.Message)" | Out-File -FilePath $logPath -Append -Encoding utf8
    }
    $done++
    if ($done % 25 -eq 0) {
        "progress: $done/$total (copied=$copied skipped=$skipped failed=$failed) at $(Get-Date)" | Out-File -FilePath $logPath -Append -Encoding utf8
    }
    if ($timeBoxed -and ((Get-Date) - $startTime).TotalMinutes -ge $MaxMinutes) {
        "PAUSED (time box reached) at $(Get-Date): copied=$copied skipped=$skipped failed=$failed done=$done/$total -- re-run to resume" | Out-File -FilePath $logPath -Append -Encoding utf8
        exit
    }
}

"DONE at $(Get-Date): copied=$copied skipped=$skipped failed=$failed total=$total" | Out-File -FilePath $logPath -Append -Encoding utf8
