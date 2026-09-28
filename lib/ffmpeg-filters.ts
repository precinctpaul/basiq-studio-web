/**
 * ffmpeg-filters.ts — port of ffmpeg_ops.build_video_chain / build_audio_chain
 * (app/ffmpeg_ops.py:245 and :291).
 *
 * These strings are compared byte-for-byte against the desktop app's own
 * output by tests/filter-parity.test.mjs, which shells out to the real Python
 * module rather than to a copy of the expected strings. That is the only way
 * this stays honest: a hand-written expectation would just encode whatever the
 * port happened to produce on the day it was written.
 */

import type { AspectMode } from "./crop";
import type { ClipPlan } from "./clip-plan";
import type { ExportSettings } from "./export-settings";
import { DEFAULT_EXPORT_SETTINGS, verticalHeight } from "./export-settings";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Python's f"{x:.4f}". Normalises -0 to 0 first: JS renders (-0).toFixed(4) as
 * "0.0000" while Python renders it "-0.0000", and an offset of negative zero is
 * meaningless anyway. `|| 0` also folds NaN to centred, which beats emitting
 * "NaN" into a filter graph.
 */
const f4 = (x: number) => (x || 0).toFixed(4);

/**
 * Python's f"{x:g}" for the value range this file sees (fade seconds, already
 * rounded to 3dp by planClip). %g drops trailing zeros — 2.0 renders "2" — and
 * so does JS number-to-string. They diverge only at 7+ significant digits or
 * exponent ranges that fades never reach.
 */
const g = (x: number) => String(x);

/**
 * Video filter chain for one aspect mode, without pad labels.
 *
 * blurOk mirrors the desktop app's has_filter("gblur") probe: distro FFmpeg
 * builds vary, and boxblur is the fallback when gblur isn't compiled in.
 */
export function buildVideoChain(
  aspect: AspectMode,
  settings: ExportSettings = DEFAULT_EXPORT_SETTINGS,
  blurOk = true,
  offsetX = 0,
  offsetY = 0,
): string {
  const w = settings.verticalWidth;
  const h = verticalHeight(w);

  if (aspect === "vertical_crop") {
    /*
     * Centre-crop to 9:16 using whichever dimension binds, then normalise.
     *
     * w/h stay SYMBOLIC (FFmpeg's own iw/ih at decode time) rather than baking
     * in our probed width/height — more robust against any probe/decode
     * mismatch from rotation metadata or an odd SAR. The offset is a plain
     * dimensionless fraction, not a pixel size, so it bakes in as the same
     * literal constant cropGeometry() computes: the preview overlay and the
     * real export stay in lockstep by construction, not by coincidence.
     *
     * The backslash before the comma inside min() is FFmpeg's own escaping —
     * an unescaped comma would end the filter argument.
     */
    const ox = clamp(offsetX, -1, 1);
    const oy = clamp(offsetY, -1, 1);
    return (
      `crop=w='min(iw\\,ih*9/16)':h='min(ih\\,iw*16/9)':` +
      `x='(iw-ow)/2*(1+(${f4(ox)}))':y='(ih-oh)/2*(1+(${f4(oy)}))',` +
      `scale=${w}:${h}:flags=lanczos,setsar=1`
    );
  }

  if (aspect === "vertical_blur") {
    const blur = blurOk
      ? `gblur=sigma=${settings.blurSigma}`
      : `boxblur=${Math.max(2, Math.floor(settings.blurSigma / 2))}:1`;
    /*
     * split -> [bg] fill+blur, [fg] contain -> overlay centred.
     * The (W-w)/2 in the overlay is FFmpeg's own variable syntax (main vs
     * overlay dimensions), NOT our w/h — do not interpolate into it.
     */
    return (
      `split=2[_bg][_fg];` +
      `[_bg]scale=${w}:${h}:force_original_aspect_ratio=increase,` +
      `crop=${w}:${h},${blur},eq=brightness=-0.06[_bgo];` +
      `[_fg]scale=${w}:${h}:force_original_aspect_ratio=decrease,setsar=1[_fgo];` +
      `[_bgo][_fgo]overlay=(W-w)/2:(H-h)/2:shortest=0,setsar=1`
    );
  }

  // Native: keep geometry, just guarantee even dimensions for libx264.
  return "scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1";
}

/**
 * Same three modes, but for one segment inside a Reel's fixed canvas
 * (REELS_DESIGN.md) rather than a standalone clip export -- parameterized
 * by the canvas's own width/height instead of settings.verticalWidth,
 * because a reel's segments can come from different source videos and
 * still all have to land on the exact same output size for ffmpeg's
 * concat demuxer to join them afterward.
 *
 * "native" means something different here than in buildVideoChain above:
 * there, it keeps the source's own resolution unchanged, which is fine
 * for a clip with no one else's shape to match. Inside a reel every
 * segment must already BE the canvas size, so "native" here means
 * letterbox/pillarbox contain-fit (plain black bars, no blur) -- the one
 * mode that has to actively produce bars instead of cropping or filling.
 */
export function buildReelSegmentVideoChain(
  aspect: AspectMode,
  canvasWidth: number,
  canvasHeight: number,
  blurOk = true,
  offsetX = 0,
  offsetY = 0,
): string {
  const w = canvasWidth;
  const h = canvasHeight;

  if (aspect === "vertical_crop") {
    const ox = clamp(offsetX, -1, 1);
    const oy = clamp(offsetY, -1, 1);
    return (
      `crop=w='min(iw\\,ih*${w}/${h})':h='min(ih\\,iw*${h}/${w})':` +
      `x='(iw-ow)/2*(1+(${f4(ox)}))':y='(ih-oh)/2*(1+(${f4(oy)}))',` +
      `scale=${w}:${h}:flags=lanczos,setsar=1`
    );
  }

  if (aspect === "vertical_blur") {
    const blur = blurOk
      ? `gblur=sigma=${DEFAULT_EXPORT_SETTINGS.blurSigma}`
      : `boxblur=${Math.max(2, Math.floor(DEFAULT_EXPORT_SETTINGS.blurSigma / 2))}:1`;
    return (
      `split=2[_bg][_fg];` +
      `[_bg]scale=${w}:${h}:force_original_aspect_ratio=increase,` +
      `crop=${w}:${h},${blur},eq=brightness=-0.06[_bgo];` +
      `[_fg]scale=${w}:${h}:force_original_aspect_ratio=decrease,setsar=1[_fgo];` +
      `[_bgo][_fgo]overlay=(W-w)/2:(H-h)/2:shortest=0,setsar=1`
    );
  }

  return (
    `scale=${w}:${h}:force_original_aspect_ratio=decrease,setsar=1,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`
  );
}

/** 2s afade in at the head, 2s afade out landing exactly on the tail. */
export function buildAudioChain(plan: ClipPlan): string {
  const parts: string[] = [];
  if (plan.fadeIn > 0) {
    parts.push(`afade=t=in:st=0:d=${g(plan.fadeIn)}:curve=tri`);
  }
  if (plan.fadeOut > 0) {
    parts.push(`afade=t=out:st=${g(plan.fadeOutStart)}:d=${g(plan.fadeOut)}:curve=tri`);
  }
  return parts.join(",");
}
