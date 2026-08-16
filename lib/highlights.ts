/**
 * highlights.ts — split a transcript into navigable topical sections and
 * label each one, with plain math: no model, no download, nothing leaving the
 * machine.
 *
 * ---------------------------------------------------------------------------
 * DELIBERATE DIVERGENCE FROM app/highlights.py
 *
 * This started as a faithful port and is no longer one. The original compares
 * only ADJACENT paragraph pairs to find topic boundaries, which collapses on
 * real Whisper output: a 368s hearing groups into ~64 paragraphs of ~6s and
 * ~15 words, and most adjacent pairs share no content words at all, so their
 * cohesion is exactly 0. Ties among those zeros break by index ascending, so
 * every chosen cut lands in the first few paragraphs and the short-group merge
 * then folds them into one tiny section plus one enormous one. Measured on a
 * real transcript, that produced exactly two sections: 2-23s, then 23-368s.
 * A 345-second "moment" is not a moment.
 *
 * So this implements the actual Hearst TextTiling algorithm instead of the
 * simplified adjacent-pair version:
 *
 *   1. BLOCK COMPARISON. Each gap is scored by comparing a WINDOW of
 *      paragraphs on each side, not one against one. Blocks of ~4 paragraphs
 *      carry enough vocabulary to overlap meaningfully, which turns a spiky
 *      mostly-zero signal into a smooth curve with real minima.
 *   2. DEPTH SCORING. A boundary is not "a low score", it is "a valley" —
 *      how far the curve falls from the peaks on either side. This is what
 *      makes boundaries comparable across a transcript whose overall
 *      wordiness drifts.
 *   3. TIME SPACING. Cuts must be separated in SECONDS, not paragraph count.
 *      Paragraph count is a poor proxy when paragraphs vary 1s to 14s.
 *
 * Labelling stays TF-IDF and is unchanged in spirit: a term frequent in a
 * section but rare elsewhere is what makes it distinctive. Labels are the
 * FALLBACK — when the local agent has the summariser installed, each section
 * gets a written sentence instead (see tools/basiq_agent.py /summarize).
 * ---------------------------------------------------------------------------
 */

import type { Paragraph } from "./paragraphs";

// Deliberately a hand-picked list rather than a stopword package — it only
// needs to keep "the", "and", "that" from dominating cohesion and scoring.
const _STOPWORDS_RAW = `
a an the and or but if then so because as until while of at by for with
about against between into through during before after above below to from
up down in out on off over under again further here there when where why
how all any both each few more most other some such no nor not only own
same than too very s t can will just don should now is am are was were be
been being have has had having do does did doing would could ought i you
he she it we they me him her us them my your his its our their this that
these those what which who whom
i'm i've i'd i'll you're you've you'd you'll he's he'd he'll she's she'd
she'll it's it'd we're we've we'd we'll they're they've they'd they'll
that's that'd who's what's here's there's don't doesn't didn't isn't aren't
wasn't weren't won't wouldn't can't couldn't shouldn't ain't let's
gonna gotta wanna kinda sorta yeah yep nope okay ok uh um uh huh
well right know knows knew think thinks thought going goes went get gets
got getting lot lots really actually basically literally kind sort thing
things stuff way ways like look looks looked said says say tell told
`;
const STOPWORDS: ReadonlySet<string> = new Set(_STOPWORDS_RAW.split(/\s+/).filter(Boolean));

const WORD_RE = /[a-z']+/g;

export const MIN_TOTAL_WORDS = 20;
export const MIN_SECTION_SECONDS = 25.0;
export const TARGET_SECTION_SECONDS = 60.0;
export const MIN_SECTIONS = 2;
export const MAX_SECTIONS = 12;
export const MAX_LABEL_TERMS = 3;
/** Paragraphs per side in the block comparison. ~4 keeps a block near 60-100
 *  words, which is roughly TextTiling's original token-sequence sizing. */
export const BLOCK_WINDOW = 4;

export interface TopicSection {
  start: number;
  end: number;
  label: string;
  text: string;
}

type Counts = Map<string, number>;

function tokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(WORD_RE)) {
    const t = m[0].replace(/^'+|'+$/g, "");
    if (t) out.push(t);
  }
  return out;
}

function bump(counts: Counts, key: string, by = 1): void {
  counts.set(key, (counts.get(key) ?? 0) + by);
}

/** Unigrams + adjacent bigrams, stopwords and 1-2 letter words dropped. */
function phrases(text: string): Counts {
  const toks = tokens(text).filter((t) => !STOPWORDS.has(t) && t.length > 2);
  const counts: Counts = new Map();
  for (const t of toks) bump(counts, t);
  for (let i = 0; i < toks.length - 1; i++) {
    const a = toks[i];
    const b = toks[i + 1];
    if (a === b) continue; // artifact of stopword removal, not a real phrase
    bump(counts, `${a} ${b}`);
  }
  return counts;
}

function mergeCounts(list: Counts[]): Counts {
  const out: Counts = new Map();
  for (const c of list) for (const [k, v] of c) bump(out, k, v);
  return out;
}

/**
 * Cosine similarity over the two blocks' term vectors.
 *
 * Cosine rather than the original's shared-count-over-log-sizes: block
 * comparison puts unequal amounts of text on each side near the transcript
 * edges, and cosine is scale-invariant, so a boundary near the start isn't
 * scored differently from one in the middle purely because of block size.
 */
function similarity(a: Counts, b: Counts): number {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [term, x] of small) {
    const y = large.get(term);
    if (y !== undefined) dot += x * y;
  }
  if (dot === 0) return 0;
  let na = 0;
  for (const v of a.values()) na += v * v;
  let nb = 0;
  for (const v of b.values()) nb += v * v;
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/**
 * TF-IDF label for one section: terms frequent here and rare elsewhere.
 * Once a term is picked, anything sharing a word with it is skipped so a
 * label never reads "american people · people · american".
 */
function labelFor(sectionCounts: Counts, otherCounts: Counts[], maxTerms: number): string {
  if (sectionCounts.size === 0) return "General discussion";
  const nSections = otherCounts.length + 1;

  const scored: Array<[number, number, string]> = [];
  for (const [term, tf] of sectionCounts) {
    let score: number;
    if (nSections <= 1) {
      score = tf;
    } else {
      let df = 1;
      for (const c of otherCounts) if (c.has(term)) df += 1;
      score = tf * Math.log(nSections / df);
    }
    scored.push([score, term.length, term]);
  }
  scored.sort((x, y) => y[0] - x[0] || y[1] - x[1] || (y[2] > x[2] ? 1 : y[2] < x[2] ? -1 : 0));

  const top: string[] = [];
  const usedWords = new Set<string>();
  for (const [, , term] of scored) {
    const words = term.split(" ");
    if (words.some((w) => usedWords.has(w))) continue;
    top.push(term);
    for (const w of words) usedWords.add(w);
    if (top.length >= maxTerms) break;
  }
  return top.length > 0 ? top.join(" · ") : "General discussion";
}

/**
 * Depth score for every gap: how far the similarity curve falls into this
 * valley from the nearest peak on each side. Hearst's own boundary metric.
 * A shallow dip inside a rambling stretch scores low; a genuine subject
 * change scores high even if its absolute similarity isn't the lowest.
 */
function depthScores(scores: number[]): number[] {
  const n = scores.length;
  const depths = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let left = scores[i];
    for (let j = i - 1; j >= 0; j--) {
      if (scores[j] < left) break;
      left = scores[j];
    }
    let right = scores[i];
    for (let j = i + 1; j < n; j++) {
      if (scores[j] < right) break;
      right = scores[j];
    }
    depths[i] = left - scores[i] + (right - scores[i]);
  }
  return depths;
}

/**
 * Gap indices to cut at ("a boundary falls right after this paragraph"),
 * chosen by depth and spaced by TIME so they land across the whole transcript
 * instead of bunching wherever the vocabulary happens to thin out.
 */
export function boundaries(
  paragraphs: Paragraph[],
  targetSections: number,
  minGapSeconds: number,
  maxSectionSeconds: number,
  maxCuts: number,
): number[] {
  const n = paragraphs.length;
  const need = targetSections - 1;
  if (need <= 0 || n < 2) return [];

  const counts = paragraphs.map((p) => phrases(p.text));

  // Block comparison: aggregate BLOCK_WINDOW paragraphs each side of the gap.
  const scores: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const left = mergeCounts(counts.slice(Math.max(0, i - BLOCK_WINDOW + 1), i + 1));
    const right = mergeCounts(counts.slice(i + 1, Math.min(n, i + 1 + BLOCK_WINDOW)));
    scores.push(similarity(left, right));
  }

  const depths = depthScores(scores);
  const chosen: number[] = [];
  const spacedOk = (idx: number) =>
    !chosen.some((c) => Math.abs(paragraphs[c].end - paragraphs[idx].end) < minGapSeconds);

  // Phase 1 — take the genuine topic shifts, deepest first.
  const ranked = depths.map((d, i) => [d, i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [depth, idx] of ranked) {
    if (chosen.length >= need) break;
    // Zero depth is flat, not a valley. Taking those reintroduces the
    // arbitrary index-order clustering this algorithm exists to avoid.
    if (depth <= 0) break;
    if (!spacedOk(idx)) continue;
    chosen.push(idx);
  }

  // Phase 2 — no section may run absurdly long.
  //
  // Depth alone bunches: on a hearing transcript the vocabulary churns hardest
  // during the swearing-in, so the deepest valleys all sit in the first minute
  // and the body of the speech — topically uniform, shallow valleys — is left
  // as one unusable block. Measured before this phase existed: cuts at 19s,
  // 44s, 69s, then nothing until 242s.
  //
  // So: while any section exceeds the cap, split the worst offender at ITS
  // best interior gap. Still boundary-aware (it picks the deepest available
  // valley), but guarantees an upper bound on how long a "moment" can be.
  for (let guard = 0; guard < 64; guard++) {
    if (chosen.length >= maxCuts) break;
    chosen.sort((a, b) => a - b);

    const ranges: Array<[number, number]> = [];
    let s = 0;
    for (const c of chosen) {
      ranges.push([s, c]);
      s = c + 1;
    }
    ranges.push([s, n - 1]);

    let worst: [number, number] | null = null;
    let worstLen = 0;
    for (const [a, b] of ranges) {
      if (b <= a) continue;
      const len = paragraphs[b].end - paragraphs[a].start;
      if (len > worstLen) {
        worstLen = len;
        worst = [a, b];
      }
    }
    if (!worst || worstLen <= maxSectionSeconds) break;

    let best = -1;
    let bestDepth = -Infinity;
    for (let i = worst[0]; i < worst[1]; i++) {
      if (!spacedOk(i)) continue;
      if (depths[i] > bestDepth) {
        bestDepth = depths[i];
        best = i;
      }
    }
    if (best < 0) break; // nothing splittable without violating spacing
    chosen.push(best);
  }

  return chosen.sort((a, b) => a - b);
}

/** Fold any section shorter than MIN_SECTION_SECONDS into a neighbour. */
function mergeShortGroups(groups: Paragraph[][], minSeconds: number): Paragraph[][] {
  const result = groups.map((g) => [...g]);
  let changed = true;
  while (changed && result.length > 1) {
    changed = false;
    for (let i = 0; i < result.length; i++) {
      const group = result[i];
      if (group[group.length - 1].end - group[0].start >= minSeconds) continue;
      if (i + 1 < result.length) {
        result[i + 1] = [...group, ...result[i + 1]];
      } else {
        result[i - 1] = [...result[i - 1], ...group];
      }
      result.splice(i, 1);
      changed = true;
      break;
    }
  }
  return result;
}

export function extractTopicSections(
  paragraphs: Paragraph[],
  targetSectionSeconds = TARGET_SECTION_SECONDS,
  minSections = MIN_SECTIONS,
  maxSections = MAX_SECTIONS,
  maxTerms = MAX_LABEL_TERMS,
): TopicSection[] {
  if (paragraphs.length === 0) return [];
  const totalWords = paragraphs.reduce(
    (sum, p) => sum + p.text.split(/\s+/).filter(Boolean).length,
    0,
  );
  if (totalWords < MIN_TOTAL_WORDS) return [];

  const totalDuration = Math.max(0, paragraphs[paragraphs.length - 1].end - paragraphs[0].start);
  let target = targetSectionSeconds > 0 ? Math.round(totalDuration / targetSectionSeconds) : 1;
  target = Math.max(minSections, Math.min(maxSections, target, paragraphs.length));

  // Cuts must be most of a target section apart, so "moments" stay evenly
  // navigable rather than clustering wherever the vocabulary churns.
  const minGap = Math.max(MIN_SECTION_SECONDS, targetSectionSeconds * 0.6);
  // A section may run half again past target before it stops being a moment.
  const maxSection = targetSectionSeconds * 1.6;
  const cuts = boundaries(paragraphs, target, minGap, maxSection, maxSections - 1);

  const groups: Paragraph[][] = [];
  let startI = 0;
  for (const cut of cuts) {
    groups.push(paragraphs.slice(startI, cut + 1));
    startI = cut + 1;
  }
  groups.push(paragraphs.slice(startI));
  const merged = mergeShortGroups(groups, Math.min(MIN_SECTION_SECONDS, totalDuration / 2));

  const groupCounts = merged.map((group) =>
    mergeCounts(group.map((p) => phrases(p.text))),
  );

  return merged.map((group, gi) => {
    const other = [...groupCounts.slice(0, gi), ...groupCounts.slice(gi + 1)];
    return {
      start: group[0].start,
      end: group[group.length - 1].end,
      label: labelFor(groupCounts[gi], other, maxTerms),
      text: group.map((p) => p.text).join(" "),
    };
  });
}
