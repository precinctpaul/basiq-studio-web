/**
 * paragraphs-parity.test.mjs — proves lib/paragraphs.ts's groupParagraphs
 * produces identical paragraph breaks to the desktop app's group_paragraphs
 * (app/transcript.py), by shelling out to the real Python function rather
 * than a hand-written expectation. Same pattern as filter-parity.test.mjs;
 * skips itself when the desktop checkout isn't present (CI, Vercel).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { groupParagraphs } from "../lib/paragraphs.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = process.env.DESKTOP_APP_DIR ?? "C:\\dev\\basiq_studio_hub";
const DUMPER = path.join(HERE, "dump_desktop_paragraphs.py");

const PYTHON = [
  path.join(DESKTOP, ".venv", "Scripts", "python.exe"),
  path.join(DESKTOP, ".venv", "bin", "python"),
].find((p) => existsSync(p)) ?? "python";

const AVAILABLE = existsSync(DESKTOP) && existsSync(DUMPER);
if (!AVAILABLE) {
  console.log(`# SKIP paragraphs parity: desktop app not found at ${DESKTOP}.`);
}

function desktopOutput() {
  const raw = execFileSync(PYTHON, [DUMPER], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" },
  });
  return JSON.parse(raw);
}

const expected = AVAILABLE ? desktopOutput() : {};

test("groupParagraphs matches the desktop app byte-for-byte", { skip: !AVAILABLE }, () => {
  const caseNames = Object.keys(expected);
  assert.ok(caseNames.length > 0, "dumper produced no cases");

  for (const name of caseNames) {
    const { input, paragraphs: expectedParas } = expected[name];
    const actual = groupParagraphs(input);

    assert.equal(actual.length, expectedParas.length, `[${name}] paragraph count`);
    for (let i = 0; i < expectedParas.length; i++) {
      const e = expectedParas[i];
      const a = actual[i];
      assert.equal(a.text, e.text, `[${name}] paragraph ${i} text`);
      assert.ok(Math.abs(a.start - e.start) < 1e-9, `[${name}] paragraph ${i} start`);
      assert.ok(Math.abs(a.end - e.end) < 1e-9, `[${name}] paragraph ${i} end`);
      assert.equal(a.segments.length, e.n_segments, `[${name}] paragraph ${i} segment count`);
    }
  }
});
