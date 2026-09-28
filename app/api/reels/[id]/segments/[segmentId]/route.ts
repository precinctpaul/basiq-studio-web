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

const PatchBody = z
  .object({
    inPoint: z.number().min(0).optional(),
    outPoint: z.number().min(0).optional(),
    aspectMode: z.enum(["native", "vertical_crop", "vertical_blur"]).optional(),
    cropOffsetX: z.number().min(-1).max(1).optional(),
    cropOffsetY: z.number().min(-1).max(1).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, "no fields to update");

/** PATCH — trim a segment already on the timeline (adjust in/out) or change
 *  how it fits the reel's canvas, without removing and re-adding it (which
 *  would also lose its position). Position/reordering is a separate
 *  endpoint (see the reorder PATCH on the parent segments route) — this one
 *  never touches position, on purpose. */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; segmentId: string }> },
) {
  const { id: reelId, segmentId } = await ctx.params;
  const parsed = PatchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data: existing, error: existingError } = await db
    .from("reel_segments")
    .select("id, reel_id, in_point, out_point")
    .eq("id", segmentId)
    .eq("reel_id", reelId)
    .single();
  if (isMissingTable(existingError)) return migrationNeeded();
  if (existingError || !existing) {
    return NextResponse.json({ error: "segment not found in this reel" }, { status: 404 });
  }

  const nextIn = parsed.data.inPoint ?? existing.in_point;
  const nextOut = parsed.data.outPoint ?? existing.out_point;
  if (nextOut <= nextIn) {
    return NextResponse.json({ error: "outPoint must be after inPoint" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  if (parsed.data.inPoint !== undefined) update.in_point = parsed.data.inPoint;
  if (parsed.data.outPoint !== undefined) update.out_point = parsed.data.outPoint;
  if (parsed.data.aspectMode !== undefined) update.aspect_mode = parsed.data.aspectMode;
  if (parsed.data.cropOffsetX !== undefined) update.crop_offset_x = parsed.data.cropOffsetX;
  if (parsed.data.cropOffsetY !== undefined) update.crop_offset_y = parsed.data.cropOffsetY;

  const { data: segment, error: updateError } = await db
    .from("reel_segments")
    .update(update)
    .eq("id", segmentId)
    .select("*, videos(id, title, duration_seconds, width, height)")
    .single();
  if (updateError || !segment) {
    return NextResponse.json(
      { error: updateError?.message ?? "could not update segment" },
      { status: 500 },
    );
  }

  return NextResponse.json({ segment });
}

/** DELETE — remove one segment from the timeline. Positions are left as-is
 *  (gaps are fine; ordering is always `order by position`, and a new
 *  append always uses max(position)+1 regardless of gaps) — no repacking,
 *  nothing else to do. */
export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; segmentId: string }> },
) {
  const { id: reelId, segmentId } = await ctx.params;
  const db = supabaseAdmin();

  const { error, count } = await db
    .from("reel_segments")
    .delete({ count: "exact" })
    .eq("id", segmentId)
    .eq("reel_id", reelId);
  if (isMissingTable(error)) return migrationNeeded();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!count) return NextResponse.json({ error: "segment not found in this reel" }, { status: 404 });

  return NextResponse.json({ ok: true });
}
