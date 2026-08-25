/**
 * backfill_video_metadata.js — fixes videos stuck showing "Scanning..."
 * forever in the sidebar.
 *
 * CAUSE: bulk_ingest.py wrote whatever duration the .info.json sidecar
 * reported. When that field was missing or zero, the video got stored with
 * duration_seconds = 0 permanently — nothing ever went back and re-checked
 * it. The RESCAN button doesn't help either; per the project's own infra
 * notes, it currently points at a no-op endpoint.
 *
 * FIX: this project already ships the real tool for this — ffprobe-static
 * is already a dependency in package.json. This walks every video with a
 * missing/zero duration, runs ffprobe against the actual file on the shared
 * drive, and writes back the real duration, resolution, fps, and codecs.
 *
 * SAFE TO RE-RUN: only touches rows still missing a duration, so re-running
 * after adding more videos just picks up whatever's newly stuck.
 *
 * Run from the PROJECT ROOT (not from inside tools/), so Node can find the
 * dependencies already installed at the top level:
 *
 *     node tools/backfill_video_metadata.js
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const util = require("util");
const { createClient } = require("@supabase/supabase-js");
const ffprobeStatic = require("ffprobe-static");

const execFileAsync = util.promisify(execFile);

// --- CONFIGURATION ---
const SUPABASE_URL = "https://tijwokimlrglufjqiwok.supabase.co";
// STOP! Replace with your SUPABASE_SERVICE_ROLE_KEY from .env.local
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRpandva2ltbHJnbHVmanFpd29rIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NjgyMDQ0OSwiZXhwIjoyMTAyMzk2NDQ5fQ.vD586cg84F9LuNRb7AegIiu5Cn843wezSKmnX23Q1pw";

// Two different ingestion paths write local_path relative to two different
// roots: bulk_ingest.py used the broad drive root (so its paths include the
// full "Archive/Basiq-Studio-Hub/..." prefix), while the agent's live GRAB
// pipeline writes relative to the narrower folder worker_config.txt points
// at (so its paths are bare filenames, no prefix). Rather than guess which
// convention a given row uses, try both and use whichever actually exists.
const CANDIDATE_ROOTS = [
  "C:\\Volumes\\md-pac\\media",
  "C:\\Volumes\\md-pac\\media\\Archive\\Basiq-Studio-Hub",
];

function resolveExistingPath(localPath) {
  for (const root of CANDIDATE_ROOTS) {
    const candidate = path.join(root, localPath);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const PAGE_SIZE = 1000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function fetchAllStuckVideos() {
  const rows = [];
  let page = 0;
  while (true) {
    const { data, error } = await supabase
      .from("videos")
      .select("id, local_path, duration_seconds")
      .not("local_path", "is", null)
      .or("duration_seconds.is.null,duration_seconds.eq.0")
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (error) throw new Error(`Fetch failed: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
    page++;
  }
  return rows;
}

async function probeFile(filePath) {
  const { stdout } = await execFileAsync(ffprobeStatic.path, [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  const data = JSON.parse(stdout);
  const streams = data.streams || [];
  const videoStream = streams.find((s) => s.codec_type === "video");
  const audioStream = streams.find((s) => s.codec_type === "audio");

  const duration =
    parseFloat(data.format && data.format.duration) ||
    parseFloat(videoStream && videoStream.duration) ||
    0;

  let fps = 0;
  if (videoStream && videoStream.r_frame_rate) {
    const [num, den] = videoStream.r_frame_rate.split("/").map(Number);
    fps = den ? num / den : num;
  }

  return {
    duration_seconds: duration,
    width: (videoStream && videoStream.width) || 0,
    height: (videoStream && videoStream.height) || 0,
    fps: fps || 0,
    has_video: Boolean(videoStream),
    has_audio: Boolean(audioStream),
    vcodec: (videoStream && videoStream.codec_name) || "",
    acodec: (audioStream && audioStream.codec_name) || "",
  };
}

async function main() {
  console.log("Loading videos with a missing or zero duration...");
  const rows = await fetchAllStuckVideos();
  console.log(`  ${rows.length} videos to probe.`);

  let updated = 0;
  let fileMissing = 0;
  let probeFailed = 0;

  for (const row of rows) {
    const fullPath = resolveExistingPath(row.local_path);

    if (!fullPath) {
      fileMissing++;
      continue;
    }

    try {
      const info = await probeFile(fullPath);
      if (!info.duration_seconds) {
        probeFailed++;
        continue;
      }
      const { error } = await supabase.from("videos").update(info).eq("id", row.id);
      if (error) throw new Error(error.message);
      updated++;
      if (updated % 100 === 0) console.log(`  ...${updated} updated so far`);
    } catch (err) {
      console.log(`  FAILED on ${row.local_path}: ${err.message}`);
      probeFailed++;
    }
  }

  console.log("\nDone.");
  console.log(`  Updated:               ${updated}`);
  console.log(`  File not found on disk:${fileMissing}`);
  console.log(`  Probe failed:          ${probeFailed}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
