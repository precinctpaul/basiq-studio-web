# One-off: copy the 442 archive items' files (video + metadata + captions,
# skipping .part/.ytdl junk) from the legacy local-only C:\Majority
# Democrats\basiq_ingest folder onto the shared LucidLink drive, so they
# become reachable by the agent's /media/* proxy (and therefore playable in
# the Archive view) from any machine, not just this one. Copy-only, per the
# project's original rule -- the local originals are never touched.
#
# Idempotent: skips a file if it already exists at the destination with a
# matching size, so this can be safely re-run if interrupted partway.

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

"Starting copy of $total files at $(Get-Date)" | Out-File -FilePath $logPath -Encoding utf8

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
}

"DONE at $(Get-Date): copied=$copied skipped=$skipped failed=$failed total=$total" | Out-File -FilePath $logPath -Append -Encoding utf8
