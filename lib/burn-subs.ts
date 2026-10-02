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
 *    Our segments are already de-rolled and can be whole sentences, so text is
 *    re-wrapped by length instead: at most 2 lines on screen per cue.
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

interface SubStyle {
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

const PLAY_RES_Y = 288;
const LINES_PER_CUE = 2;
/** Shortest time a cue stays up; anything less is unreadable flicker. */
const MIN_CUE_SECONDS = 0.6;
/**
 * Non-breaking spaces each side of every line. libass sizes the BorderStyle=4
 * box to the glyphs and ignores ordinary leading/trailing spaces, so without
 * these the box touches the first and last letters (side-project finding).
 */
const PAD = "\u00A0\u00A0";

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
 * look-alikes rather than escaped -- libass has no reliable escape for braces.
 */
function assText(s: string): string {
  return s.replace(/\\/g, "\u2216").replace(/\{/g, "(").replace(/\}/g, ")");
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

/**
 * Segments -> on-screen cues, in clip-relative seconds.
 *
 * A segment longer than two lines is split into consecutive cues, its time
 * shared out in proportion to each cue's character count (segments carry no
 * word-level timing). Cues are then trimmed so none outlasts the next one's
 * start -- two cues overlapping in time would render stacked on screen.
 */
export function buildCues(segments: SubSegment[], window: SubWindow, maxCharsPerLine: number): Cue[] {
  const span = window.end - window.start;
  const sorted = segments
    .filter((s) => (s.text ?? "").trim() && s.end_seconds > window.start && s.start_seconds < window.end)
    .map((s) => ({
      start: Math.max(0, s.start_seconds - window.start),
      end: Math.min(span, s.end_seconds - window.start),
      text: s.text.trim(),
    }))
    .sort((a, b) => a.start - b.start);

  const cues: Cue[] = [];
  for (const seg of sorted) {
    const lines = wrapWords(seg.text, maxCharsPerLine);
    const groups: string[][] = [];
    for (let i = 0; i < lines.length; i += LINES_PER_CUE) groups.push(lines.slice(i, i + LINES_PER_CUE));
    const total = groups.reduce((n, g) => n + g.join(" ").length, 0) || 1;
    const dur = Math.max(seg.end - seg.start, MIN_CUE_SECONDS);
    let t = seg.start;
    for (const g of groups) {
      const d = (dur * g.join(" ").length) / total;
      cues.push({ start: t, end: t + d, lines: g });
      t += d;
    }
  }

  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1];
    if (next && cues[i].end > next.start) cues[i].end = next.start;
    cues[i].end = Math.min(cues[i].end, span);
  }
  return cues.filter((c) => c.end - c.start > 0.05);
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
  const style = h > w ? PORTRAIT : LANDSCAPE;
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
