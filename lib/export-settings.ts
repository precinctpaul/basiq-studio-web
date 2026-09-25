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
  // Must match the desktop app's app/config.py Settings defaults (also
  // reflected in the clips table's own fade_in/fade_out column defaults,
  // supabase/migrations/0001_initial_schema.sql:211) -- this had drifted to
  // 1.0, which silently rendered every web export with half the brand-spec
  // pad/fade the desktop app and the DB schema both expect, and was what
  // tests/filter-parity.test.mjs was catching before this fix.
  padIn: 2.0,
  padOut: 2.0,
  fadeIn: 2.0,
  fadeOut: 2.0,
  videoFade: false,
  exportCrf: 18,
  exportPreset: "veryfast",
  verticalWidth: 1080,
  blurSigma: 40,
};

/**
 * Vestigial Vercel route-segment config -- basiq-web is a persistent `next
 * start` process under pm2 on the droplet, not a Vercel serverless function,
 * so this has had no real effect for a while (confirmed 2026-09-25;
 * self-hosted Next.js ignores `maxDuration` entirely per Next's own docs).
 * Left in place only because app/api/clips/route.ts's `maxDuration` export
 * still needs SOME literal number (Next statically analyses route segment
 * configs at build time and rejects an imported value), not because it
 * still bounds anything real.
 */
export const FUNCTION_MAX_DURATION_SECONDS = 300;

// MAX_CLIP_SECONDS (a 180s cap) removed 2026-09-25 -- it was sized around
// the Vercel timeout above, which no longer applies now that rendering runs
// as a normal background job on the droplet (tools/basiq_agent.py's
// run_export(), tracked via its own job status, not a blocking request).
// The real ceiling that still matters is that job's own
// _FFMPEG_EXPORT_TIMEOUT_SECONDS (1800s / 30 min) in basiq_agent.py, which
// this file has no relationship to and doesn't need to.

/** Vertical output height for a given width, forced even for libx264. */
export function verticalHeight(width: number): number {
  const h = Math.round((width * 16) / 9);
  return h % 2 ? h + 1 : h;
}
