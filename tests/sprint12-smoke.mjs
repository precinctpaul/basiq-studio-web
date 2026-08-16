/**
 * sprint12-smoke.mjs — full Sprint 1 + Sprint 2 pipeline, driven for real:
 *
 *   upload -> finalize (ffprobe) -> start transcript -> POST to the real
 *   local whisper server -> ingest segments -> generate key moments ->
 *   simulate a transcript-selection export -> follow the share link ->
 *   ffprobe the downloaded clip.
 *
 * Every step calls the actual Next.js API routes a browser would call — this
 * is not a unit test, it is the real system, minus only the DOM interactions
 * (drag-drop, clicking a paragraph) that a headless script can't drive.
 *
 * Requires: dev server on :3000, whisper server on :8000 (or WHISPER_URL).
 *   node --env-file=.env.local tests/sprint12-smoke.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ffprobeStatic from "ffprobe-static";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const WHISPER_URL = process.env.WHISPER_URL ?? "http://127.0.0.1:8000";
const FIXTURE = path.join(HERE, "fixtures", "hearing-smoke.mp4");

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  { auth: { persistSession: false } },
);
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
}

async function probeFile(filePath) {
  const { stdout } = await execFileAsync(ffprobeStatic.path, [
    "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath,
  ]);
  const data = JSON.parse(stdout);
  const v = (data.streams ?? []).find((s) => s.codec_type === "video");
  return {
    duration: Number.parseFloat(data.format?.duration ?? "0"),
    width: v?.width ?? 0,
    height: v?.height ?? 0,
  };
}

let videoId;

try {
  // ---- 1. Upload + finalize (Sprint 0 pipeline, re-exercised as the base) ----
  const bytes = await readFile(FIXTURE);
  const createRes = await fetch(`${BASE_URL}/api/videos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "sprint12-smoke", filename: "hearing-smoke.mp4",
      mimeType: "video/mp4", sizeBytes: bytes.length,
    }),
  });
  const created = await createRes.json();
  assert(createRes.ok, `create failed: ${JSON.stringify(created)}`);
  videoId = created.videoId;
  console.log("1. video created:", videoId);

  const file = new File([bytes], "hearing-smoke.mp4", { type: "video/mp4" });
  const { error: uploadError } = await supabase.storage
    .from("videos").uploadToSignedUrl(created.path, created.token, file, { contentType: "video/mp4" });
  assert(!uploadError, `upload failed: ${uploadError?.message}`);

  const finalizeRes = await fetch(`${BASE_URL}/api/videos/${videoId}/finalize`, { method: "POST" });
  const finalized = await finalizeRes.json();
  assert(finalizeRes.ok, `finalize failed: ${JSON.stringify(finalized)}`);
  console.log("   probed:", JSON.stringify(finalized.info));

  // ---- 2. Start transcript, get signed source url ----
  const startRes = await fetch(`${BASE_URL}/api/videos/${videoId}/transcripts`, { method: "POST" });
  const started = await startRes.json();
  assert(startRes.ok, `start transcript failed: ${JSON.stringify(started)}`);
  console.log("2. transcript started:", started.transcriptId);

  // ---- 3. Real local whisper server call ----
  const whisperRes = await fetch(`${WHISPER_URL}/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: started.sourceUrl }),
  });
  const whisperBody = await whisperRes.json();
  assert(whisperRes.ok, `whisper server failed: ${JSON.stringify(whisperBody)}`);
  assert(whisperBody.segments.length > 0, "whisper returned no segments");
  console.log(`3. transcribed ${whisperBody.segments.length} segments, language=${whisperBody.language}`);
  console.log("   full text:", whisperBody.segments.map((s) => s.text).join(" "));

  // ---- 4. Ingest segments ----
  const segRes = await fetch(`${BASE_URL}/api/transcripts/${started.transcriptId}/segments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ segments: whisperBody.segments, language: whisperBody.language }),
  });
  const segBody = await segRes.json();
  assert(segRes.ok, `segment ingest failed: ${JSON.stringify(segBody)}`);
  console.log("4. ingested", segBody.segmentCount, "segments");

  // Verify the GET route round-trips correctly (what the browser actually reads).
  const getTranscriptRes = await fetch(`${BASE_URL}/api/videos/${videoId}/transcript`);
  const getTranscriptBody = await getTranscriptRes.json();
  assert(getTranscriptRes.ok, "GET transcript failed");
  assert(getTranscriptBody.transcript.status === "ready", "transcript not marked ready");
  assert(getTranscriptBody.segments.length === whisperBody.segments.length, "segment count mismatch on read-back");
  console.log("   GET /transcript round-trip OK");

  // ---- 5. Generate key moments ----
  const kmRes = await fetch(`${BASE_URL}/api/videos/${videoId}/key-moments`, { method: "POST" });
  const kmBody = await kmRes.json();
  assert(kmRes.ok, `key-moments failed: ${JSON.stringify(kmBody)}`);
  assert(kmBody.keyMoments.length > 0, "no key moments generated");
  console.log(`5. generated ${kmBody.keyMoments.length} key moments:`);
  for (const m of kmBody.keyMoments) {
    console.log(`   [${m.start_seconds.toFixed(1)}s-${m.end_seconds.toFixed(1)}s] ${m.label}`);
  }

  // ---- 6. Simulate a transcript-text-selection export ----
  // Select the first half of segments as a "highlighted range" the way
  // TranscriptPanel's onSelectRange would, then export exactly that window.
  const mid = Math.ceil(whisperBody.segments.length / 2);
  const inPoint = whisperBody.segments[0].start;
  const outPoint = whisperBody.segments[mid - 1].end;
  assert(outPoint > inPoint, "selected range invalid");
  console.log(`6. exporting selected range ${inPoint.toFixed(1)}s-${outPoint.toFixed(1)}s`);

  const exportRes = await fetch(`${BASE_URL}/api/clips`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId, inPoint, outPoint, aspectMode: "vertical_crop" }),
  });
  const exportBody = await exportRes.json();
  assert(exportRes.ok, `export failed: ${JSON.stringify(exportBody)}`);
  console.log("   clip exported:", exportBody.clipId, exportBody.shareUrl);

  // ---- 7. Follow the share link for real, ffprobe the actual bytes ----
  const dlRes = await fetch(`${BASE_URL}${exportBody.shareUrl.replace("/share/", "/api/share/")}/download`, {
    redirect: "manual",
  });
  assert(dlRes.status === 302 || dlRes.status === 303, `expected redirect, got ${dlRes.status}`);
  const signedUrl = dlRes.headers.get("location");
  const fileRes = await fetch(signedUrl);
  assert(fileRes.ok, "signed clip url did not serve");
  const clipBytes = Buffer.from(await fileRes.arrayBuffer());
  const localPath = path.join(HERE, "_smoke_sprint12_clip.mp4");
  await writeFile(localPath, clipBytes);
  const clipInfo = await probeFile(localPath);
  await unlink(localPath);
  console.log("7. downloaded clip probed:", JSON.stringify(clipInfo));
  assert(clipInfo.width === 1080 && clipInfo.height === 1920, `expected 1080x1920, got ${clipInfo.width}x${clipInfo.height}`);

  console.log("\nALL SPRINT 1+2 ASSERTIONS PASSED");
} finally {
  if (videoId) {
    const { data: clips } = await admin.from("clips").select("id, storage_path").eq("video_id", videoId);
    for (const c of clips ?? []) {
      if (c.storage_path) await admin.storage.from("clips").remove([c.storage_path]);
    }
    const { data: video } = await admin.from("videos").select("storage_path").eq("id", videoId).single();
    if (video?.storage_path) await admin.storage.from("videos").remove([video.storage_path]);
    // cascades: transcripts -> transcript_segments, clips -> share_tokens, key_moments
    await admin.from("videos").delete().eq("id", videoId);
    console.log("cleaned up video", videoId, "and all dependent rows/storage");
  }
}
