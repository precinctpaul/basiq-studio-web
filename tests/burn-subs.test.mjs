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
import { buildAss, buildCues, wrapWords, outputSize, decodeEntities, SUBTITLES_FILTER } from "../lib/burn-subs.ts";

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

const texts = (cues) => cues.map((c) => c.lines.join(" "));
const noOverlap = (cues) => {
  for (let k = 1; k < cues.length; k++) assert.ok(cues[k].start >= cues[k - 1].end - 1e-9, JSON.stringify(cues));
};

test("cues are shifted to clip time, and only words inside the window are used", () => {
  const segs = [
    { start_seconds: 5, end_seconds: 9, text: "before the window starts." },
    { start_seconds: 9, end_seconds: 12, text: "straddles the start." },
    { start_seconds: 12, end_seconds: 15, text: "Fully inside." },
    { start_seconds: 19, end_seconds: 25, text: "Straddles the end." },
    { start_seconds: 30, end_seconds: 31, text: "after" },
  ];
  const cues = buildCues(segs, { start: 10, end: 20 }, 40);
  // "straddles" (9.0-10.4s) is still being spoken at IN; "Straddles" (19.0-21.1s)
  // is too at OUT. Everything wholly outside 10-20s is gone.
  assert.deepEqual(texts(cues), ["straddles the start.", "Fully inside.", "Straddles"]);
  assert.equal(cues[0].start, 0);
  assert.ok(Math.abs(cues[1].start - 2) < 1e-9);
  assert.equal(cues.at(-1).end, 10);
  noOverlap(cues);
});

test("a question and its answer in ONE segment become two cues (the Whisper run-on)", () => {
  // Real Whisper segments from the Talarico interview.
  const segs = [
    { start_seconds: 24.68, end_seconds: 26.34, text: "very same thing happened. Why are they so" },
    { start_seconds: 26.46, end_seconds: 27.5, text: "scared of you? Well" },
    { start_seconds: 27.55, end_seconds: 29.29, text: "they're worried that we're going to win this" },
    { start_seconds: 29.39, end_seconds: 31.75, text: "race in Texas. They are" },
  ];
  const t = texts(buildCues(segs, { start: 24, end: 32 }, 40));
  assert.ok(t.includes("Why are they so scared of you?"), JSON.stringify(t));
  assert.ok(t.some((x) => x.startsWith("Well they're worried")), JSON.stringify(t));
  assert.ok(!t.some((x) => x.includes("you? Well")), JSON.stringify(t));
});

test(">> speaker changes start a new cue and the marker stays on screen", () => {
  const cues = buildCues(
    [{ start_seconds: 0, end_seconds: 6, text: "What has he been up to >> Errol, good morning. Well, look" }],
    { start: 0, end: 10 },
    40,
  );
  assert.deepEqual(texts(cues), ["What has he been up to", ">> Errol, good morning.", "Well, look"]);
  assert.ok(cues[1].lines[0].startsWith(">> "));
  // Glued marker, no space.
  assert.deepEqual(
    texts(buildCues([{ start_seconds: 0, end_seconds: 3, text: "Thanks >>Sure thing" }], { start: 0, end: 5 }, 40)),
    ["Thanks", ">> Sure thing"],
  );
});

test("a pause ends a cue; abbreviations and initials don't", () => {
  const segs = [
    { start_seconds: 0, end_seconds: 2, text: "under Donald J. Trump and" },
    { start_seconds: 2, end_seconds: 3, text: "Sen. Moody" },
    { start_seconds: 4, end_seconds: 5, text: "after a pause" },
  ];
  assert.deepEqual(texts(buildCues(segs, { start: 0, end: 10 }, 40)), [
    "under Donald J. Trump and Sen. Moody",
    "after a pause",
  ]);
});

test("overlapping segments never produce stacked cues", () => {
  const cues = buildCues(
    [
      { start_seconds: 0, end_seconds: 5, text: "one." },
      { start_seconds: 3, end_seconds: 6, text: "Two." },
    ],
    { start: 0, end: 10 },
    40,
  );
  assert.deepEqual(texts(cues), ["one.", "Two."]);
  noOverlap(cues);
});

test("short cues are held up to 1s in silence, never over the next cue", () => {
  const cues = buildCues(
    [
      { start_seconds: 0, end_seconds: 0.3, text: "Yes." },
      { start_seconds: 2, end_seconds: 2.3, text: "No." },
      { start_seconds: 2.5, end_seconds: 4, text: "Maybe so." },
    ],
    { start: 0, end: 10 },
    40,
  );
  assert.equal(cues[0].end, 1);
  assert.equal(cues[1].end, 2.5);
  noOverlap(cues);
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
  assert.equal(line, `Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,${pad}a (/b1) tag${pad}`);
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
  // Only "look, JD" of the first segment is spoken after IN; it runs straight
  // on into the next segment's words, which continue the same sentence.
  assert.ok(cues[0].lines.join(" ").startsWith("look, JD Vance will speak"), JSON.stringify(cues[0]));
  assert.equal(cues[0].start, 0);
  assert.ok(!texts(cues).join(" ").includes("Errol"));
  noOverlap(cues);
});

test("a cue dropped as too short doesn't let its predecessor overlap the next one", () => {
  const cues = buildCues(
    [
      { start_seconds: 0, end_seconds: 2, text: "first." },
      { start_seconds: 1.0, end_seconds: 1.02, text: "Blip." },
      { start_seconds: 1.0, end_seconds: 4, text: "Third." },
    ],
    { start: 0, end: 10 },
    40,
  );
  noOverlap(cues);
});

test("a full cue never leaves the last word or two of a sentence on its own", () => {
  const segs = [
    { start_seconds: 0, end_seconds: 4, text: "I'm doing well This is not this is not the first time you've been demoted to YouTube." },
    { start_seconds: 4, end_seconds: 6, text: "When you were on the show." },
  ];
  const t = texts(buildCues(segs, { start: 0, end: 10 }, 40));
  assert.ok(!t.includes("YouTube."), JSON.stringify(t));
  assert.ok(t.some((x) => x.endsWith("demoted to YouTube.")), JSON.stringify(t));
});

test("HTML-encoded >> from imported YouTube captions is a real speaker change", () => {
  // Real segments (Kimmel / Talarico, source imported-vtt).
  const segs = [
    { start_seconds: 68.99, end_seconds: 69.0, text: "[music]" },
    { start_seconds: 69.0, end_seconds: 69.84, text: "&gt;&gt; How are you?" },
    { start_seconds: 69.84, end_seconds: 70.84, text: "&gt;&gt; I'm doing well." },
    { start_seconds: 72.6, end_seconds: 74.44, text: "you've been demoted to YouTube. When you" },
    { start_seconds: 74.44, end_seconds: 76.12, text: "were on Stephen Colbert's show" },
    { start_seconds: 76.12, end_seconds: 76.72, text: "&gt;&gt; That's right." },
  ];
  const t = texts(buildCues(segs, { start: 68, end: 78 }, 40));
  assert.ok(!t.join(" ").includes("&gt;"), JSON.stringify(t));
  assert.ok(t.includes(">> How are you?"), JSON.stringify(t));
  assert.ok(t.includes(">> I'm doing well."), JSON.stringify(t));
  assert.ok(t.some((x) => x.endsWith("Colbert's show")), JSON.stringify(t));
  assert.ok(t.includes(">> That's right."), JSON.stringify(t));
});

test("decodeEntities handles named and numeric references, and never yields NBSP", () => {
  assert.equal(decodeEntities("&gt;&gt; Tom &amp; Jerry &quot;hi&quot; it&#39;s &#x27;ok&#x27;"), `>> Tom & Jerry "hi" it's 'ok'`);
  assert.equal(decodeEntities("a&nbsp;b&#160;c"), "a b c");
  assert.equal(decodeEntities("&bogus; stays"), "&bogus; stays");
});
