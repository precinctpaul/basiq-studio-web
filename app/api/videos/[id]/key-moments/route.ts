import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { groupParagraphs } from "@/lib/paragraphs";
import { extractTopicSections } from "@/lib/highlights";

export const runtime = "nodejs";

/**
 * Key Moments are COMPUTED ONCE AND STORED.
 *
 * They used to be derived in the browser every time the tab was shown, which
 * meant every visit replayed the whole pipeline in front of the operator:
 * keyword labels first, then a wait, then the sentences — and leaving the tab
 * and coming back started it over. Sectioning is cheap, but the summaries are
 * a local model doing real work, and neither should be repeated for a
 * transcript that hasn't changed.
 *
 * So: GET is the fast path and returns whatever is stored. POST sections the
 * transcript and writes the rows (returning each section's text so the caller
 * can summarise without recomputing). PATCH stores the summaries once the
 * agent has written them.
 */

/** POST — section the transcript and store the moments (labels first). */
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

  // Idempotent re-run: a second call after re-transcribing shouldn't
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

  return NextResponse.json({
    keyMoments: inserted,
    // The section prose, so the caller can hand it straight to the agent's
    // summariser rather than re-deriving the same sections client-side.
    texts: sections.map((s) => s.text),
  });
}

const PatchBody = z.object({
  /** Index-aligned with the stored moments; null means "no summary worth showing". */
  summaries: z.array(z.string().max(1000).nullable()).max(50),
});

/** PATCH — attach the agent's written summaries to the stored moments. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: videoId } = await ctx.params;
  const parsed = PatchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data: existing, error } = await db
    .from("key_moments")
    .select("id, idx")
    .eq("video_id", videoId)
    .order("idx", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Update by id rather than upserting the whole set: the rows already exist
  // and their timings are authoritative — only the summary text is new.
  const updates = (existing ?? [])
    .map((row) => ({ row, summary: parsed.data.summaries[row.idx] }))
    .filter((u) => typeof u.summary === "string" && u.summary.trim().length > 0);

  for (const { row, summary } of updates) {
    const { error: updateError } = await db
      .from("key_moments")
      .update({ summary })
      .eq("id", row.id);
    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }
  }

  const { data } = await db
    .from("key_moments")
    .select("*")
    .eq("video_id", videoId)
    .order("idx", { ascending: true });
  return NextResponse.json({ keyMoments: data ?? [] });
}

/** GET — the fast path: whatever is stored, no computation at all. */
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
