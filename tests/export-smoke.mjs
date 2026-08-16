/**
 * export-smoke.mjs — drives upload -> export -> share link end to end against
 * a live dev server and the live Supabase project, then downloads the
 * rendered clip and ffprobes IT (not the request/response, the actual bytes)
 * to confirm the crop/blur transform was really baked in — not just that the
 * route returned 200.
 *
 * Not part of `npm test`. Run manually:
 *   node --env-file=.env.local tests/export-smoke.mjs
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
const FIXTURE = path.join(HERE, "fixtures", "probe-smoke.mp4"); // 640x360, 4s, h264/aac

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
  const a = (data.streams ?? []).find((s) => s.codec_type === "audio");
  return {
    duration: Number.parseFloat(data.format?.duration ?? "0"),
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    vcodec: v?.codec_name ?? "",
    acodec: a?.codec_name ?? "",
  };
}

async function uploadFixture() {
  const bytes = await readFile(FIXTURE);
  const createRes = await fetch(`${BASE_URL}/api/videos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "export-smoke",
      filename: "export-smoke.mp4",
      mimeType: "video/mp4",
      sizeBytes: bytes.length,
    }),
  });
  const created = await createRes.json();
  assert(createRes.ok, `create failed: ${JSON.stringify(created)}`);

  const file = new File([bytes], "export-smoke.mp4", { type: "video/mp4" });
  const { error: uploadError } = await supabase.storage
    .from("videos")
    .uploadToSignedUrl(created.path, created.token, file, { contentType: "video/mp4" });
  assert(!uploadError, `upload failed: ${uploadError?.message}`);

  const finalizeRes = await fetch(`${BASE_URL}/api/videos/${created.videoId}/finalize`, { method: "POST" });
  const finalized = await finalizeRes.json();
  assert(finalizeRes.ok, `finalize failed: ${JSON.stringify(finalized)}`);
  console.log("source probed:", JSON.stringify(finalized.info));

  return created.videoId;
}

async function exportClip(videoId, aspectMode, cropOffsetX = 0) {
  console.log(`\n--- exporting aspectMode=${aspectMode} ---`);
  const res = await fetch(`${BASE_URL}/api/clips`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId, inPoint: 0.5, outPoint: 3.0, aspectMode, cropOffsetX }),
  });
  const body = await res.json();
  assert(res.ok, `export failed: ${JSON.stringify(body)}`);
  console.log("export response:", JSON.stringify(body));

  // Follow the actual share -> download route a real user would hit.
  const dlRes = await fetch(`${BASE_URL}${body.shareUrl.replace("/share/", "/api/share/")}/download`, {
    redirect: "manual",
  });
  assert(dlRes.status === 302 || dlRes.status === 303, `expected redirect, got ${dlRes.status}`);
  const signedUrl = dlRes.headers.get("location");
  assert(signedUrl, "no Location header on download redirect");

  const fileRes = await fetch(signedUrl);
  assert(fileRes.ok, `signed download url did not serve: ${fileRes.status}`);
  const arrBuf = await fileRes.arrayBuffer();
  const localPath = path.join(HERE, `_smoke_${aspectMode}.mp4`);
  await writeFile(localPath, Buffer.from(arrBuf));

  const info = await probeFile(localPath);
  console.log(`downloaded clip probed (${aspectMode}):`, JSON.stringify(info));
  await unlink(localPath);

  return { ...body, info };
}

const videoId = await uploadFixture();

try {
  // vertical_crop: 640x360 (16:9) source -> crop keeps full height, narrows
  // width to 9:16, then scales to the configured vertical_width (1080) and
  // its derived height (1920). This is the highest-risk path — prove it
  // lands on the exact pixel dimensions the filter chain promises.
  const crop = await exportClip(videoId, "vertical_crop");
  assert(crop.info.width === 1080 && crop.info.height === 1920, `expected 1080x1920, got ${crop.info.width}x${crop.info.height}`);
  assert(crop.info.vcodec === "h264" && crop.info.acodec === "aac", "expected h264/aac");
  assert(Math.abs(crop.info.duration - crop.durationSeconds) < 0.5, `probed duration ${crop.info.duration} vs planned ${crop.durationSeconds}`);

  // native: just guarantees even dimensions, geometry unchanged.
  const native = await exportClip(videoId, "native");
  assert(native.info.width === 640 && native.info.height === 360, `expected 640x360, got ${native.info.width}x${native.info.height}`);

  // vertical_blur: full 1080x1920 canvas, content contained (no crop).
  const blur = await exportClip(videoId, "vertical_blur");
  assert(blur.info.width === 1080 && blur.info.height === 1920, `expected 1080x1920, got ${blur.info.width}x${blur.info.height}`);

  console.log("\nALL EXPORT ASSERTIONS PASSED");
} finally {
  // Cleanup: remove clips (+ storage), share_tokens, and the source video —
  // this is a live project, not a scratch environment.
  const { data: clips } = await admin.from("clips").select("id, storage_path").eq("video_id", videoId);
  for (const c of clips ?? []) {
    if (c.storage_path) await admin.storage.from("clips").remove([c.storage_path]);
  }
  const { data: video } = await admin.from("videos").select("storage_path").eq("id", videoId).single();
  if (video?.storage_path) await admin.storage.from("videos").remove([video.storage_path]);
  await admin.from("videos").delete().eq("id", videoId); // cascades clips + share_tokens
  console.log("cleaned up test video, clips, and storage objects");
}
