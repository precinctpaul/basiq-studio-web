import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { isMissingTable } from "@/lib/supabase-errors";

export const runtime = "nodejs";

function migrationNeeded() {
  return NextResponse.json(
    { error: "reel_segments table missing — run supabase/migrations/0016_reels.sql" },
    { status: 503 },
  );
}

const PostBody = z.object({
  videoId: z.string().uuid(),
  inPoint: z.number().min(0),
  outPoint: z.number().min(0),
  aspectMode: z.enum(["native", "vertical_crop", "vertical_blur"]).default("native"),
  cropOffsetX: z.number().min(-1).max(1).default(0),
  cropOffsetY: z.number().min(-1).max(1).default(0),
});

/** POST — append one segment ("ADD TO REEL"), same shape as marking IN/OUT
 *  and hitting EXPORT CLIP today, minus the render: this only records the
 *  pick. Appends at the end (max existing position + 1) — the drawer's
 *  drag-to-reorder is the reorder endpoint below, not this one. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: reelId } = await ctx.params;
  const parsed = PostBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { videoId, inPoint, outPoint, aspectMode, cropOffsetX, cropOffsetY } = parsed.data;
  if (outPoint <= inPoint) {
    return NextResponse.json({ error: "outPoint must be after inPoint" }, { status: 400 });
  }

  const db = supabaseAdmin();

  const { data: reel, error: reelError } = await db
    .from("reels")
    .select("id")
    .eq("id", reelId)
    .single();
  if (isMissingTable(reelError)) return migrationNeeded();
  if (reelError || !reel) {
    return NextResponse.json({ error: "reel not found" }, { status: 404 });
  }

  // Same readiness bar as a normal single-clip export (see
  // app/api/clips/route.ts) — 'recording' is allowed for the same reason:
  // clipping from a still-growing live capture is the whole point of
  // writing it straight to the shared drive.
  const { data: video, error: videoError } = await db
    .from("videos")
    .select("id, status, duration_seconds")
    .eq("id", videoId)
    .single();
  if (videoError || !video) {
    return NextResponse.json({ error: "video not found" }, { status: 404 });
  }
  if (video.status !== "ready" && video.status !== "recording") {
    return NextResponse.json(
      { error: `video is not ready yet (status: ${video.status})` },
      { status: 400 },
    );
  }
  if (video.duration_seconds > 0 && outPoint > video.duration_seconds) {
    return NextResponse.json({ error: "outPoint is past the end of the source video" }, { status: 400 });
  }

  const { data: last } = await db
    .from("reel_segments")
    .select("position")
    .eq("reel_id", reelId)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextPosition = (last?.position ?? -1) + 1;

  const { data: segment, error: insertError } = await db
    .from("reel_segments")
    .insert({
      reel_id: reelId,
      video_id: videoId,
      position: nextPosition,
      in_point: inPoint,
      out_point: outPoint,
      aspect_mode: aspectMode,
      crop_offset_x: cropOffsetX,
      crop_offset_y: cropOffsetY,
    })
    .select("*, videos(id, title, duration_seconds, width, height)")
    .single();
  if (insertError || !segment) {
    return NextResponse.json(
      { error: insertError?.message ?? "could not add segment" },
      { status: 500 },
    );
  }

  return NextResponse.json({ segment });
}

const ReorderBody = z.object({
  /** Every segment id currently in this reel, in the new desired order —
   *  the full set, not a delta, so a stale/partial client can't silently
   *  drop segments it didn't know about. */
  order: z.array(z.number().int()).min(1),
});

/** PATCH — reorder (drag-and-drop in the timeline drawer). Two passes to
 *  avoid tripping reel_segments' own `unique (reel_id, position)`
 *  constraint mid-shuffle: first move every affected row to a distinct
 *  NEGATIVE position (guaranteed not to collide with any existing positive
 *  one, or with each other), then set final positions from the given
 *  order. Plain sequential updates, no stored procedure or deferred
 *  constraint needed. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: reelId } = await ctx.params;
  const parsed = ReorderBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data: existing, error: existingError } = await db
    .from("reel_segments")
    .select("id")
    .eq("reel_id", reelId);
  if (isMissingTable(existingError)) return migrationNeeded();
  if (existingError) return NextResponse.json({ error: existingError.message }, { status: 500 });

  const existingIds = new Set((existing ?? []).map((s) => s.id));
  const givenIds = parsed.data.order;
  const sameSet =
    existingIds.size === givenIds.length && givenIds.every((sid) => existingIds.has(sid));
  if (!sameSet) {
    return NextResponse.json(
      { error: "order must contain exactly this reel's current segment ids" },
      { status: 400 },
    );
  }

  for (let i = 0; i < givenIds.length; i++) {
    const { error } = await db
      .from("reel_segments")
      .update({ position: -(i + 1) })
      .eq("id", givenIds[i]);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  for (let i = 0; i < givenIds.length; i++) {
    const { error } = await db
      .from("reel_segments")
      .update({ position: i })
      .eq("id", givenIds[i]);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data: segments, error: segError } = await db
    .from("reel_segments")
    .select("*, videos(id, title, duration_seconds, width, height)")
    .eq("reel_id", reelId)
    .order("position", { ascending: true });
  if (segError) return NextResponse.json({ error: segError.message }, { status: 500 });

  return NextResponse.json({ segments: segments ?? [] });
}
