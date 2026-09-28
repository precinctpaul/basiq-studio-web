import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { isMissingTable } from "@/lib/supabase-errors";

export const runtime = "nodejs";

function migrationNeeded() {
  return NextResponse.json(
    { error: "reels table missing — run supabase/migrations/0016_reels.sql" },
    { status: 503 },
  );
}

/** GET — one reel plus its ordered segments, each joined with just enough
 *  of its source video (title/duration/dimensions) for the timeline drawer
 *  to render a block without a second round trip per segment. Two queries
 *  rather than one nested select: PostgREST can order a top-level query by
 *  a related table's column, but not the other way around (ordering the
 *  NESTED collection itself needs the query-embedding order syntax, which
 *  reads far less obviously than just asking for reel_segments ordered by
 *  position directly). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = supabaseAdmin();

  const { data: reel, error: reelError } = await db
    .from("reels")
    .select("*")
    .eq("id", id)
    .single();
  if (isMissingTable(reelError)) return migrationNeeded();
  if (reelError || !reel) {
    return NextResponse.json({ error: reelError?.message ?? "reel not found" }, { status: 404 });
  }

  const { data: segments, error: segError } = await db
    .from("reel_segments")
    .select("*, videos(id, title, duration_seconds, width, height)")
    .eq("reel_id", id)
    .order("position", { ascending: true });
  if (segError) return NextResponse.json({ error: segError.message }, { status: 500 });

  return NextResponse.json({ reel, segments: segments ?? [] });
}

const PatchBody = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    canvasWidth: z.number().int().positive().max(8000).optional(),
    canvasHeight: z.number().int().positive().max(8000).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, "no fields to update");

/** PATCH — rename the reel, or change its output canvas. Status/progress/
 *  local_path/error are exclusively the export job's own bookkeeping (see
 *  REELS_DESIGN.md's export job shape) and deliberately not editable here —
 *  a client marking its own reel "ready" without a real render would be a
 *  straightforward footgun, not a feature. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = PatchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const db = supabaseAdmin();
  const update: Record<string, unknown> = {};
  if (parsed.data.title !== undefined) update.title = parsed.data.title;
  if (parsed.data.canvasWidth !== undefined) update.canvas_width = parsed.data.canvasWidth;
  if (parsed.data.canvasHeight !== undefined) update.canvas_height = parsed.data.canvasHeight;

  const { data, error } = await db.from("reels").update(update).eq("id", id).select().single();
  if (isMissingTable(error)) return migrationNeeded();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "reel not found" }, { status: 404 });

  return NextResponse.json({ reel: data });
}

/** DELETE — the reel and every one of its segments (cascade). Does not
 *  touch the source videos those segments pointed at, obviously — only the
 *  reel's own pick-list. */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = supabaseAdmin();

  const { error } = await db.from("reels").delete().eq("id", id);
  if (isMissingTable(error)) return migrationNeeded();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
