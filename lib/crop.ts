/**
 * crop.ts — aspect modes and the 9:16 crop-window geometry.
 *
 * Ported from app/config.py (ASPECT_MODES) and app/ffmpeg_ops.py
 * (crop_geometry) in the desktop build.
 *
 * Deliberately dependency-free and Node-free so it can be imported by BOTH the
 * browser crop-guide overlay and the server-side export. That is the same
 * discipline crop_geometry() enforces in the desktop app: the live guide (Qt,
 * no FFmpeg involved) and the real export filter must never disagree about
 * where the window sits, so they share one implementation rather than two that
 * happen to match today.
 */

/** Stable slugs — what goes in the database. Never store the display string. */
export type AspectMode = "native" | "vertical_crop" | "vertical_blur";

export const ASPECT_MODES: readonly AspectMode[] = [
  "native",
  "vertical_crop",
  "vertical_blur",
] as const;

/** Long labels, matching the desktop app's ASPECT_MODES tuple verbatim. */
export const ASPECT_LABELS: Record<AspectMode, string> = {
  native: "Native (16:9)",
  vertical_crop: "9:16 (Center Crop)",
  vertical_blur: "9:16 (Blur BG)",
};

/** Short labels for the narrow export bar (ASPECT_SHORT_LABELS). */
export const ASPECT_SHORT_LABELS: Record<AspectMode, string> = {
  native: "16:9 Native",
  vertical_crop: "9:16 Crop",
  vertical_blur: "9:16 Blur",
};

/** Filename tag, as used by build_clip_path. */
export const ASPECT_FILE_TAGS: Record<AspectMode, string> = {
  native: "16x9",
  vertical_crop: "9x16crop",
  vertical_blur: "9x16blur",
};

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Pixel geometry of the 9:16 centre-crop window inside an iw x ih source —
 * the exact maths buildVideoChain's vertical_crop branch expresses in FFmpeg's
 * own expression syntax.
 *
 * offsetX / offsetY run -1..1, 0 being centred. Each only has an effect on
 * whichever axis actually has slack: a source already exactly 9:16 has none on
 * either axis, and a typical 16:9 source has all its slack on x (the crop keeps
 * full height and narrows the width) — which is why only a horizontal nudge
 * does anything in the common case.
 */
export function cropGeometry(
  iw: number,
  ih: number,
  offsetX = 0,
  offsetY = 0,
): CropRect {
  if (!(iw > 0) || !(ih > 0)) return { x: 0, y: 0, w: 0, h: 0 };

  const w = Math.min(iw, (ih * 9) / 16);
  const h = Math.min(ih, (iw * 16) / 9);
  const ox = clamp(offsetX, -1, 1);
  const oy = clamp(offsetY, -1, 1);

  return {
    x: ((iw - w) / 2) * (1 + ox),
    y: ((ih - h) / 2) * (1 + oy),
    w,
    h,
  };
}

/**
 * How much slack an axis actually has, in pixels. The crop-guide UI uses this
 * to decide whether a nudge control is live or inert — an axis with no slack
 * silently ignoring input reads as a broken control.
 */
export function cropSlack(iw: number, ih: number): { x: number; y: number } {
  const { w, h } = cropGeometry(iw, ih);
  return { x: Math.max(0, iw - w), y: Math.max(0, ih - h) };
}
