/**
 * clip-plan.ts — port of ffmpeg_ops.plan_clip (app/ffmpeg_ops.py:168).
 *
 * The magic: pad IN by -padIn, pad OUT by +padOut, then lay a fade over each
 * pad so the handles top-and-tail themselves.
 *
 * Fades are shortened (never stretched past the media) when the source does
 * not have a full 2s of head/tail room, so a clip starting at 00:00:00 still
 * exports rather than failing or producing a black opening.
 */

import type { ExportSettings } from "./export-settings";
import { DEFAULT_EXPORT_SETTINGS } from "./export-settings";

export interface ClipPlan {
  /** The operator's IN/OUT, before padding. */
  inPoint: number;
  outPoint: number;
  /** IN - padIn, floored at 0. */
  paddedIn: number;
  /** OUT + padOut, capped at source duration. */
  paddedOut: number;
  duration: number;
  fadeIn: number;
  fadeOut: number;
  fadeOutStart: number;
  /** True when there wasn't a full padIn of head room. */
  headClipped: boolean;
  tailClipped: boolean;
}

/**
 * Python's round(x, 3). JS has no built-in, and the naive x.toFixed(3) returns
 * a string. Half-up rather than Python's banker's rounding: the inputs here are
 * settings-derived (2.0) or differences of probe timestamps, so a tie at the
 * 4th decimal is vanishingly unlikely, and half-up is the behaviour a reader
 * expects. Called out because it IS a deliberate divergence from the source.
 */
const round3 = (x: number) => Math.round(x * 1000) / 1000;

export function planClip(
  inPoint: number,
  outPoint: number,
  sourceDuration = 0,
  settings: ExportSettings = DEFAULT_EXPORT_SETTINGS,
): ClipPlan {
  const start = Math.max(0, inPoint);
  let end = Math.max(0, outPoint);
  // Defensive, matching the source: the caller should have validated first.
  if (end <= start) end = start + 0.1;

  const paddedIn = Math.max(0, start - settings.padIn);
  let paddedOut = end + settings.padOut;
  if (sourceDuration > 0) paddedOut = Math.min(paddedOut, sourceDuration);
  const duration = Math.max(0.1, paddedOut - paddedIn);

  const headRoom = start - paddedIn;
  const tailRoom = paddedOut - end;

  /*
   * The `or` in the Python original is load-bearing and easy to mistranslate:
   *
   *     fade_in = min(s.fade_in, max(0.0, head_room)) or min(s.fade_in, duration / 4)
   *
   * 0.0 is falsy in Python, so when there is NO head room at all the fade does
   * not become zero — it falls back to a quarter of the clip. A clip cut at
   * 00:00:00 still gets a real fade in, just a shorter one. A literal
   * Math.min(...) translation would silently produce a hard cut instead.
   */
  const headFade = Math.min(settings.fadeIn, Math.max(0, headRoom));
  let fadeIn = headFade !== 0 ? headFade : Math.min(settings.fadeIn, duration / 4);

  const tailFade = Math.min(settings.fadeOut, Math.max(0, tailRoom));
  let fadeOut = tailFade !== 0 ? tailFade : Math.min(settings.fadeOut, duration / 4);

  fadeIn = Math.min(fadeIn, duration / 2);
  fadeOut = Math.min(fadeOut, duration / 2);

  return {
    inPoint: start,
    outPoint: end,
    paddedIn,
    paddedOut,
    duration,
    fadeIn: round3(fadeIn),
    fadeOut: round3(fadeOut),
    fadeOutStart: round3(Math.max(0, duration - fadeOut)),
    headClipped: headRoom < settings.padIn - 0.001,
    tailClipped: sourceDuration > 0 && tailRoom < settings.padOut - 0.001,
  };
}
