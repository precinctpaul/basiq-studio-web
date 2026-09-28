/**
 * export-reel.ts — builds the FFmpeg argv for ONE reel segment. Companion
 * to lib/export-clip.ts's buildClipArgs, deliberately NOT a shared/
 * refactored function even though the overall shape (hide_banner/-ss/-t/
 * -i/filter_complex/encode settings/output) is the same. buildClipArgs is
 * exercised by tests/filter-parity.test.mjs against the desktop app's own
 * byte-for-byte output; threading a reel-specific video chain through its
 * signature would risk that parity for a path this feature doesn't even
 * use. Duplicating the shell here is a few dozen lines; risking the
 * proven single-clip export path is not a trade worth making.
 *
 * See REELS_DESIGN.md's "Export job shape" for the surrounding pipeline:
 * this builds args for ONE segment's cut+normalize step, run by the local
 * agent once per segment, before a separate concat step joins them.
 */

import type { AspectMode } from "./crop";
import { DEFAULT_EXPORT_SETTINGS } from "./export-settings";
import { buildReelSegmentVideoChain } from "./ffmpeg-filters";

export interface ReelSourceStreams {
  hasVideo: boolean;
  hasAudio: boolean;
}

/**
 * Every reel segment renders at this fixed rate regardless of its own
 * source's native fps. buildClipArgs snaps each clip to the NEAREST
 * standard rate FROM ITS OWN SOURCE (lib/export-clip.ts's
 * nearestStandardFps) -- fine for a standalone clip, since there's nothing
 * else it has to match. A reel concatenates segments that can come from
 * DIFFERENT source videos with different native rates, and ffmpeg's
 * concat DEMUXER (the final join) requires every segment to already share
 * identical stream parameters -- resolution, fps, codec -- or the join
 * breaks. One fixed rate for every segment in every reel sidesteps that
 * entirely rather than trying to reconcile whatever rates the sources
 * happen to have.
 */
const REEL_FPS = 30;

/**
 * The complete FFmpeg argv for cutting and normalizing ONE reel segment to
 * the reel's fixed canvas. No padding/fades (REELS_DESIGN.md: hard cuts
 * only for v1) -- inPoint/outPoint are used exactly as given, never run
 * through clip-plan.ts's handle/fade math.
 *
 * A source with no audio track still gets a generated silent one (a
 * second lavfi input, mapped in place of the missing real track) rather
 * than no audio map at all -- every segment needs an identical stream
 * layout for the concat step to join them.
 */
export function buildReelSegmentArgs(
  sourceUrl: string,
  outPath: string,
  inPoint: number,
  outPoint: number,
  aspect: AspectMode,
  source: ReelSourceStreams,
  canvasWidth: number,
  canvasHeight: number,
  cropOffsetX = 0,
  cropOffsetY = 0,
  blurOk = true,
): string[] {
  if (!source.hasVideo) {
    throw new Error("reel segments require a source with a video track");
  }

  const duration = Math.max(0.1, outPoint - inPoint);

  const args: string[] = [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-loglevel",
    "error",
    "-ss",
    inPoint.toFixed(3),
    "-t",
    duration.toFixed(3),
    "-i",
    sourceUrl,
  ];

  if (!source.hasAudio) {
    args.push("-f", "lavfi", "-t", duration.toFixed(3), "-i", "anullsrc=r=48000:cl=stereo");
  }

  const vchain = buildReelSegmentVideoChain(aspect, canvasWidth, canvasHeight, blurOk, cropOffsetX, cropOffsetY);
  const graphs: string[] = [`[0:v]${vchain}[vout]`];
  const maps: string[] = ["-map", "[vout]"];
  if (source.hasAudio) {
    graphs.push("[0:a]anull[aout]");
    maps.push("-map", "[aout]");
  } else {
    // The lavfi silence generator's own raw output needs no filtering --
    // referenced directly as the second input's audio stream, not routed
    // through filter_complex like the real video/audio above.
    maps.push("-map", "1:a");
  }
  args.push("-filter_complex", graphs.join(";"), ...maps);

  const gop = REEL_FPS * 2; // ~2s GOP, same reasoning as buildClipArgs.
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    DEFAULT_EXPORT_SETTINGS.exportPreset,
    "-crf",
    String(DEFAULT_EXPORT_SETTINGS.exportCrf),
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "high",
    "-level",
    "4.1",
    "-r",
    String(REEL_FPS),
    "-vsync",
    "cfr",
    "-g",
    String(gop),
    "-keyint_min",
    String(gop),
    "-sc_threshold",
    "0",
    "-movflags",
    "+faststart",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-avoid_negative_ts",
    "make_zero",
    "-map_metadata",
    "-1",
    "-sn",
    "-dn",
    outPath,
  );
  return args;
}
