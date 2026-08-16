/**
 * highlights.ts — port of app/highlights.py: split a transcript into a
 * handful of topical sections and label each with its most distinctive
 * terms, entirely with plain math — no model, no download, nothing leaves
 * the machine (or in this case, nothing leaves the Vercel function; there's
 * no ML runtime involved at all).
 *
 * Two textbook ideas, both hand-rolled in the Python original and ported
 * here unchanged:
 *   1. Topic segmentation (TextTiling, Hearst 1997, simplified): lexical
 *      cohesion between adjacent paragraphs dips at a topic shift; the
 *      lowest-cohesion points, spaced apart, become section boundaries.
 *   2. Per-section labelling (TF-IDF): a term frequent IN a section but rare
 *      everywhere ELSE is what makes it distinctive.
 *
 * Deliberately excludes summarize.py's abstractive one-sentence summaries —
 * that half needs a ~1.2GB local model (torch + transformers), which doesn't
 * belong in a Vercel function. key_moments.summary stays null for now; see
 * the Sprint 2 decision note in the API route that calls this.
 */

import type { Paragraph } from "./paragraphs";

// Deliberately the same hand-picked list as the Python original, not a
// pulled-in stopword package — only needs to be good enough to keep "the",
// "and", "that" from dominating cohesion and label scoring. Kept as one
// space-joined string split at load time, matching the source's own
// """...""".split() shape, so a diff against the Python list stays trivial.
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
export const MIN_SECTION_PARAGRAPHS = 2;
export const MIN_SECTION_SECONDS = 20.0;
export const TARGET_SECTION_SECONDS = 75.0;
export const MIN_SECTIONS = 2;
export const MAX_SECTIONS = 10;
export const MAX_LABEL_TERMS = 3;

export interface TopicSection {
  start: number;
  end: number;
  label: string;
  text: string;
}

function tokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(WORD_RE)) {
    const t = m[0].replace(/^'+|'+$/g, "");
    if (t) out.push(t);
  }
  return out;
}

/**
 * A plain object used as a sparse multiset (Python's collections.Counter).
 * Only the handful of Counter operations _cohesion/_label_for actually use
 * are reimplemented below — this isn't a general-purpose Counter.
 */
type Counts = Map<string, number>;

function bump(counts: Counts, key: string, by = 1): void {
  counts.set(key, (counts.get(key) ?? 0) + by);
}

function sumCounts(counts: Counts): number {
  let total = 0;
  for (const v of counts.values()) total += v;
  return total;
}

/**
 * Port of _phrases (app/highlights.py:89). Unigram + adjacent-bigram counts,
 * stopwords and 1-2 letter words dropped. A bigram of two identical adjacent
 * tokens is skipped — an artifact of stopword removal collapsing whatever
 * sat between two repeats of the same word, not a real phrase.
 */
function phrases(text: string): Counts {
  const toks = tokens(text).filter((t) => !STOPWORDS.has(t) && t.length > 2);
  const counts: Counts = new Map();
  for (const t of toks) bump(counts, t);
  for (let i = 0; i < toks.length - 1; i++) {
    const a = toks[i];
    const b = toks[i + 1];
    if (a === b) continue;
    bump(counts, `${a} ${b}`);
  }
  return counts;
}

/**
 * Port of _cohesion (app/highlights.py:109). Shared terms normalised by the
 * log of each side's size — matches TextRank's own sentence-similarity
 * shape, so two long paragraphs sharing a few words don't automatically look
 * more cohesive than two short ones sharing most of theirs.
 *
 * `a & b` in Python's Counter is an ELEMENTWISE MIN over shared keys (the
 * multiset intersection), not a set intersection — replicated explicitly
 * here since that's an easy thing to get subtly wrong porting Counter code.
 */
function cohesion(a: Counts, b: Counts): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const [term, countA] of a) {
    const countB = b.get(term);
    if (countB !== undefined) shared += Math.min(countA, countB);
  }
  if (shared === 0) return 0;
  const denom = Math.log(sumCounts(a) + 1) + Math.log(sumCounts(b) + 1);
  return denom > 0 ? shared / denom : 0;
}

/**
 * Port of _label_for (app/highlights.py:125).
 *
 * scored.sort(reverse=True) in Python sorts tuples (score, len(term), term)
 * by full tuple comparison then reverses — equivalent to sorting descending
 * on that same field priority, which is what the comparator below does
 * directly: score desc, then term length desc (ties favour the longer,
 * usually-bigram term), then term STRING desc (an arbitrary but
 * deterministic final tiebreak — it only matters for reproducibility, not
 * for which term reads better).
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

  // A bigram and the unigram inside it ("american people" / "people") can
  // both score well; once a term is picked, anything sharing one of its
  // words is skipped so the label doesn't repeat itself.
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
 * Port of _boundaries (app/highlights.py:158). Indices (each meaning "a
 * boundary falls right after this paragraph") for target_sections - 1 cuts,
 * picked at the lowest-cohesion points and spaced at least
 * MIN_SECTION_PARAGRAPHS apart.
 */
function boundaries(paragraphs: Paragraph[], targetSections: number): number[] {
  const n = paragraphs.length;
  const need = targetSections - 1;
  if (need <= 0 || n < 2) return [];

  const phraseCounts = paragraphs.map((p) => phrases(p.text));
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < n - 1; i++) {
    pairs.push([cohesion(phraseCounts[i], phraseCounts[i + 1]), i]);
  }
  // Ascending by cohesion (lowest = biggest topic shift first), tie-broken
  // by index ascending — matches Python's tuple sort of (value, i).
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const chosen: number[] = [];
  for (const [, idx] of pairs) {
    if (chosen.length >= need) break;
    if (chosen.some((c) => Math.abs(idx - c) < MIN_SECTION_PARAGRAPHS)) continue;
    chosen.push(idx);
  }
  return chosen.sort((a, b) => a - b);
}

/**
 * Port of _merge_short_groups (app/highlights.py:181). Folds any group
 * shorter than MIN_SECTION_SECONDS into its next neighbour (or the previous
 * one, if it's the last group) — restarting the scan after every merge
 * (rather than continuing from an adjusted index) since one merge can create
 * another group below the threshold, exactly like the Python `while changed`
 * / `break`-out-of-the-for-loop structure.
 */
function mergeShortGroups(groups: Paragraph[][]): Paragraph[][] {
  const result = groups.map((g) => [...g]);
  let changed = true;
  while (changed && result.length > 1) {
    changed = false;
    for (let i = 0; i < result.length; i++) {
      const group = result[i];
      if (group[group.length - 1].end - group[0].start >= MIN_SECTION_SECONDS) continue;
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

/**
 * Port of extract_topic_sections (app/highlights.py:207). Chops the
 * transcript into a handful of chronological sections and labels each with
 * its most distinctive terms.
 */
export function extractTopicSections(
  paragraphs: Paragraph[],
  targetSectionSeconds = TARGET_SECTION_SECONDS,
  minSections = MIN_SECTIONS,
  maxSections = MAX_SECTIONS,
  maxTerms = MAX_LABEL_TERMS,
): TopicSection[] {
  if (paragraphs.length === 0) return [];
  const totalWords = paragraphs.reduce((sum, p) => sum + p.text.split(/\s+/).filter(Boolean).length, 0);
  if (totalWords < MIN_TOTAL_WORDS) return [];

  const totalDuration = Math.max(0, paragraphs[paragraphs.length - 1].end - paragraphs[0].start);
  let target = targetSectionSeconds > 0 ? Math.round(totalDuration / targetSectionSeconds) : 1;
  target = Math.max(minSections, Math.min(maxSections, target, paragraphs.length));

  const cuts = boundaries(paragraphs, target);
  const groups: Paragraph[][] = [];
  let startI = 0;
  for (const cut of cuts) {
    groups.push(paragraphs.slice(startI, cut + 1));
    startI = cut + 1;
  }
  groups.push(paragraphs.slice(startI));
  const merged = mergeShortGroups(groups);

  const groupCounts = merged.map((group) => {
    const counts: Counts = new Map();
    for (const p of group) {
      for (const [term, n] of phrases(p.text)) bump(counts, term, n);
    }
    return counts;
  });

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
