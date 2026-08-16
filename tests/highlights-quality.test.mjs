/**
 * highlights-quality.test.mjs — Key Moments are tested on OUTPUT QUALITY, not
 * on matching the desktop app.
 *
 * This deliberately replaces the old byte-for-byte parity test against
 * app/highlights.py. That test passed while the feature was unusable: the
 * desktop's adjacent-pair segmentation collapses on real Whisper output,
 * producing two sections for a six-minute hearing — one of them 345 seconds
 * long. Parity with a broken reference is not a useful guarantee, so the
 * algorithm was rewritten (proper TextTiling block comparison + depth scoring
 * + a maximum section length) and the test now asserts the properties that
 * make Key Moments navigable in the first place.
 *
 * Every other parity test in this directory still stands — the FFmpeg filter
 * graphs and paragraph grouping must match the desktop exactly, because those
 * decide what lands in an exported file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupParagraphs } from "../lib/paragraphs.ts";
import { extractTopicSections } from "../lib/highlights.ts";

/**
 * A synthetic transcript with the shape real Whisper output has: many short
 * segments, and topic blocks whose vocabulary genuinely changes. Built rather
 * than fixtured so the topic structure is known and the assertions can be
 * about structure rather than about specific strings.
 */
function buildTranscript() {
  // Four subjects, each stated several ways so its vocabulary is coherent
  // across a stretch and clearly different from its neighbours' — which is
  // exactly the signal topic segmentation is supposed to find.
  const topics = [
    [
      "the committee will come to order today we examine rural hospital funding across the state.",
      "medicaid reimbursement shortfalls have left rural hospitals unable to cover emergency care.",
      "community health centers report rural patients driving two hours for basic treatment.",
      "rural hospital closures accelerated after medicaid reimbursement rates were frozen.",
    ],
    [
      "turning now to infrastructure spending on roads bridges and highway maintenance statewide.",
      "the department requests bridge repair funding for spans flagged structurally deficient.",
      "highway maintenance has lagged behind population growth in several fast growing counties.",
      "bridge inspections found deficient spans carrying freight traffic on rural highways.",
    ],
    [
      "next we consider broadband access for schools and libraries in underserved districts.",
      "students without home broadband cannot complete assignments creating a homework gap.",
      "library districts request grants to expand public wifi and lend connected devices.",
      "broadband mapping overstates coverage leaving rural households without real service.",
    ],
    [
      "finally the committee reviews teacher pay scales and classroom staffing shortages.",
      "districts report teaching vacancies in mathematics and special education every region.",
      "salary compression makes it hard to retain experienced classroom teachers statewide.",
      "teacher preparation enrollment fell sharply reducing the pipeline into classrooms.",
    ],
  ];

  const segments = [];
  let t = 0;
  for (const topic of topics) {
    for (const sentence of topic) {
      // Split each sentence into short segments the way Whisper emits them,
      // keeping the sentence-final period on the last one so groupParagraphs
      // has a real break to find.
      const words = sentence.split(" ");
      const per = 4;
      for (let i = 0; i < words.length; i += per) {
        segments.push({ start: t, end: t + 4, text: words.slice(i, i + per).join(" ") });
        t += 4;
      }
    }
  }
  return segments;
}

test("Key Moments produce navigable, well-distributed sections", () => {
  const segments = buildTranscript();
  const paragraphs = groupParagraphs(segments);
  const total = segments[segments.length - 1].end - segments[0].start;
  const target = 60;
  const sections = extractTopicSections(paragraphs, target);

  assert.ok(sections.length >= 3, `expected several sections, got ${sections.length}`);

  // The defect this test exists for: one section swallowing the transcript.
  const longest = Math.max(...sections.map((s) => s.end - s.start));
  assert.ok(
    longest <= target * 1.9,
    `longest section ${longest.toFixed(0)}s exceeds the cap for a ${target}s target`,
  );
  assert.ok(
    longest < total * 0.6,
    `one section covers ${((longest / total) * 100).toFixed(0)}% of the transcript`,
  );

  // Chronological, contiguous, and covering the whole transcript.
  for (let i = 1; i < sections.length; i++) {
    assert.ok(sections[i].start >= sections[i - 1].start, "sections must run in order");
    assert.ok(sections[i].start >= sections[i - 1].end - 0.001, "sections must not overlap");
  }
  assert.equal(sections[0].start, paragraphs[0].start, "must start at the transcript start");
  assert.equal(
    sections[sections.length - 1].end,
    paragraphs[paragraphs.length - 1].end,
    "must run to the transcript end",
  );

  // Every section must be labelled with something, and not all the same thing.
  for (const s of sections) {
    assert.ok(s.label && s.label.trim().length > 0, "every section needs a label");
    assert.ok(s.text.trim().length > 0, "every section needs its text for summarising");
  }
  assert.ok(
    new Set(sections.map((s) => s.label)).size > 1,
    "labels must distinguish sections from each other",
  );
});

test("boundaries land near real topic changes, not bunched at the start", () => {
  const segments = buildTranscript();
  const paragraphs = groupParagraphs(segments);
  const total = segments[segments.length - 1].end;
  const sections = extractTopicSections(paragraphs, 60);

  // The old algorithm put every cut in the opening seconds. At least one
  // boundary must fall in the back half of the transcript.
  const cuts = sections.slice(1).map((s) => s.start);
  assert.ok(cuts.length > 0, "expected at least one boundary");
  assert.ok(
    cuts.some((c) => c > total * 0.5),
    `all ${cuts.length} boundaries fell in the first half: ${cuts.map((c) => c.toFixed(0)).join(", ")}`,
  );
});

test("degenerate inputs stay safe", () => {
  assert.deepEqual(extractTopicSections([]), []);
  // Too little text to say anything about.
  const tiny = groupParagraphs([{ start: 0, end: 2, text: "hello there" }]);
  assert.deepEqual(extractTopicSections(tiny), []);
});

test("a single-topic transcript still yields entry points rather than one block", () => {
  // Uniform vocabulary means shallow valleys everywhere — the case where
  // depth scoring alone finds nothing and the length cap has to carry it.
  const segments = [];
  for (let i = 0; i < 90; i++) {
    segments.push({
      start: i * 5,
      end: i * 5 + 5,
      text: "the budget allocates funding for the budget committee review process",
    });
  }
  const sections = extractTopicSections(groupParagraphs(segments), 60);
  const longest = Math.max(...sections.map((s) => s.end - s.start));
  assert.ok(sections.length >= 2, "even a uniform transcript needs entry points");
  assert.ok(longest <= 60 * 1.9, `uniform transcript left a ${longest.toFixed(0)}s block`);
});
