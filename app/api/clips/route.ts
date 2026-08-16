import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { supabaseAdmin } from "@/lib/supabase-admin";
import { planClip } from "@/lib/clip-plan";
import { buildClipArgs } from "@/lib/export-clip";
import {
  DEFAULT_EXPORT_SETTINGS,
  FUNCTION_MAX_DURATION_SECONDS,
  MAX_CLIP_SECONDS,
} from "@/lib/export-settings";

export const runtime = "nodejs";
// MUST be a literal. Next statically analyses segment configs at build time
// and cannot resolve an imported constant — using
// FUNCTION_MAX_DURATION_SECONDS here fails the production build outright with
// "Invalid segment configuration export detected". Keep the two in step; the
// assertion below fails the build if they ever drift.
export const maxDuration = 300;

// Compile-time guard that the literal above still matches the shared setting.
const _maxDurationMatches: typeof FUNCTION_MAX_DURATION_SECONDS extends 300 ? true : never = true;
void _maxDurationMatches;

const Body = z.object({
  videoId: z.string().uuid(),
  inPoint: z.number().min(0),
  outPoint: z.number().min(0),
  aspectMode: z.enum(["native", "vertical_crop", "vertical_blur"]),
  cropOffsetX: z.number().min(-1).max(1).default(0),
  cropOffsetY: z.number().min(-1).max(1).default(0),
  title: z.string().trim().max(300).optional(),
});

/**
 * Synchronous export: the request doesn't return until the clip is rendered,
 * uploaded, and share-linked. Justified by scale (10-50 users, 5 concurrent
 * downloads per the brief) and by MAX_CLIP_SECONDS keeping any one render
 * short — a queue/worker split would be solving a load problem this app
 * doesn't have.
 */
export async function POST(req: NextRequest) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { videoId, inPoint, outPoint, aspectMode, cropOffsetX, cropOffsetY, title } = parsed.data;

  if (outPoint <= inPoint) {
    return NextResponse.json({ error: "outPoint must be after inPoint" }, { status: 400 });
  }
  if (outPoint - inPoint > MAX_CLIP_SECONDS) {
    return NextResponse.json(
      { error: `clip too long — ${MAX_CLIP_SECONDS}s max per export` },
      { status: 400 },
    );
  }

  const db = supabaseAdmin();
  const { data: video, error: videoError } = await db
    .from("videos")
    .select("*")
    .eq("id", videoId)
    .single();
  if (videoError || !video) {
    return NextResponse.json({ error: "video not found" }, { status: 404 });
  }
  // 'recording' is allowed deliberately: local_path already points at a
  // real, growing file on the shared drive, and clipping from it while it's
  // still live is the whole reason a capture is written straight to the
  // drive instead of assembled somewhere else first. The requested in/out
  // range only ever comes from transcript text that has ALREADY been
  // transcribed, so it can never reach past what FFmpeg can actually read.
  if (!video.local_path || (video.status !== "ready" && video.status !== "recording")) {
    return NextResponse.json(
      { error: `video is not ready yet (status: ${video.status})` },
      { status: 400 },
    );
  }

  const plan = planClip(inPoint, outPoint, video.duration_seconds, DEFAULT_EXPORT_SETTINGS);

  const { data: clip, error: insertError } = await db
    .from("clips")
    .insert({
      video_id: videoId,
      title: title ?? video.title,
      in_point: plan.inPoint,
      out_point: plan.outPoint,
      padded_in: plan.paddedIn,
      padded_out: plan.paddedOut,
      duration_seconds: plan.duration,
      fade_in: plan.fadeIn,
      fade_out: plan.fadeOut,
      video_fade: DEFAULT_EXPORT_SETTINGS.videoFade,
      aspect_mode: aspectMode,
      crop_offset_x: cropOffsetX,
      crop_offset_y: cropOffsetY,
      export_crf: DEFAULT_EXPORT_SETTINGS.exportCrf,
      export_preset: DEFAULT_EXPORT_SETTINGS.exportPreset,
      vertical_width: DEFAULT_EXPORT_SETTINGS.verticalWidth,
      blur_sigma: DEFAULT_EXPORT_SETTINGS.blurSigma,
      status: "rendering",
    })
    .select()
    .single();
  if (insertError || !clip) {
    return NextResponse.json(
      { error: insertError?.message ?? "could not create clip row" },
      { status: 500 },
    );
  }

  // A master on the shared drive has no bucket object, and a serverless
  // function has no route to a teammate's mounted volume. So the ARGUMENTS
  // are built here — once, from the same parity-tested graph builder — and
  // the local agent executes them and files the finished clip onto the
  // drive itself (see /api/clips/[id]/complete).
  const args = buildClipArgs(
    "%INPUT%",
    "%OUTPUT%",
    plan,
    aspectMode,
    { hasVideo: video.has_video, hasAudio: video.has_audio },
    DEFAULT_EXPORT_SETTINGS,
    cropOffsetX,
    cropOffsetY,
    video.width > 0 && video.height > 0,
  );

  return NextResponse.json({
    mode: "local",
    clipId: clip.id,
    localPath: video.local_path,
    title: clip.title,
    args,
    durationSeconds: plan.duration,
  });
}
