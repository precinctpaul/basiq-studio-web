/**
 * burn-subs.ts — builds the ASS subtitle file burned into a clip export when
 * the SUBTITLES toggle is on.
 *
 * READ-ONLY with respect to transcripts. It takes plain copies of segment
 * rows and returns a string; nothing here writes back to transcript_segments,
 * the stored SRTs, or the ingest/cleaning path. Every adjustment below
 * (clamping to the clip window, trimming overlaps, re-wrapping lines) happens
 * on this in-memory copy for one export only. Search, graphics and the member
 * command center read the same transcripts and must never see a difference.
 *
 * The look is ported from the burned_in_subs side project (Recoleta Bold,
 * acid green #E7EB94 on a #111111 box, BorderStyle=4). Two things differ on
 * purpose:
 *
 *  - That project burned an SRT with force_style, which libass lays out on
 *    ffmpeg's default 384x288 script canvas -- so its FontSize=28 / MarginV=30
 *    were fractions of a 288-high frame, not pixels. Writing the ASS directly
 *    with PlayResY=288 reproduces that exact look and scales it to any output
 *    height. PlayResX follows the real output aspect so glyphs aren't
 *    stretched.
 *  - It merged pairs of YouTube rolling-caption fragments into 2-line blocks.
 *    Our segments are already de-rolled, but they're cut by audio duration,
 *    not grammar, so cues are rebuilt from the word stream instead (sentence
 *    ends, >> speaker changes, pauses; at most 2 lines) -- see buildCues.
 *  - Line padding is an invisible Recoleta letter, not the side project's
 *    non-breaking spaces (see PAD).
 */

export interface SubSegment {
  start_seconds: number;
  end_seconds: number;
  text: string;
}

export interface SubWindow {
  /** Source time that becomes t=0 in the exported file (plan.paddedIn). */
  start: number;
  /** Source time the exported file ends at (plan.paddedOut). */
  end: number;
}

export interface SubStyle {
  fontSize: number;
  outline: number;
  marginV: number;
  marginLR: number;
  maxCharsPerLine: number;
}

/**
 * Landscape: the side project's values verbatim (~40 chars fit across the
 * 16:9 frame at this size, which is broadcast-standard line length).
 *
 * Portrait (9:16): social-video practice -- shorter lines (~24 chars) so the
 * text can stay large on a phone, and lifted to ~25% from the bottom so it
 * clears the caption/username/button overlays TikTok, Reels and Shorts all
 * draw over the lower fifth of the frame.
 */
const LANDSCAPE: SubStyle = { fontSize: 28, outline: 2, marginV: 30, marginLR: 10, maxCharsPerLine: 40 };
const PORTRAIT: SubStyle = { fontSize: 14, outline: 1, marginV: 72, marginLR: 6, maxCharsPerLine: 24 };

/** Script canvas height every style value above is measured against. */
export const PLAY_RES_Y = 288;

/**
 * Style for an output frame. Shared by the burned-in export (buildAss) and
 * the player's live preview, so the two can't drift apart. 0x0 = unknown,
 * treated as 16:9.
 */
export function subStyleFor(outWidth: number, outHeight: number): SubStyle {
  return outHeight > outWidth && outWidth > 0 ? PORTRAIT : LANDSCAPE;
}
/**
 * Horizontal padding inside the box, each side of every line. libass sizes
 * the BorderStyle=4 box to the glyphs and drops ordinary leading/trailing
 * spaces, so without this the box touches the first and last letters.
 *
 * The side project used two non-breaking spaces, but Recoleta has no U+00A0
 * glyph: on a machine with fallback fonts it borrows one, on the droplet
 * (none) it drew a missing-glyph box. A real Recoleta letter made fully
 * transparent (fill \1a and outline \3a; the box colour \4a is untouched)
 * pads by the same amount and needs no fallback.
 */
const PAD = "{\\1a&HFF&\\3a&HFF&}n{\\1a&H00&\\3a&H00&}";

function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

/**
 * ASS treats `{...}` as override tags and `\` as an escape, so transcript text
 * containing either would be interpreted instead of shown. Swapped for
 * stand-ins rather than escaped -- libass has no reliable escape for braces.
 * Every stand-in must be a glyph Recoleta actually has: the droplet has no
 * fallback fonts, so anything else draws as a missing-glyph box (U+2216, a
 * backslash look-alike, did exactly that).
 */
function assText(s: string): string {
  return s.replace(/\\/g, "/").replace(/\{/g, "(").replace(/\}/g, ")");
}

/** Greedy word wrap. A single word longer than the limit gets its own line. */
export function wrapWords(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (!line) line = w;
    else if (line.length + 1 + w.length <= maxChars) line += ` ${w}`;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export interface Cue {
  start: number;
  end: number;
  lines: string[];
}

const LINES_PER_CUE = 2;
/** A silence this long between words ends the cue (new thought or speaker). */
const PAUSE_BREAK_SECONDS = 0.75;
/** No cue stays up longer than this, however the words run on. */
const MAX_CUE_SECONDS = 7;
/** Cues shorter than this are held longer (into silence, never over the next cue). */
const MIN_CUE_SECONDS = 1;

/** Fewest words a line-overflow break leaves for the next cue (no orphans). */
const MIN_RUN_WORDS = 3;

/** YouTube's speaker-change marker. */
const SPEAKER_MARK = ">>";

/**
 * Words that end in a period without ending a sentence -- "Donald J. Trump",
 * "Sen. Moody", "D.C." -- so they don't split a cue mid-sentence.
 */
const NOT_SENTENCE_END = /^(?:[A-Z]\.|(?:Mr|Mrs|Ms|Dr|Sen|Rep|Gov|Lt|Gen|Col|Sgt|St|Jr|Sr|vs|etc)\.|(?:[A-Za-z]\.){2,})$/;

function endsSentence(word: string): boolean {
  return /[.?!]["'”’)\]]*$/.test(word) && !NOT_SENTENCE_END.test(word);
}

interface TimedWord {
  text: string;
  start: number;
  end: number;
  /** First word after a ">>" marker; the marker is kept on screen with it. */
  speakerChange: boolean;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  // A space, not U+00A0: Recoleta has no NBSP glyph (see PAD).
  nbsp: " ",
};

/**
 * HTML character references -> plain text. Transcripts imported from YouTube
 * caption files store `>>` as `&gt;&gt;` (thousands of segments), which would
 * otherwise be burned in literally and never read as a speaker change.
 * Display-only, on a copy -- the stored transcript is not changed.
 */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (code === 0xa0) return " ";
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? m;
  });
}

/**
 * Segment text -> words with estimated times. Segments carry no word-level
 * timing, so each word gets the share of its segment's span that its
 * characters take up. Done on a copy, for display only.
 */
function timedWords(seg: SubSegment): TimedWord[] {
  const tokens = decodeEntities(seg.text).trim().split(/\s+/).filter(Boolean);
  const total = tokens.reduce((n, t) => n + t.length + 1, 0) || 1;
  const span = Math.max(0, seg.end_seconds - seg.start_seconds);
  const out: TimedWord[] = [];
  let pos = 0;
  let pendingSpeaker = false;
  for (const tok of tokens) {
    const start = seg.start_seconds + (span * pos) / total;
    pos += tok.length + 1;
    const end = seg.start_seconds + (span * pos) / total;
    if (tok === SPEAKER_MARK) {
      pendingSpeaker = true;
      continue;
    }
    // ">>Errol" with no space after the marker.
    const glued = tok.startsWith(SPEAKER_MARK);
    out.push({
      text: glued ? tok.slice(SPEAKER_MARK.length) : tok,
      start,
      end,
      speakerChange: pendingSpeaker || glued,
    });
    pendingSpeaker = false;
  }
  return out;
}

/**
 * Segments -> on-screen cues, in window-relative seconds.
 *
 * Transcript segments are cut by audio duration, not grammar (Whisper's
 * especially), so one can hold the end of a question and the start of its
 * answer. Cues are therefore rebuilt from the word stream, the way broadcast
 * captioning does it, ignoring where segments happen to break. A new cue
 * starts:
 *   - after a sentence ends (. ? !),
 *   - at a ">>" speaker change -- the marker stays visible at the start of
 *     the cue, since all text is one colour and it's the only cue to the
 *     viewer that someone else is talking,
 *   - after a pause of PAUSE_BREAK_SECONDS or more,
 *   - when the next word wouldn't fit in two lines, or the cue would run past
 *     MAX_CUE_SECONDS.
 *
 * Only words spoken inside the window are used, so a sentence that began
 * before IN shows just its words after IN. Short cues are held up to
 * MIN_CUE_SECONDS where there's silence to do it in. Finally a backward pass
 * trims each kept cue to the start of the next KEPT cue, so no two are ever
 * on screen at once (they'd render stacked).
 */
export function buildCues(segments: SubSegment[], window: SubWindow, maxCharsPerLine: number): Cue[] {
  const span = window.end - window.start;
  const words = segments
    .filter((s) => (s.text ?? "").trim() && s.end_seconds > window.start && s.start_seconds < window.end)
    .sort((a, b) => a.start_seconds - b.start_seconds)
    .flatMap(timedWords)
    .filter((w) => w.end > window.start && w.start < window.end);

  const display = (w: TimedWord) => (w.speakerChange ? `${SPEAKER_MARK} ${w.text}` : w.text);
  // A break that grammar or timing forces, regardless of line space.
  const hardBreak = (prev: TimedWord, w: TimedWord) =>
    w.speakerChange || endsSentence(prev.text) || w.start - prev.end >= PAUSE_BREAK_SECONDS;

  const groups: TimedWord[][] = [];
  let cur: TimedWord[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = cur[cur.length - 1];
    if (prev !== undefined) {
      if (hardBreak(prev, w) || w.end - cur[0].start > MAX_CUE_SECONDS) {
        groups.push(cur);
        cur = [];
      } else if (wrapWords([...cur, w].map(display).join(" "), maxCharsPerLine).length > LINES_PER_CUE) {
        // Out of room mid-sentence. If only a word or two of the sentence
        // is left, breaking here would flash them alone ("YouTube.") -- move
        // the break earlier so the next cue starts with at least
        // MIN_RUN_WORDS words.
        let left = 1;
        while (left < MIN_RUN_WORDS && i + left < words.length && !hardBreak(words[i + left - 1], words[i + left])) left++;
        const carry = left < MIN_RUN_WORDS && cur.length > MIN_RUN_WORDS ? MIN_RUN_WORDS - left : 0;
        groups.push(cur.slice(0, cur.length - carry));
        cur = cur.slice(cur.length - carry);
      }
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);

  const raw: Cue[] = groups.map((g) => ({
    start: Math.max(0, g[0].start - window.start),
    end: Math.min(span, g[g.length - 1].end - window.start),
    lines: wrapWords(g.map(display).join(" "), maxCharsPerLine),
  }));
  for (let i = 0; i < raw.length; i++) {
    const room = i + 1 < raw.length ? raw[i + 1].start : span;
    raw[i].end = Math.max(raw[i].end, Math.min(raw[i].start + MIN_CUE_SECONDS, room));
  }

  const kept: Cue[] = [];
  let nextStart = Infinity;
  for (const c of raw.sort((a, b) => a.start - b.start).reverse()) {
    const end = Math.min(c.end, nextStart);
    if (end - c.start > 0.05) {
      kept.push({ ...c, end });
      nextStart = c.start;
    }
  }
  return kept.reverse();
}

/**
 * The complete .ass file for one export. outWidth/outHeight are the exported
 * frame's dimensions (after crop/scale); 0 means unknown, treated as 16:9.
 */
export function buildAss(
  segments: SubSegment[],
  window: SubWindow,
  outWidth: number,
  outHeight: number,
): string {
  const w = outWidth > 0 && outHeight > 0 ? outWidth : 1920;
  const h = outWidth > 0 && outHeight > 0 ? outHeight : 1080;
  const style = subStyleFor(w, h);
  const playResX = Math.round((PLAY_RES_Y * w) / h);

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${playResX}`,
    `PlayResY: ${PLAY_RES_Y}`,
    // Lines are broken here, by wrapWords -- never let libass re-wrap them
    // (margin-driven re-wrapping was the side project's 3-4 line jump bug).
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // Colours are &HAABBGGRR: text #E7EB94, outline black, box #111111 opaque.
    `Style: Default,Recoleta Bold,${style.fontSize},&H0094EBE7,&H0094EBE7,&H00000000,&H00111111,0,0,0,0,100,100,0,0,4,${style.outline},0,2,${style.marginLR},${style.marginLR},${style.marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const events = buildCues(segments, window, style.maxCharsPerLine).map(
    (c) =>
      `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,` +
      c.lines.map((l) => `${PAD}${assText(l)}${PAD}`).join("\\N"),
  );

  return [...header, ...events, ""].join("\n");
}

/**
 * Exported frame size for each aspect mode, mirroring buildVideoChain:
 * vertical modes render at verticalWidth x verticalHeight, native keeps the
 * source's (even-rounded) dimensions.
 */
export function outputSize(
  aspect: string,
  sourceW: number,
  sourceH: number,
  verticalW: number,
  verticalH: number,
): { width: number; height: number } {
  if (aspect === "vertical_crop" || aspect === "vertical_blur") return { width: verticalW, height: verticalH };
  return { width: sourceW, height: sourceH };
}

/**
 * Filter fragment appended to the video chain. Both names are RELATIVE: the
 * agent writes subs.ass and copies the font into ./fonts inside its own
 * export temp dir and runs ffmpeg from there, which keeps Windows drive
 * colons (C:\...) out of the filter string, where ffmpeg would read them as
 * option separators.
 */
export const SUBTITLES_FILTER = "subtitles=subs.ass:fontsdir=fonts";
