import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { groupParagraphs } from "@/lib/paragraphs";
import { extractTopicSections } from "@/lib/highlights";

export const runtime = "nodejs";

/**
 * POST /api/videos/{id}/key-moments — topic-sections the video's transcript.
 *
 * DECISION NOTE (Sprint 2): this deliberately produces LABEL-ONLY key
 * moments (key_moments.summary stays null) rather than the desktop app's
 * abstractive one-sentence summaries (app/summarize.py). That file runs a
 * ~1.2GB local distilbart model via torch/transformers, which has no home in
 * a Vercel function — the same "must run on the user's own machine" logic
 * that put Whisper in tools/whisper_server.py applies here too. Rather than
 * silently drop the feature or reach for a paid hosted API (which would
 * contradict the "nothing leaves the machine" principle summarize.py itself
 * was built around), this ships the TF-IDF label sectioning now — which
 * needs no model and is exactly what the desktop app itself falls back to
 * when its summarizer is unavailable — and leaves summary as a nullable
 * column ready for a follow-on: a /summarize endpoint added to the same
 * local server, once wanted.
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: videoId } = await ctx.params;
  const db = supabaseAdmin();

  const { data: transcript, error: transcriptError } = await db
    .from("transcripts")
    .select("id, status")
    .eq("video_id", videoId)
    .maybeSingle();
  if (transcriptError) {
    return NextResponse.json({ error: transcriptError.message }, { status: 500 });
  }
  if (!transcript || transcript.status !== "ready") {
    return NextResponse.json({ error: "video has no ready transcript yet" }, { status: 400 });
  }

  const { data: segments, error: segError } = await db
    .from("transcript_segments")
    .select("start_seconds, end_seconds, text")
    .eq("transcript_id", transcript.id)
    .order("idx", { ascending: true });
  if (segError) {
    return NextResponse.json({ error: segError.message }, { status: 500 });
  }

  const paragraphs = groupParagraphs(
    (segments ?? []).map((s) => ({ start: s.start_seconds, end: s.end_seconds, text: s.text })),
  );
  const sections = extractTopicSections(paragraphs);

  if (sections.length === 0) {
    return NextResponse.json(
      { error: "transcript is too short to section into key moments" },
      { status: 400 },
    );
  }

  // Idempotent re-run: a second click after editing the transcript shouldn't
  // accumulate duplicate moments alongside the old set.
  const { error: deleteError } = await db.from("key_moments").delete().eq("video_id", videoId);
  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  const rows = sections.map((s, idx) => ({
    video_id: videoId,
    idx,
    start_seconds: s.start,
    end_seconds: s.end,
    label: s.label,
    summary: null,
  }));
  const { data: inserted, error: insertError } = await db.from("key_moments").insert(rows).select();
  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json({ keyMoments: inserted });
}

/** GET /api/videos/{id}/key-moments — existing moments, without recomputing. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: videoId } = await ctx.params;
  const db = supabaseAdmin();

  const { data, error } = await db
    .from("key_moments")
    .select("*")
    .eq("video_id", videoId)
    .order("idx", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ keyMoments: data ?? [] });
}
