import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";
// Segment inserts for an 11-hour transcript could be several thousand rows;
// generous but bounded headroom, not a number the route expects to need.
export const maxDuration = 60;

const Body = z.object({
  segments: z
    .array(
      z.object({
        start: z.number().min(0),
        end: z.number().min(0),
        text: z.string().min(1),
      }),
    )
    .min(1),
  language: z.string().max(20).optional(),
});

/**
 * POST /api/transcripts/{id}/segments — the browser calls this after the
 * user's local whisper server (tools/whisper_server.py) returns its result.
 * This route never talks to the whisper server itself; it only persists
 * what the browser already received from it.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: transcriptId } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { segments, language } = parsed.data;

  const db = supabaseAdmin();
  const { data: transcript, error: fetchError } = await db
    .from("transcripts")
    .select("id, video_id")
    .eq("id", transcriptId)
    .single();
  if (fetchError || !transcript) {
    return NextResponse.json({ error: "transcript not found" }, { status: 404 });
  }

  // Idempotent regardless of caller order: a retry should never leave stale
  // segments from a previous attempt sitting alongside the new ones.
  const { error: deleteError } = await db
    .from("transcript_segments")
    .delete()
    .eq("transcript_id", transcriptId);
  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  const rows = segments.map((s, idx) => ({
    transcript_id: transcriptId,
    idx,
    start_seconds: s.start,
    end_seconds: s.end,
    text: s.text,
  }));
  const { error: insertError } = await db.from("transcript_segments").insert(rows);
  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  // Same role as database.build_row's transcript_text on the desktop app:
  // the flattened prose is what search matches against, so segment
  // timestamps never pollute a query (see search_tsv in migration 0001).
  const fullText = segments.map((s) => s.text).join(" ");

  const { error: updateError } = await db
    .from("transcripts")
    .update({
      full_text: fullText,
      language: language ?? "en",
      status: "ready",
      error: "",
    })
    .eq("id", transcriptId);
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, videoId: transcript.video_id, segmentCount: rows.length });
}
