import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { isMissingTable } from "@/lib/supabase-errors";
import { buildReelSegmentArgs } from "@/lib/export-reel";
import type { AspectMode } from "@/lib/crop";

export const runtime = "nodejs";

function migrationNeeded() {
  return NextResponse.json(
    { error: "reels table missing — run supabase/migrations/0016_reels.sql" },
    { status: 503 },
  );
}

/**
 * POST — plans a reel export, mirroring the role /api/clips plays for a
 * single clip: builds the ffmpeg argv for each segment and returns them
 * for the browser to feed the local agent one at a time (see
 * REELS_DESIGN.md's export job shape). The actual ffmpeg processes run on
 * the agent, same reason a single clip's do — a master on the shared
 * drive has no bucket object, and this Next.js route has no route to a
 * teammate's mounted volume.
 *
 * This is also the one place a reel's status/progress ARE allowed to
 * change server-side (PATCH /api/reels/[id] deliberately excludes them —
 * see that route) — this route owns the "queued" transition, and
 * /api/reels/[id]/complete owns "ready"/"failed".
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: reelId } = await ctx.params;
  const db = supabaseAdmin();

  const { data: reel, error: reelError } = await db
    .from("reels")
    .select("*")
    .eq("id", reelId)
    .single();
  if (isMissingTable(reelError)) return migrationNeeded();
  if (reelError || !reel) {
    return NextResponse.json({ error: "reel not found" }, { status: 404 });
  }

  const { data: segments, error: segError } = await db
    .from("reel_segments")
    .select("*, videos(id, title, local_path, width, height, has_video, has_audio, fps, status, duration_seconds)")
    .eq("reel_id", reelId)
    .order("position", { ascending: true });
  if (segError) return NextResponse.json({ error: segError.message }, { status: 500 });
  if (!segments || segments.length === 0) {
    return NextResponse.json({ error: "reel has no clips yet" }, { status: 400 });
  }

  const plannedSegments: Array<{
    segmentId: number;
    position: number;
    localPath: string;
    args: string[];
    durationSeconds: number;
  }> = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const video = seg.videos as {
      title: string;
      local_path: string | null;
      width: number;
      height: number;
      has_video: boolean;
      has_audio: boolean;
      fps: number;
      status: string;
      duration_seconds: number;
    } | null;
    const label = `segment ${i + 1} ("${video?.title ?? "unknown video"}")`;

    if (!video) {
      return NextResponse.json({ error: `${label}: source video no longer exists` }, { status: 400 });
    }
    if (video.status !== "ready" && video.status !== "recording") {
      return NextResponse.json(
        { error: `${label}: source video is not ready yet (status: ${video.status})` },
        { status: 400 },
      );
    }
    if (!video.local_path) {
      return NextResponse.json({ error: `${label}: source video has no file on the shared drive` }, { status: 400 });
    }
    if (!video.has_video) {
      return NextResponse.json(
        { error: `${label}: source has no video track — reels require video on every segment` },
        { status: 400 },
      );
    }
    if (video.duration_seconds > 0 && seg.out_point > video.duration_seconds) {
      return NextResponse.json({ error: `${label}: out point is past the end of the source` }, { status: 400 });
    }

    const args = buildReelSegmentArgs(
      "%INPUT%",
      "%OUTPUT%",
      seg.in_point,
      seg.out_point,
      seg.aspect_mode as AspectMode,
      { hasVideo: video.has_video, hasAudio: video.has_audio },
      reel.canvas_width,
      reel.canvas_height,
      seg.crop_offset_x,
      seg.crop_offset_y,
    );

    plannedSegments.push({
      segmentId: seg.id,
      position: i,
      localPath: video.local_path,
      args,
      durationSeconds: seg.out_point - seg.in_point,
    });
  }

  const { error: updateError } = await db
    .from("reels")
    .update({ status: "queued", progress: 0, error: "" })
    .eq("id", reelId);
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  return NextResponse.json({
    reelId,
    title: reel.title,
    canvasWidth: reel.canvas_width,
    canvasHeight: reel.canvas_height,
    segments: plannedSegments,
  });
}
