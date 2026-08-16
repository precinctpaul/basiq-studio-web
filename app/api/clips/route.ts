import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readFile } from "node:fs/promises";

import { supabaseAdmin } from "@/lib/supabase-admin";
import { planClip } from "@/lib/clip-plan";
import { renderClip } from "@/lib/export-clip";
import { ASPECT_FILE_TAGS } from "@/lib/crop";
import {
  DEFAULT_EXPORT_SETTINGS,
  FUNCTION_MAX_DURATION_SECONDS,
  MAX_CLIP_SECONDS,
} from "@/lib/export-settings";
import { generateShareToken } from "@/lib/share-token";

export const runtime = "nodejs";
export const maxDuration = FUNCTION_MAX_DURATION_SECONDS;

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
  if (video.status !== "ready" || !video.storage_path) {
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

  try {
    // Long enough that the render can't outlive it, short enough that it's
    // only ever used by this one request.
    const { data: signedSource, error: signError } = await db.storage
      .from("videos")
      .createSignedUrl(video.storage_path, FUNCTION_MAX_DURATION_SECONDS + 60);
    if (signError || !signedSource) {
      throw new Error(signError?.message ?? "could not sign source url");
    }

    const rendered = await renderClip(
      signedSource.signedUrl,
      plan,
      aspectMode,
      { hasVideo: video.has_video, hasAudio: video.has_audio },
      DEFAULT_EXPORT_SETTINGS,
      cropOffsetX,
      cropOffsetY,
    );

    try {
      const bytes = await readFile(rendered.filePath);
      const clipStoragePath = `${clip.id}/clip_${ASPECT_FILE_TAGS[aspectMode]}.mp4`;

      const { error: uploadError } = await db.storage
        .from("clips")
        .upload(clipStoragePath, bytes, { contentType: "video/mp4", upsert: true });
      if (uploadError) throw new Error(uploadError.message);

      const token = generateShareToken();
      const { error: tokenError } = await db
        .from("share_tokens")
        .insert({ token, clip_id: clip.id });
      if (tokenError) throw new Error(tokenError.message);

      const { error: updateError } = await db
        .from("clips")
        .update({
          storage_path: clipStoragePath,
          size_bytes: rendered.sizeBytes,
          status: "ready",
          progress: 100,
          completed_at: new Date().toISOString(),
        })
        .eq("id", clip.id);
      if (updateError) throw new Error(updateError.message);

      return NextResponse.json({
        clipId: clip.id,
        shareToken: token,
        shareUrl: `/share/${token}`,
        sizeBytes: rendered.sizeBytes,
        durationSeconds: plan.duration,
      });
    } finally {
      await rendered.cleanup();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.from("clips").update({ status: "failed", error: message }).eq("id", clip.id);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
