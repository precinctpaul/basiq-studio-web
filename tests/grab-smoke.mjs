/**
 * grab-smoke.mjs — drives the full GRAB pipeline exactly as the browser does:
 *
 *   create row -> agent /grab (yt-dlp downloads + PUTs to storage) ->
 *   poll /jobs/<id> -> PATCH real metadata -> finalize (ffprobe) -> ready
 *
 * Requires: dev server on :3000, agent on :8000.
 *   node --env-file=.env.local tests/grab-smoke.mjs [url]
 *
 * Defaults to a small direct-MP4 URL so the pipeline itself is what's under
 * test, not YouTube's extractor. Pass a YouTube/C-SPAN URL as argv[2] to
 * exercise the extractor path too.
 */
import { createClient } from "@supabase/supabase-js";

const BASE_URL = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const AGENT_URL = process.env.AGENT_URL ?? "http://127.0.0.1:8000";
const TARGET =
  process.argv[2] ??
  "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4";
const QUALITY = process.env.GRAB_QUALITY ?? "Proxy";

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
}

let videoId;

try {
  const health = await (await fetch(`${AGENT_URL}/health`)).json();
  assert(health.ytdlp, "agent reports yt-dlp missing");
  console.log("agent:", JSON.stringify(health));
  console.log("grabbing:", TARGET, `(quality=${QUALITY})`);

  // ---- 1. Create the row; this is what mints the signed upload URL ----
  const createRes = await fetch(`${BASE_URL}/api/videos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: TARGET.slice(0, 300),
      filename: "grab.mp4",
      mimeType: "video/mp4",
      sizeBytes: 0,
      sourceKind: "url",
      sourceUrl: TARGET,
    }),
  });
  const created = await createRes.json();
  assert(createRes.ok, `create failed: ${JSON.stringify(created)}`);
  videoId = created.videoId;
  console.log("1. row created:", videoId);

  // ---- 2. Hand it to the agent ----
  const grabRes = await fetch(`${AGENT_URL}/grab`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: TARGET, quality: QUALITY, subs: false, signedUrl: created.signedUrl }),
  });
  const grab = await grabRes.json();
  assert(grabRes.ok, `grab failed: ${JSON.stringify(grab)}`);
  console.log("2. job started:", grab.jobId);

  // ---- 3. Poll to completion ----
  let job;
  let lastStatus = "";
  for (;;) {
    job = await (await fetch(`${AGENT_URL}/jobs/${grab.jobId}`)).json();
    if (job.status !== lastStatus) {
      console.log(`   ${job.status}${job.pct != null ? ` ${job.pct.toFixed(0)}%` : ""}`);
      lastStatus = job.status;
    }
    if (job.status === "Complete") break;
    assert(job.status !== "Error", `agent job errored: ${job.error}`);
    await new Promise((r) => setTimeout(r, 700));
  }
  assert(job.result, "job completed with no result payload");
  console.log("3. downloaded + uploaded:", JSON.stringify(job.result));

  // ---- 4. PATCH the real metadata yt-dlp resolved ----
  const patchRes = await fetch(`${BASE_URL}/api/videos/${videoId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: job.result.title || TARGET,
      uploader: job.result.uploader || "",
      source_url: job.result.sourceUrl || TARGET,
      size_bytes: job.result.sizeBytes || 0,
    }),
  });
  assert(patchRes.ok, `patch failed: ${JSON.stringify(await patchRes.json())}`);
  console.log("4. metadata patched");

  // ---- 5. Finalize: ffprobe over the signed read URL ----
  const finalizeRes = await fetch(`${BASE_URL}/api/videos/${videoId}/finalize`, { method: "POST" });
  const finalized = await finalizeRes.json();
  assert(finalizeRes.ok, `finalize failed: ${JSON.stringify(finalized)}`);
  console.log("5. probed:", JSON.stringify(finalized.info));

  // ---- 6. Verify the library row is genuinely playable ----
  const getRes = await fetch(`${BASE_URL}/api/videos/${videoId}`);
  const got = await getRes.json();
  assert(getRes.ok, "GET video failed");
  assert(got.video.status === "ready", `expected ready, got ${got.video.status}`);
  assert(got.video.width > 0 && got.video.height > 0, "probe produced no dimensions");
  assert(got.video.duration_seconds > 0, "probe produced no duration");
  assert(got.playbackUrl, "no playback url minted");
  console.log(
    `6. library row ready: "${got.video.title}" ${got.video.width}x${got.video.height} ` +
      `${got.video.duration_seconds.toFixed(1)}s ${got.video.vcodec}/${got.video.acodec}`,
  );

  // The playback URL must actually serve bytes — a row that says ready but
  // 404s on its own media is the failure mode worth catching here.
  const headRes = await fetch(got.playbackUrl, { headers: { Range: "bytes=0-1023" } });
  assert(headRes.ok, `playback url did not serve: ${headRes.status}`);
  console.log("   playback url serves bytes ✓");

  console.log("\nGRAB PIPELINE PASSED");
} finally {
  if (videoId) {
    const { data: video } = await admin
      .from("videos")
      .select("storage_path")
      .eq("id", videoId)
      .maybeSingle();
    if (video?.storage_path) await admin.storage.from("videos").remove([video.storage_path]);
    await admin.from("videos").delete().eq("id", videoId);
    console.log("cleaned up", videoId);
  }
}
