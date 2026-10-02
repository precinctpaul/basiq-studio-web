/**
 * burn-subs.test.mjs — the SUBTITLES export toggle.
 *
 * The first test is the important one: with subtitles OFF the ffmpeg argv
 * must be exactly what it was before the feature existed. The rest pin the
 * in-memory cue building (lib/burn-subs.ts), which works on a copy of the
 * transcript rows and never writes them back.
 *
 *   npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildClipArgs } from "../lib/export-clip.ts";
import { planClip } from "../lib/clip-plan.ts";
import { DEFAULT_EXPORT_SETTINGS } from "../lib/export-settings.ts";
import { buildAss, buildCues, wrapWords, outputSize, SUBTITLES_FILTER } from "../lib/burn-subs.ts";

const SRC = { hasVideo: true, hasAudio: true, fps: 29.97 };

test("subtitles OFF leaves the export argv byte-identical", () => {
  const plan = planClip(10, 40, 120, DEFAULT_EXPORT_SETTINGS);
  for (const aspect of ["native", "vertical_crop", "vertical_blur"]) {
    const before = buildClipArgs("%INPUT%", "%OUTPUT%", plan, aspect, SRC, DEFAULT_EXPORT_SETTINGS, 0.2, -0.1, true);
    const off = buildClipArgs("%INPUT%", "%OUTPUT%", plan, aspect, SRC, DEFAULT_EXPORT_SETTINGS, 0.2, -0.1, true, false);
    assert.deepEqual(off, before);
    assert.ok(!off.join(" ").includes("subtitles"));
  }
});

test("subtitles ON changes only the video chain, after crop/scale", () => {
  const plan = planClip(10, 40, 120, DEFAULT_EXPORT_SETTINGS);
  const off = buildClipArgs("%INPUT%", "%OUTPUT%", plan, "vertical_crop", SRC, DEFAULT_EXPORT_SETTINGS);
  const on = buildClipArgs("%INPUT%", "%OUTPUT%", plan, "vertical_crop", SRC, DEFAULT_EXPORT_SETTINGS, 0, 0, true, true);
  assert.equal(on.length, off.length);
  const i = off.indexOf("-filter_complex") + 1;
  on.forEach((a, k) => {
    if (k !== i) assert.equal(a, off[k]);
  });
  const vOff = off[i].split(";")[0];
  const vOn = on[i].split(";")[0];
  assert.equal(vOn, vOff.replace("[vout]", `,${SUBTITLES_FILTER}[vout]`));
});

test("cues are shifted to clip time and clamped to the window", () => {
  const segs = [
    { start_seconds: 5, end_seconds: 9, text: "before the window starts" },
    { start_seconds: 9, end_seconds: 12, text: "straddles the start" },
    { start_seconds: 12, end_seconds: 15, text: "fully inside" },
    { start_seconds: 19, end_seconds: 25, text: "straddles the end" },
    { start_seconds: 30, end_seconds: 31, text: "after" },
  ];
  const cues = buildCues(segs, { start: 10, end: 20 }, 40);
  assert.deepEqual(
    cues.map((c) => [c.start, c.end, c.lines.join(" ")]),
    [
      [0, 2, "straddles the start"],
      [2, 5, "fully inside"],
      [9, 10, "straddles the end"],
    ],
  );
});

test("overlapping cues are trimmed so they never stack", () => {
  const cues = buildCues(
    [
      { start_seconds: 0, end_seconds: 5, text: "one" },
      { start_seconds: 3, end_seconds: 6, text: "two" },
    ],
    { start: 0, end: 10 },
    40,
  );
  assert.equal(cues[0].end, 3);
  assert.equal(cues[1].start, 3);
});

test("long segments wrap to <= max chars and <= 2 lines per cue, in order", () => {
  const text =
    "Look, our mandate here is simple. We got to fight for the people who sent us to Washington DC. Not for the fraudsters, not for the career politicians.";
  const cues = buildCues([{ start_seconds: 0, end_seconds: 12, text }], { start: 0, end: 20 }, 24);
  assert.ok(cues.length >= 2);
  for (const c of cues) {
    assert.ok(c.lines.length <= 2);
    for (const l of c.lines) assert.ok(l.length <= 24, l);
  }
  assert.equal(cues.map((c) => c.lines.join(" ")).join(" "), text);
  for (let k = 1; k < cues.length; k++) assert.ok(cues[k].start >= cues[k - 1].end - 1e-9);
  assert.ok(Math.abs(cues.at(-1).end - 12) < 1e-9);
});

test("a word longer than the line limit gets its own line instead of being lost", () => {
  assert.deepEqual(wrapWords("a supercalifragilistic b", 10), ["a", "supercalifragilistic", "b"]);
});

test("ASS output: canvas follows output aspect, text is padded and escaped", () => {
  const segs = [{ start_seconds: 1, end_seconds: 3, text: "a {\\b1} tag" }];
  const land = buildAss(segs, { start: 0, end: 10 }, 1920, 1080);
  assert.match(land, /PlayResX: 512\n/);
  assert.match(land, /PlayResY: 288\n/);
  assert.match(land, /Style: Default,Recoleta Bold,28,&H0094EBE7,&H0094EBE7,&H00000000,&H00111111,.*,4,2,0,2,/);
  const line = land.split("\n").find((l) => l.startsWith("Dialogue:"));
  const pad = String.raw`{\1a&HFF&\3a&HFF&}n{\1a&H00&\3a&H00&}`;
  assert.equal(line, `Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,${pad}a (\u2216b1) tag${pad}`);
  // No glyph Recoleta lacks (U+00A0 drew missing-glyph boxes on the droplet).
  assert.ok(!land.includes("\u00A0"));

  const port = buildAss(segs, { start: 0, end: 10 }, 1080, 1920);
  assert.match(port, /PlayResX: 162\n/);
  assert.match(port, /Style: Default,Recoleta Bold,14,/);

  // Unknown source size falls back to 16:9 landscape.
  assert.match(buildAss(segs, { start: 0, end: 10 }, 0, 0), /PlayResX: 512\n/);
});

test("output size follows the aspect mode", () => {
  assert.deepEqual(outputSize("native", 1280, 720, 1080, 1920), { width: 1280, height: 720 });
  assert.deepEqual(outputSize("vertical_blur", 1280, 720, 1080, 1920), { width: 1080, height: 1920 });
});

test("a segment that began before IN shows only what's spoken after IN, with no overlap", () => {
  // The real case that stacked two subtitles: a long segment ending just
  // after the window start, followed immediately by the next segment.
  const segs = [
    { start_seconds: 11.679, end_seconds: 18.4, text: "vice president been up to? What's his goal? >> Errol, good morning. Well, look, JD" },
    { start_seconds: 18.4, end_seconds: 25.119, text: "Vance will speak here in Central Florida along with gubernatorial candidate Byron Donald." },
  ];
  const cues = buildCues(segs, { start: 18, end: 47 }, 40);
  // Only the tail of the first segment ("look, JD") falls after IN.
  assert.deepEqual(cues[0].lines, ["look, JD"]);
  assert.ok(Math.abs(cues[0].end - 0.4) < 1e-9);
  for (let k = 1; k < cues.length; k++) assert.ok(cues[k].start >= cues[k - 1].end - 1e-9);
});

test("a cue dropped as too short doesn't let its predecessor overlap the next one", () => {
  const cues = buildCues(
    [
      { start_seconds: 0, end_seconds: 2, text: "first" },
      { start_seconds: 1.0, end_seconds: 1.02, text: "blip" },
      { start_seconds: 1.0, end_seconds: 4, text: "third" },
    ],
    { start: 0, end: 10 },
    40,
  );
  for (let k = 1; k < cues.length; k++) assert.ok(cues[k].start >= cues[k - 1].end - 1e-9, JSON.stringify(cues));
});
