/**
 * subtitle-edits.test.mjs — the SUBTITLES tab's overlay (lib/subtitle-edits.ts).
 *
 * Edits apply to a copy of the segments and only while the segment still
 * says what it said when the edit was made. The input segments (the
 * transcript) must come back untouched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { applySubtitleEdits, loadSubtitleEdits } from "../lib/subtitle-edits.ts";
import { buildCues } from "../lib/burn-subs.ts";

/** Minimal stand-in for the one supabase query loadSubtitleEdits makes. */
function fakeDb(rows, error = null) {
  return {
    from: (table) => {
      assert.equal(table, "subtitle_edits");
      return { select: () => ({ eq: async () => ({ data: rows, error }) }) };
    },
  };
}

test("edits apply only while the segment still has its original text", async () => {
  const segments = [
    { idx: 7, text: "corrupt politician in Texas We're going" },
    { idx: 8, text: "up against this entire corrupt system" },
  ];
  const db = fakeDb([
    { segment_idx: 7, text: "corrupt politician in Texas. We're going", original_text: "corrupt politician in Texas We're going" },
    // Stale: the segment was re-cut since this edit; must not apply.
    { segment_idx: 8, text: "something else entirely", original_text: "an older version of the line" },
  ]);
  const edits = await loadSubtitleEdits(db, "t1", segments);
  assert.deepEqual([...edits], [[7, "corrupt politician in Texas. We're going"]]);
});

test("applying edits returns a copy and leaves the transcript segments untouched", () => {
  const segments = [{ idx: 1, start_seconds: 0, end_seconds: 3, text: "in Texas We're going up" }];
  const frozen = JSON.stringify(segments);
  const out = applySubtitleEdits(segments, new Map([[1, "in Texas. We're going up"]]));
  assert.equal(out[0].text, "in Texas. We're going up");
  assert.equal(JSON.stringify(segments), frozen);
  // And the added period really does split the subtitle.
  const t = buildCues(out, { start: 0, end: 5 }, 40).map((c) => c.lines.join(" "));
  assert.deepEqual(t, ["in Texas.", "We're going up"]);
});

test("a missing subtitle_edits table (migration not run yet) means no edits, not a failed export", async () => {
  const edits = await loadSubtitleEdits(fakeDb(null, { code: "PGRST205", message: "not found" }), "t1", []);
  assert.equal(edits.size, 0);
  await assert.rejects(loadSubtitleEdits(fakeDb(null, { code: "XX000", message: "boom" }), "t1", []));
});
