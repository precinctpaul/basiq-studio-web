import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { isMissingTable } from "@/lib/supabase-errors";

export const runtime = "nodejs";

/** Answered when migration 0016 hasn't been run yet — same 503-not-500
 *  pattern as the tags route, for the same reason: the feature is
 *  unavailable, not broken. */
function migrationNeeded() {
  return NextResponse.json(
    { error: "reels table missing — run supabase/migrations/0016_reels.sql", reels: [] },
    { status: 503 },
  );
}

/** GET — every reel, newest-updated first, with its segment count for the
 *  reel switcher (see REELS_DESIGN.md's "persistent active reel" UI). The
 *  count comes from PostgREST's embedded-resource count aggregate rather
 *  than a second round trip per reel. */
export async function GET() {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("reels")
    .select("*, reel_segments(count)")
    .order("updated_at", { ascending: false });
  if (isMissingTable(error)) return migrationNeeded();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const reels = (data ?? []).map((r) => {
    const { reel_segments, ...rest } = r as typeof r & {
      reel_segments: { count: number }[];
    };
    return { ...rest, segment_count: reel_segments?.[0]?.count ?? 0 };
  });
  return NextResponse.json({ reels });
}

const PostBody = z.object({
  title: z.string().trim().min(1).max(300).default("Untitled Reel"),
  canvasWidth: z.number().int().positive().max(8000).default(1080),
  canvasHeight: z.number().int().positive().max(8000).default(1920),
});

/** POST — create a new, empty reel. This is what "+ New Reel" in the
 *  drawer's switcher calls; segments are added separately (see
 *  app/api/reels/[id]/segments/route.ts). */
export async function POST(req: NextRequest) {
  const parsed = PostBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("reels")
    .insert({
      title: parsed.data.title,
      canvas_width: parsed.data.canvasWidth,
      canvas_height: parsed.data.canvasHeight,
    })
    .select()
    .single();
  if (isMissingTable(error)) return migrationNeeded();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ reel: { ...data, segment_count: 0 } });
}
