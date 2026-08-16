/**
 * paragraphs.ts — port of the grouping half of app/transcript.py.
 *
 * The web app doesn't need that file's PARSING half (v1/SRT/VTT/plain-text
 * format detection): segments arrive as JSON straight from
 * tools/whisper_server.py, not as an imported sidecar file, so there is
 * nothing to sniff the format of. What does carry over unchanged is the
 * paragraph-grouping heuristic — the actual editorial judgment call about
 * where one paragraph ends and the next begins — which is exactly the part
 * worth keeping byte-for-byte identical to the desktop app.
 */

export const SENTENCE_END = ".!?…\"”’)";
export const GAP_THRESHOLD = 1.2; // seconds of silence that force a new paragraph
export const MAX_PARAGRAPH_CHARS = 700; // keep blocks scannable even in a filibuster

export interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface Paragraph {
  start: number;
  end: number;
  text: string;
  segments: Segment[];
}

/**
 * Port of transcript.group_paragraphs (app/transcript.py:135).
 *
 * Break on: a silence gap > threshold, OR a sentence-final segment, OR a
 * paragraph growing past max_chars. Whisper emits sentence-ish segments, so
 * the punctuation rule does most of the work and the gap rule catches
 * speaker changes in hearings.
 */
export function groupParagraphs(
  segments: Segment[],
  gapThreshold = GAP_THRESHOLD,
  maxChars = MAX_PARAGRAPH_CHARS,
): Paragraph[] {
  const paras: Paragraph[] = [];
  let current: Segment[] = [];
  let length = 0;

  const flush = () => {
    if (current.length === 0) return;
    paras.push({
      start: current[0].start,
      end: current[current.length - 1].end,
      text: current.map((s) => s.text).join(" ").trim(),
      segments: [...current],
    });
    current = [];
    length = 0;
  };

  for (const seg of segments) {
    if (current.length > 0) {
      const prev = current[current.length - 1];
      const gap = seg.start - prev.end;
      const prevText = prev.text;
      const endsSentence = prevText.length > 0 && SENTENCE_END.includes(prevText[prevText.length - 1]);
      if (gap > gapThreshold || endsSentence || length >= maxChars) {
        flush();
      }
    }
    current.push(seg);
    length += seg.text.length + 1;
  }

  flush();
  return paras;
}

/** Port of transcript.segments_in_range (app/transcript.py:179). */
export function segmentsInRange(segments: Segment[], start: number, end: number): Segment[] {
  return segments.filter((s) => s.end > start && s.start < end);
}
