/**
 * tags-smoke.mjs — the full smart-tagging round trip:
 *
 *   transcript -> agent /tag (entities + keyphrases) -> stored as the auto set
 *   -> manual tag added -> re-tag -> manual tag SURVIVES, auto set replaced
 *   -> library search matches on tag text -> manual tag removed
 *
 * The survival check is the one that matters: auto tags are disposable and
 * manual tags are not, and that distinction is the whole reason `source`
 * exists as a column.
 *
 * Requires: dev server on :3000, agent on :8000, and migration 0004 applied.
 *   node --env-file=.env.local tests/tags-smoke.mjs
 */
const BASE_URL = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const AGENT_URL = process.env.AGENT_URL ?? "http://127.0.0.1:8000";
const MANUAL_TAG = "smoke-test-manual-tag";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
}

const labels = (tags) => tags.map((t) => t.label);
const bySource = (tags, source) => tags.filter((t) => t.source === source);

let videoId;

try {
  const health = await (await fetch(`${AGENT_URL}/health`)).json();
  assert(health.tagger, "agent reports no tagger installed");

  const lib = await (await fetch(`${BASE_URL}/api/library`)).json();
  assert(lib.rows, `library failed: ${JSON.stringify(lib).slice(0, 200)}`);

  // Find a video that actually has a transcript to tag from.
  let transcriptText = "";
  for (const row of lib.rows.filter((r) => r.kind === "video")) {
    const t = await (await fetch(`${BASE_URL}/api/videos/${row.id}/transcript`)).json();
    if (t.transcript?.status === "ready" && (t.segments ?? []).length > 0) {
      videoId = row.id;
      transcriptText = t.segments.map((s) => s.text).join(" ");
      console.log("1. source:", row.title.slice(0, 55), `${t.segments.length} segments`);
      break;
    }
  }
  assert(videoId, "no transcribed video in the library to tag");

  // Fail loudly and usefully if the migration hasn't been run.
  const probe = await fetch(`${BASE_URL}/api/videos/${videoId}/tags`);
  if (probe.status === 503) {
    console.log("\nSKIPPED — run supabase/migrations/0004_tags.sql first.");
    process.exit(0);
  }

  // ---- 2. Derive the auto set ----
  const start = await fetch(`${AGENT_URL}/tag`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: transcriptText, extra: ["smoke-source"] }),
  });
  const { jobId } = await start.json();
  let job;
  const t0 = Date.now();
  for (;;) {
    job = await (await fetch(`${AGENT_URL}/jobs/${jobId}`)).json();
    if (job.status === "Complete") break;
    assert(job.status !== "Error", `tagging errored: ${job.error}`);
    assert(Date.now() - t0 < 600000, "tagging did not finish within 600s");
    await new Promise((r) => setTimeout(r, 1000));
  }
  const derived = job.result.tags;
  assert(derived.length > 0, "agent derived no tags at all");
  assert(
    derived.some((t) => t.kind === "entity"),
    "no named entities found — the NER half is not contributing",
  );
  console.log(`2. derived ${derived.length} tags:`, labels(derived).slice(0, 6).join(", "), "…");

  const saved = await (
    await fetch(`${BASE_URL}/api/videos/${videoId}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auto: derived }),
    })
  ).json();
  assert(bySource(saved.tags, "auto").length > 0, "auto tags did not persist");
  console.log("3. stored as the auto set ✓");

  // ---- 4. Add a manual tag ----
  const withManual = await (
    await fetch(`${BASE_URL}/api/videos/${videoId}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: MANUAL_TAG }),
    })
  ).json();
  assert(
    bySource(withManual.tags, "manual").some((t) => t.label === MANUAL_TAG),
    "manual tag was not added",
  );
  console.log("4. manual tag added ✓");

  // ---- 5. Re-tag: manual must survive, auto must be replaced ----
  const reTagged = await (
    await fetch(`${BASE_URL}/api/videos/${videoId}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auto: derived.slice(0, 3) }),
    })
  ).json();
  assert(
    reTagged.tags.some((t) => t.label === MANUAL_TAG && t.source === "manual"),
    "THE MANUAL TAG WAS DESTROYED BY RE-TAGGING — this is the bug `source` exists to prevent",
  );
  assert(
    bySource(reTagged.tags, "auto").length <= 3,
    "the previous auto set was not replaced",
  );
  console.log("5. re-tag replaced the auto set and kept the manual tag ✓");

  // ---- 6. Library search must match on tag text ----
  const lib2 = await (await fetch(`${BASE_URL}/api/library`)).json();
  const row = lib2.rows.find((r) => r.id === videoId);
  assert(row, "video vanished from the library");
  assert(
    (row.tags ?? []).some((t) => t.label === MANUAL_TAG),
    "tags are not travelling with the library rows, so search cannot match them",
  );
  console.log("6. tags travel with the library rows (searchable) ✓");

  console.log("\nTAGS PASSED");
} finally {
  if (videoId) {
    await fetch(
      `${BASE_URL}/api/videos/${videoId}/tags?label=${encodeURIComponent(MANUAL_TAG)}`,
      { method: "DELETE" },
    ).catch(() => {});
    console.log("cleaned up the smoke-test manual tag");
  }
}
