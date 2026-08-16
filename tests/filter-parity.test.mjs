/**
 * filter-parity.test.mjs — proves the TypeScript port produces byte-identical
 * FFmpeg filter graphs to the desktop Qt app.
 *
 * It shells out to the ACTUAL Python modules in C:\dev\basiq_studio_hub rather
 * than comparing against expectations typed by hand. A hand-written expectation
 * only encodes whatever the port happened to emit the day it was written; this
 * fails the moment the two implementations disagree, which is the entire point.
 *
 * Read-only against the desktop app: PYTHONDONTWRITEBYTECODE stops the import
 * from so much as dropping a .pyc in there.
 *
 *   node --test tests/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cropGeometry } from "../lib/crop.ts";
import { planClip } from "../lib/clip-plan.ts";
import { buildVideoChain, buildAudioChain } from "../lib/ffmpeg-filters.ts";
import { DEFAULT_EXPORT_SETTINGS } from "../lib/export-settings.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where the desktop app lives. Overridable because this only exists on a
 * machine that has the Qt build checked out — CI and Vercel do not, and this
 * suite SKIPS there rather than failing. That is the right trade: parity is a
 * porting guarantee to be checked while porting, not a deploy gate. If it ever
 * becomes a deploy gate, vendor the JSON fixture instead of the Python.
 */
const DESKTOP = process.env.DESKTOP_APP_DIR ?? "C:\\dev\\basiq_studio_hub";
const DUMPER = process.env.PARITY_DUMPER ?? path.join(HERE, "dump_desktop_filters.py");

const PYTHON = [
  path.join(DESKTOP, ".venv", "Scripts", "python.exe"),
  path.join(DESKTOP, ".venv", "bin", "python"),
].find((p) => existsSync(p)) ?? "python";

const AVAILABLE = existsSync(DESKTOP) && existsSync(DUMPER);
if (!AVAILABLE) {
  console.log(
    `# SKIP filter parity: desktop app not found at ${DESKTOP}. ` +
      `Set DESKTOP_APP_DIR to run it.`,
  );
}

function desktopOutput() {
  const raw = execFileSync(PYTHON, [DUMPER], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" },
  });
  return JSON.parse(raw);
}

const EMPTY = { video: [], plans: [], audio: [], geometry: [] };
const expected = AVAILABLE ? desktopOutput() : EMPTY;

test("video filter chains match the desktop app byte-for-byte", { skip: !AVAILABLE }, () => {
  assert.ok(expected.video.length > 0, "dumper produced no video cases");
  for (const c of expected.video) {
    const actual = buildVideoChain(
      c.aspect,
      DEFAULT_EXPORT_SETTINGS,
      c.blur_ok,
      c.offset_x,
      c.offset_y,
    );
    assert.equal(
      actual,
      c.chain,
      `aspect=${c.aspect} blur_ok=${c.blur_ok} offset=(${c.offset_x},${c.offset_y})`,
    );
  }
});

test("clip plans match the desktop app", { skip: !AVAILABLE }, () => {
  for (const c of expected.plans) {
    const p = planClip(c.in, c.out, c.source_duration, DEFAULT_EXPORT_SETTINGS);
    const label = `in=${c.in} out=${c.out} dur=${c.source_duration}`;
    const e = c.plan;
    // Floating point: the two runtimes agree exactly on these operations, but
    // assert a tolerance anyway so a harmless last-bit difference never blocks
    // a deploy. 1e-9 is far tighter than any audible or visible difference.
    const near = (a, b, field) =>
      assert.ok(Math.abs(a - b) < 1e-9, `${label} ${field}: ${a} !== ${b}`);
    near(p.inPoint, e.in_point, "inPoint");
    near(p.outPoint, e.out_point, "outPoint");
    near(p.paddedIn, e.padded_in, "paddedIn");
    near(p.paddedOut, e.padded_out, "paddedOut");
    near(p.duration, e.duration, "duration");
    near(p.fadeIn, e.fade_in, "fadeIn");
    near(p.fadeOut, e.fade_out, "fadeOut");
    near(p.fadeOutStart, e.fade_out_start, "fadeOutStart");
    assert.equal(p.headClipped, e.head_clipped, `${label} headClipped`);
    assert.equal(p.tailClipped, e.tail_clipped, `${label} tailClipped`);
  }
});

test("audio fade chains match the desktop app byte-for-byte", { skip: !AVAILABLE }, () => {
  for (const c of expected.audio) {
    const plan = planClip(c.in, c.out, c.source_duration, DEFAULT_EXPORT_SETTINGS);
    assert.equal(
      buildAudioChain(plan),
      c.chain,
      `in=${c.in} out=${c.out} dur=${c.source_duration}`,
    );
  }
});

test("crop geometry matches the desktop app", { skip: !AVAILABLE }, () => {
  for (const c of expected.geometry) {
    const r = cropGeometry(c.iw, c.ih, c.offset_x, c.offset_y);
    const label = `${c.iw}x${c.ih} offset=(${c.offset_x},${c.offset_y})`;
    for (const k of ["x", "y", "w", "h"]) {
      assert.ok(
        Math.abs(r[k] - c.rect[k]) < 1e-9,
        `${label} ${k}: ${r[k]} !== ${c.rect[k]}`,
      );
    }
  }
});
