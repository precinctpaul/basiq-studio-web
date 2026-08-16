import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

/** GET /api/videos/{id}/transcript — existing transcript + its segments, or nulls if none yet. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: videoId } = await ctx.params;
  const db = supabaseAdmin();

  const { data: transcript } = await db
    .from("transcripts")
    .select("*")
    .eq("video_id", videoId)
    .maybeSingle();

  if (!transcript) {
    return NextResponse.json({ transcript: null, segments: [] });
  }

  const { data: segments, error: segError } = await db
    .from("transcript_segments")
    .select("start_seconds, end_seconds, text")
    .eq("transcript_id", transcript.id)
    .order("idx", { ascending: true });
  if (segError) {
    return NextResponse.json({ error: segError.message }, { status: 500 });
  }

  return NextResponse.json({
    transcript,
    segments: (segments ?? []).map((s) => ({ start: s.start_seconds, end: s.end_seconds, text: s.text })),
  });
}
