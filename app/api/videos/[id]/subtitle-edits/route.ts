import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadSubtitleEdits } from "@/lib/subtitle-edits";

export const runtime = "nodejs";

/**
 * Hand fixes to this video's burned-in SUBTITLE text (lib/subtitle-edits.ts).
 *
 * Writes only to public.subtitle_edits. The transcript and its segments are
 * read here (to know what an edit is relative to) and never written.
 */

async function readyTranscript(videoId: string) {
  const db = supabaseAdmin();
  const { data: transcript } = await db
    .from("transcripts")
    .select("id, status")
    .eq("video_id", videoId)
    .maybeSingle();
  return transcript && transcript.status === "ready" ? transcript : null;
}

/** GET → { transcriptId, edits: { [idx]: text } } — only edits that still apply. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: videoId } = await ctx.params;
  const transcript = await readyTranscript(videoId);
  if (!transcript) return NextResponse.json({ transcriptId: null, edits: {} });

  const db = supabaseAdmin();
  // Only the edited segments' current text is needed to validate the edits.
  const { data: rows, error } = await db
    .from("subtitle_edits")
    .select("segment_idx")
    .eq("transcript_id", transcript.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const idxs = (rows ?? []).map((r) => r.segment_idx);
  if (idxs.length === 0) return NextResponse.json({ transcriptId: transcript.id, edits: {} });

  const { data: segs, error: segError } = await db
    .from("transcript_segments")
    .select("idx, text")
    .eq("transcript_id", transcript.id)
    .in("idx", idxs);
  if (segError) return NextResponse.json({ error: segError.message }, { status: 500 });

  const edits = await loadSubtitleEdits(db, transcript.id, segs ?? []);
  return NextResponse.json({ transcriptId: transcript.id, edits: Object.fromEntries(edits) });
}

const Put = z.object({
  idx: z.number().int().min(0),
  text: z.string().max(2000),
});

/**
 * PUT { idx, text } → save one segment's subtitle text. Setting it back to
 * the transcript's own text (RESET) removes the edit instead of storing a
 * no-op copy.
 */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: videoId } = await ctx.params;
  const parsed = Put.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { idx, text } = parsed.data;

  const transcript = await readyTranscript(videoId);
  if (!transcript) return NextResponse.json({ error: "no finished transcript for this video" }, { status: 400 });

  const db = supabaseAdmin();
  const { data: seg } = await db
    .from("transcript_segments")
    .select("text")
    .eq("transcript_id", transcript.id)
    .eq("idx", idx)
    .maybeSingle();
  if (!seg) return NextResponse.json({ error: "no such transcript segment" }, { status: 404 });

  if (text.trim() === seg.text.trim()) {
    const { error } = await db
      .from("subtitle_edits")
      .delete()
      .eq("transcript_id", transcript.id)
      .eq("segment_idx", idx);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, edited: false });
  }

  const { error } = await db.from("subtitle_edits").upsert(
    {
      video_id: videoId,
      transcript_id: transcript.id,
      segment_idx: idx,
      text,
      original_text: seg.text,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "transcript_id,segment_idx" },
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, edited: true });
}
