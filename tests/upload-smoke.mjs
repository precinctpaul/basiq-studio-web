/**
 * upload-smoke.mjs — drives the real upload pipeline end to end against a
 * live dev server and the live Supabase project: create video row -> sign
 * upload url -> uploadToSignedUrl (the exact call VideoUploader.tsx makes) ->
 * finalize (ffprobe over a signed read url) -> confirm the row lands ready
 * with plausible probe data.
 *
 * Not part of `npm test` — it needs a running dev server and hits the real
 * network. Run manually:
 *   node --env-file=.env.local tests/upload-smoke.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const FIXTURE = path.join(HERE, "fixtures", "probe-smoke.mp4");

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  { auth: { persistSession: false } },
);

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
}

const bytes = await readFile(FIXTURE);
console.log(`fixture: ${FIXTURE} (${bytes.length} bytes)`);

// 1. create — same POST body VideoUploader sends.
const createRes = await fetch(`${BASE_URL}/api/videos`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    title: "probe-smoke",
    filename: "probe-smoke.mp4",
    mimeType: "video/mp4",
    sizeBytes: bytes.length,
  }),
});
const created = await createRes.json();
assert(createRes.ok, `create failed: ${JSON.stringify(created)}`);
assert(created.videoId && created.path && created.token, "create response missing fields");
console.log("created:", created.videoId, created.path);

// 2. upload — the exact SDK call the browser component makes.
const file = new File([bytes], "probe-smoke.mp4", { type: "video/mp4" });
const { error: uploadError } = await supabase.storage
  .from("videos")
  .uploadToSignedUrl(created.path, created.token, file, { contentType: "video/mp4" });
assert(!uploadError, `upload failed: ${uploadError?.message}`);
console.log("uploaded ok");

// 3. finalize — ffprobe over a signed read url.
const finalizeRes = await fetch(`${BASE_URL}/api/videos/${created.videoId}/finalize`, {
  method: "POST",
});
const finalized = await finalizeRes.json();
assert(finalizeRes.ok, `finalize failed: ${JSON.stringify(finalized)}`);
console.log("finalize result:", JSON.stringify(finalized.info));

// 4. verify the stored row, not just the response — the DB write is the part
// that actually matters to every later feature (crop UI, export).
const listRes = await fetch(`${BASE_URL}/api/videos`);
const { videos } = await listRes.json();
const row = videos.find((v) => v.id === created.videoId);
assert(row, "video row not found in listing after finalize");
assert(row.status === "ready", `expected status=ready, got ${row.status} (${row.error})`);
assert(row.has_video === true, "expected has_video=true");
assert(row.has_audio === true, "expected has_audio=true");
assert(Math.abs(row.duration_seconds - 4) < 1, `expected duration ~4s, got ${row.duration_seconds}`);
assert(row.width === 640 && row.height === 360, `expected 640x360, got ${row.width}x${row.height}`);
assert(row.vcodec === "h264", `expected h264, got ${row.vcodec}`);
assert(row.acodec === "aac", `expected aac, got ${row.acodec}`);

console.log("\nPASS — row:", JSON.stringify(row, null, 2));
