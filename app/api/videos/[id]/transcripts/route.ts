import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

/**
 * POST /api/videos/{id}/transcripts — starts a transcription run.
 *
 * Creates the pending transcripts row and hands back the video's local_path:
 * the browser passes that straight to the operator's own agent, which reads
 * it off the shared drive and transcribes on their machine. This route never
 * touches the audio itself — transcription is Vercel-free by design.
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: videoId } = await ctx.params;
  const db = supabaseAdmin();

  const { data: video, error: videoError } = await db
    .from("videos")
    .select("id, local_path, status")
    .eq("id", videoId)
    .single();
  if (videoError || !video) {
    return NextResponse.json({ error: "video not found" }, { status: 404 });
  }
  // 'recording' is allowed deliberately: a live capture's local_path exists
  // (and is already growing on the drive) from the moment the row is
  // created, which is what lets its transcript start before the stream ends.
  if (!video.local_path || (video.status !== "ready" && video.status !== "recording")) {
    return NextResponse.json(
      { error: `video is not ready yet (status: ${video.status})` },
      { status: 400 },
    );
  }

  // One transcript per video (transcripts.video_id is UNIQUE) — a re-run
  // replaces the previous attempt rather than accumulating duplicates.
  const { data: transcript, error: upsertError } = await db
    .from("transcripts")
    .upsert(
      { video_id: videoId, status: "pending", error: "", full_text: "" },
      { onConflict: "video_id" },
    )
    .select()
    .single();
  if (upsertError || !transcript) {
    return NextResponse.json(
      { error: upsertError?.message ?? "could not create transcript row" },
      { status: 500 },
    );
  }

  // A retry needs a clean slate — stale segments from a previous, possibly
  // different-length attempt would otherwise sit alongside the new ones.
  await db.from("transcript_segments").delete().eq("transcript_id", transcript.id);

  return NextResponse.json({
    transcriptId: transcript.id,
    localPath: video.local_path,
  });
}
