/**
 * export-settings.ts — the subset of the desktop app's Settings dataclass
 * (app/config.py) that actually affects a rendered clip.
 *
 * These are defaults, not user preferences. Every value here is persisted onto
 * the clip row at render time, because a clip is immutable output while
 * settings are mutable: storing them per-clip is what lets a re-render a year
 * from now reproduce the same file after these defaults have moved on. That is
 * the promise a share link makes when it says "forever".
 */

export interface ExportSettings {
  /** Tops & Tails: seconds of handle added before IN and after OUT. */
  padIn: number;
  padOut: number;
  /** Fade laid over each pad. */
  fadeIn: number;
  fadeOut: number;
  /**
   * Audio-only fades by default — brand spec. The desktop app ships
   * video_fade=False and the vertical formats look wrong with a video dip.
   */
  videoFade: boolean;

  exportCrf: number;
  exportPreset: string;
  /** Vertical output width; height is derived as width * 16/9, rounded even. */
  verticalWidth: number;
  blurSigma: number;
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  padIn: 1.0,
  padOut: 1.0,
  fadeIn: 1.0,
  fadeOut: 1.0,
  videoFade: false,
  exportCrf: 18,
  exportPreset: "veryfast",
  verticalWidth: 1080,
  blurSigma: 40,
};

/**
 * THE ONE PLACE the function timeout is expressed.
 *
 * Vercel caps how long a single invocation may run, and that cap is the real
 * ceiling on clip length — not FFmpeg, not the source duration. Exporting is
 * bounded work only because we render the IN/OUT segment rather than the whole
 * video, so this number and MAX_CLIP_SECONDS move together.
 *
 * Dropping to a shorter-budget plan means editing these two values and nothing
 * else. Keep MAX_CLIP_SECONDS well under the wall-clock budget: at CRF 18 /
 * veryfast, 1080p renders somewhat faster than realtime, and the margin covers
 * the HTTP seek into the source plus the upload of the finished file.
 */
export const FUNCTION_MAX_DURATION_SECONDS = 300;
export const MAX_CLIP_SECONDS = 180;

/** Vertical output height for a given width, forced even for libx264. */
export function verticalHeight(width: number): number {
  const h = Math.round((width * 16) / 9);
  return h % 2 ? h + 1 : h;
}
