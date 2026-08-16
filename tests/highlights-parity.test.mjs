/**
 * highlights-parity.test.mjs — proves lib/highlights.ts's extractTopicSections
 * produces identical section boundaries AND identical labels to the desktop
 * app's extract_topic_sections (app/highlights.py), by shelling out to the
 * real Python function. Same pattern as the other *-parity tests; skips
 * itself when the desktop checkout isn't present.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractTopicSections } from "../lib/highlights.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = process.env.DESKTOP_APP_DIR ?? "C:\\dev\\basiq_studio_hub";
const DUMPER = path.join(HERE, "dump_desktop_highlights.py");

const PYTHON = [
  path.join(DESKTOP, ".venv", "Scripts", "python.exe"),
  path.join(DESKTOP, ".venv", "bin", "python"),
].find((p) => existsSync(p)) ?? "python";

const AVAILABLE = existsSync(DESKTOP) && existsSync(DUMPER);
if (!AVAILABLE) {
  console.log(`# SKIP highlights parity: desktop app not found at ${DESKTOP}.`);
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

test("extractTopicSections matches the desktop app byte-for-byte", { skip: !AVAILABLE }, () => {
  const caseNames = Object.keys(expected);
  assert.ok(caseNames.length > 0, "dumper produced no cases");

  for (const name of caseNames) {
    const { input, sections: expectedSections } = expected[name];
    // Paragraph.segments isn't read by extractTopicSections — empty arrays
    // are a faithful stand-in for the real Segment[] the app would supply.
    const paragraphs = input.map((p) => ({ ...p, segments: [] }));
    const actual = extractTopicSections(paragraphs);

    assert.equal(actual.length, expectedSections.length, `[${name}] section count`);
    for (let i = 0; i < expectedSections.length; i++) {
      const e = expectedSections[i];
      const a = actual[i];
      assert.equal(a.label, e.label, `[${name}] section ${i} label`);
      assert.equal(a.text, e.text, `[${name}] section ${i} text`);
      assert.ok(Math.abs(a.start - e.start) < 1e-9, `[${name}] section ${i} start`);
      assert.ok(Math.abs(a.end - e.end) < 1e-9, `[${name}] section ${i} end`);
    }
  }
});
