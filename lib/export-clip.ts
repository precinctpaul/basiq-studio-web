import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

import type { ClipPlan } from "./clip-plan";
import type { AspectMode } from "./crop";
import type { ExportSettings } from "./export-settings";
import { buildAudioChain, buildVideoChain } from "./ffmpeg-filters";

const execFileAsync = promisify(execFile);

export interface SourceStreams {
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface RenderResult {
  filePath: string;
  sizeBytes: number;
  cleanup: () => Promise<void>;
}

/**
 * Port of ffmpeg_ops.build_export_command + run_with_progress
 * (app/ffmpeg_ops.py:301, :412), pointed at a signed source URL instead of a
 * local path.
 *
 * FFmpeg's own http protocol turns `-ss <padded_in> -i <url>` into a Range
 * request rather than a linear read from byte 0 — so this only ever pulls the
 * padded IN..OUT window over the wire, never the full source. That is what
 * makes exporting a 30-second clip from an 11-hour recording tractable inside
 * a Vercel function at all: cost and time scale with clip length, not source
 * length.
 *
 * Renders to a temp file rather than piping stdout: libx264 with +faststart
 * seeks BACKWARD after encoding to move the moov atom to the front of the
 * file, which an unseekable pipe can't support.
 */
export async function renderClip(
  sourceUrl: string,
  plan: ClipPlan,
  aspect: AspectMode,
  source: SourceStreams,
  settings: ExportSettings,
  cropOffsetX = 0,
  cropOffsetY = 0,
  blurOk = true,
): Promise<RenderResult> {
  if (!ffmpegPath) {
    throw new Error("ffmpeg binary not found (ffmpeg-static returned null for this platform)");
  }
  if (!source.hasVideo && !source.hasAudio) {
    throw new Error("source has neither video nor audio streams");
  }

  const dir = await mkdtemp(path.join(tmpdir(), "basiq-clip-"));
  const outPath = path.join(dir, "clip.mp4");
  const cleanup = () => rm(dir, { recursive: true, force: true });

  const args: string[] = [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-loglevel",
    "error",
    "-ss",
    plan.paddedIn.toFixed(3),
    "-t",
    plan.duration.toFixed(3),
    "-i",
    sourceUrl,
  ];

  const graphs: string[] = [];
  const maps: string[] = [];

  if (source.hasVideo) {
    let vchain = buildVideoChain(aspect, settings, blurOk, cropOffsetX, cropOffsetY);
    if (settings.videoFade && plan.fadeIn > 0) {
      vchain += `,fade=t=in:st=0:d=${plan.fadeIn}`;
    }
    if (settings.videoFade && plan.fadeOut > 0) {
      vchain += `,fade=t=out:st=${plan.fadeOutStart}:d=${plan.fadeOut}`;
    }
    graphs.push(`[0:v]${vchain}[vout]`);
    maps.push("-map", "[vout]");
  }

  if (source.hasAudio) {
    const achain = buildAudioChain(plan);
    graphs.push(achain ? `[0:a]${achain}[aout]` : "[0:a]anull[aout]");
    maps.push("-map", "[aout]");
  }

  if (graphs.length) args.push("-filter_complex", graphs.join(";"));
  args.push(...maps);

  if (source.hasVideo) {
    args.push(
      "-c:v", "libx264",
      "-preset", settings.exportPreset,
      "-crf", String(settings.exportCrf),
      "-pix_fmt", "yuv420p",
      "-profile:v", "high",
      "-level", "4.1",
      "-movflags", "+faststart",
    );
  }
  if (source.hasAudio) {
    args.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2");
  }
  args.push("-map_metadata", "-1", "-sn", "-dn", outPath);

  try {
    await execFileAsync(ffmpegPath, args, {
      // Comfortably under the calling route's own maxDuration, so a hang here
      // surfaces as "ffmpeg export failed" rather than a bare platform
      // timeout with no explanation.
      timeout: 280_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    await cleanup();
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`ffmpeg export failed: ${message}`);
  }

  const stats = await stat(outPath);
  return { filePath: outPath, sizeBytes: stats.size, cleanup };
}
