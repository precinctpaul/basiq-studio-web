import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffprobeStatic from "ffprobe-static";

const execFileAsync = promisify(execFile);

export interface MediaInfo {
  duration: number;
  width: number;
  height: number;
  hasVideo: boolean;
  hasAudio: boolean;
  fps: number;
  vcodec: string;
  acodec: string;
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  codec_name?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
}

interface FfprobeOutput {
  format?: { duration?: string };
  streams?: FfprobeStream[];
}

const EMPTY: MediaInfo = {
  duration: 0,
  width: 0,
  height: 0,
  hasVideo: false,
  hasAudio: false,
  fps: 0,
  vcodec: "",
  acodec: "",
};

/**
 * Port of ffmpeg_ops.probe (app/ffmpeg_ops.py:84), pointed at a URL instead of
 * a local path.
 *
 * This is the load-bearing trick that makes an 11-hour source probeable
 * inside a Vercel function at all: ffprobe's own http protocol handler issues
 * Range requests to read only the container header (and the moov atom,
 * wherever it sits), never the whole file. Supabase Storage serves signed URLs
 * from S3-compatible storage, which honours Range — so this never pulls more
 * than a few hundred KB over the wire regardless of source length.
 *
 * Deliberately returns EMPTY-shaped output on failure rather than throwing,
 * mirroring the desktop function's own contract (a probe failure degrades to
 * "durations will be approximate", not a crash) — but here the caller
 * (finalize route) treats a fully-empty result as a real failure, since a
 * freshly uploaded file should always be probeable.
 */
export async function probeUrl(url: string): Promise<MediaInfo> {
  const args = ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", url];

  let stdout: string;
  try {
    const result = await execFileAsync(ffprobeStatic.path, args, {
      timeout: 45_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`ffprobe failed: ${message}`);
  }

  let data: FfprobeOutput;
  try {
    data = JSON.parse(stdout || "{}");
  } catch {
    throw new Error("ffprobe returned invalid JSON");
  }

  const info: MediaInfo = { ...EMPTY };

  const fmtDuration = Number.parseFloat(data.format?.duration ?? "");
  if (Number.isFinite(fmtDuration)) info.duration = fmtDuration;

  for (const st of data.streams ?? []) {
    if (st.codec_type === "video" && !info.hasVideo) {
      info.hasVideo = true;
      info.width = st.width ?? 0;
      info.height = st.height ?? 0;
      info.vcodec = st.codec_name ?? "";

      const rate = st.avg_frame_rate || st.r_frame_rate || "0/1";
      const [numStr, denStr] = rate.split("/");
      const num = Number.parseFloat(numStr);
      const den = Number.parseFloat(denStr || "1");
      info.fps = den ? Math.round((num / den) * 1000) / 1000 : 0;

      if (!info.duration) {
        const streamDuration = Number.parseFloat(st.duration ?? "");
        if (Number.isFinite(streamDuration)) info.duration = streamDuration;
      }
    } else if (st.codec_type === "audio" && !info.hasAudio) {
      info.hasAudio = true;
      info.acodec = st.codec_name ?? "";
    }
  }

  return info;
}
