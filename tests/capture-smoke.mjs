/**
 * capture-smoke.mjs — drives a real LIVE capture end to end, the way the
 * browser will:
 *
 *   create row -> agent /capture -> poll /jobs/<id> -> (stop or time cap) ->
 *   remux -> upload -> PATCH metadata -> finalize (ffprobe) -> ready
 *
 * Requires: dev server on :3000, agent on :8000.
 *   node --env-file=.env.local tests/capture-smoke.mjs [url] [--stop-after=12]
 *
 * `--stop-after=N` exercises the MANUAL stop path (POST /jobs/<id>/stop) after
 * N seconds. Without it the capture uses the agent's own max-minutes cap.
 * Both paths must produce a playable file — that is the point of the test.
 */
import { createClient } from "@supabase/supabase-js";

const BASE_URL = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const AGENT_URL = process.env.AGENT_URL ?? "http://127.0.0.1:8000";

const args = process.argv.slice(2);
const TARGET = args.find((a) => !a.startsWith("--")) ?? "https://www.cbsnews.com/live/";
const stopArg = args.find((a) => a.startsWith("--stop-after="));
const STOP_AFTER = stopArg ? Number(stopArg.split("=")[1]) : 0;
const MAX_MINUTES = STOP_AFTER ? 0 : Number(process.env.MAX_MINUTES ?? 0.2); // 12s

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
}

let videoId;

try {
  console.log("capturing:", TARGET);
  console.log(STOP_AFTER ? `mode: manual stop after ${STOP_AFTER}s` : `mode: ${MAX_MINUTES} min cap`);

  const createRes = await fetch(`${BASE_URL}/api/videos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: TARGET.slice(0, 300),
      filename: "capture.mp4",
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

  const capRes = await fetch(`${AGENT_URL}/capture`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: TARGET,
      title: "",
      maxMinutes: MAX_MINUTES,
      signedUrl: created.signedUrl,
    }),
  });
  const cap = await capRes.json();
  assert(capRes.ok, `capture failed to start: ${JSON.stringify(cap)}`);
  console.log("2. capture started:", cap.jobId);

  let job;
  let lastStatus = "";
  let sawRecording = false;
  let stopSent = false;
  const startedAt = Date.now();

  for (;;) {
    job = await (await fetch(`${AGENT_URL}/jobs/${cap.jobId}`)).json();
    if (job.status !== lastStatus) {
      console.log("   " + job.status);
      lastStatus = job.status;
    }
    if (job.status.startsWith("Recording")) sawRecording = true;

    if (STOP_AFTER && sawRecording && !stopSent && (Date.now() - startedAt) / 1000 >= STOP_AFTER) {
      const stopRes = await fetch(`${AGENT_URL}/jobs/${cap.jobId}/stop`, { method: "POST" });
      assert(stopRes.ok, "stop request failed");
      console.log("   -> stop requested");
      stopSent = true;
    }

    if (job.status === "Complete") break;
    assert(job.status !== "Error", `capture errored: ${job.error}`);
    assert((Date.now() - startedAt) / 1000 < 240, "capture did not finish within 240s");
    await new Promise((r) => setTimeout(r, 700));
  }

  assert(sawRecording, "never reported a Recording status — no data was flowing");
  assert(job.result, "completed with no result payload");
  assert(job.result.sizeBytes > 0, "captured file is empty");
  console.log("3. captured:", JSON.stringify(job.result));

  await fetch(`${BASE_URL}/api/videos/${videoId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: job.result.title || TARGET,
      source_url: job.result.sourceUrl || TARGET,
      size_bytes: job.result.sizeBytes || 0,
    }),
  });
  console.log("4. metadata patched");

  const finalizeRes = await fetch(`${BASE_URL}/api/videos/${videoId}/finalize`, { method: "POST" });
  const finalized = await finalizeRes.json();
  assert(finalizeRes.ok, `finalize failed: ${JSON.stringify(finalized)}`);
  console.log("5. probed:", JSON.stringify(finalized.info));

  // The whole TS-first design exists so the recording is playable no matter how
  // it ended. Prove that with a real probe, not just a non-zero byte count.
  assert(finalized.info.duration > 0, "probe found no duration — file is not playable");
  assert(finalized.info.hasVideo, "probe found no video stream");

  const getRes = await fetch(`${BASE_URL}/api/videos/${videoId}`);
  const got = await getRes.json();
  assert(got.video.status === "ready", `expected ready, got ${got.video.status}`);
  assert(got.playbackUrl, `no playback url: ${got.playbackError}`);
  const headRes = await fetch(got.playbackUrl, { headers: { Range: "bytes=0-1023" } });
  assert(headRes.ok, `playback url did not serve: ${headRes.status}`);
  console.log(
    `6. ready: "${got.video.title}" ${got.video.width}x${got.video.height} ` +
      `${got.video.duration_seconds.toFixed(1)}s — playback serves bytes ✓`,
  );

  console.log("\nLIVE CAPTURE PASSED");
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
