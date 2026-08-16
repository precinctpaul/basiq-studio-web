/**
 * share-smoke.mjs — proves an exported clip is actually reachable and
 * shareable, which is the gap that made exports feel like they vanished:
 *
 *   export -> clip appears in /api/library with a share token ->
 *   /api/clips/<id> returns a playable url + share url ->
 *   /share/<token> renders -> its download redirects to real bytes
 *
 * Requires the dev server on :3000 and at least one ready video in the
 * library (it exports a short range from the newest one).
 *
 *   node --env-file=.env.local tests/share-smoke.mjs
 */
import { createClient } from "@supabase/supabase-js";

const BASE_URL = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
}

let clipId;

try {
  const libRes = await fetch(`${BASE_URL}/api/library`);
  const lib = await libRes.json();
  assert(libRes.ok, `library failed: ${JSON.stringify(lib)}`);

  const source = (lib.rows ?? []).find((r) => r.kind === "video" && r.duration_seconds > 6);
  assert(source, "no ready video in the library to export from");
  console.log("1. source:", source.title.slice(0, 60), `${source.duration_seconds.toFixed(1)}s`);

  const exportRes = await fetch(`${BASE_URL}/api/clips`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      videoId: source.id,
      inPoint: 1,
      outPoint: 6,
      aspectMode: "vertical_crop",
    }),
  });
  const exported = await exportRes.json();
  assert(exportRes.ok, `export failed: ${JSON.stringify(exported)}`);
  clipId = exported.clipId;
  assert(exported.shareToken, "export produced no share token");
  console.log("2. exported:", clipId, exported.shareUrl);

  // --- the actual regression this test exists for -------------------------
  const lib2 = await (await fetch(`${BASE_URL}/api/library`)).json();
  const clipRow = (lib2.rows ?? []).find((r) => r.id === clipId);
  assert(clipRow, "exported clip does NOT appear in the library — it is unreachable");
  assert(clipRow.kind === "clip" && clipRow.is_clip, "clip row not marked as a clip");
  assert(clipRow.share_token === exported.shareToken, "library row carries the wrong share token");
  console.log("3. clip is in the library with its share token ✓");

  const clipRes = await fetch(`${BASE_URL}/api/clips/${clipId}`);
  const clip = await clipRes.json();
  assert(clipRes.ok, `clip fetch failed: ${JSON.stringify(clip)}`);
  assert(clip.playbackUrl, `clip has no playback url: ${clip.playbackError}`);
  assert(clip.shareUrl === `/share/${exported.shareToken}`, "clip share url mismatch");
  const playRes = await fetch(clip.playbackUrl, { headers: { Range: "bytes=0-1023" } });
  assert(playRes.ok, `clip playback url did not serve: ${playRes.status}`);
  console.log("4. clip loads + plays in the editor ✓");

  const pageRes = await fetch(`${BASE_URL}/share/${exported.shareToken}`);
  assert(pageRes.ok, `share page returned ${pageRes.status}`);
  const html = await pageRes.text();
  assert(html.includes("Download") || html.includes("DOWNLOAD"), "share page has no download control");
  console.log("5. share page renders ✓");

  const dlRes = await fetch(`${BASE_URL}/api/share/${exported.shareToken}/download`, {
    redirect: "manual",
  });
  assert([302, 307].includes(dlRes.status), `expected a redirect, got ${dlRes.status}`);
  const signed = dlRes.headers.get("location");
  assert(signed, "download redirect carried no location");
  const bytesRes = await fetch(signed, { headers: { Range: "bytes=0-1023" } });
  assert(bytesRes.ok, `signed download url did not serve: ${bytesRes.status}`);
  console.log("6. share download serves real bytes ✓");

  console.log("\nSHARE CHAIN PASSED");
} finally {
  if (clipId) {
    const { data: clip } = await admin
      .from("clips")
      .select("storage_path")
      .eq("id", clipId)
      .maybeSingle();
    if (clip?.storage_path) await admin.storage.from("clips").remove([clip.storage_path]);
    await admin.from("clips").delete().eq("id", clipId);
    console.log("cleaned up clip", clipId);
  }
}
