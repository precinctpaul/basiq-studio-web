import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

/**
 * POST /api/videos/{id}/transcripts — starts a transcription run.
 *
 * Creates the pending transcripts row and hands back a long-lived signed URL
 * to the ORIGINAL video: the browser passes that straight to the user's own
 * local whisper server (tools/whisper_server.py), which downloads it and
 * transcribes on their machine. This route never touches the audio itself —
 * transcription is Vercel-free by design.
 *
 * 6 hours: generous enough that downloading even an 11-hour source over a
 * home connection can't outrun it, without leaving a signed link valid for
 * days.
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: videoId } = await ctx.params;
  const db = supabaseAdmin();

  const { data: video, error: videoError } = await db
    .from("videos")
    .select("id, storage_path, status")
    .eq("id", videoId)
    .single();
  if (videoError || !video) {
    return NextResponse.json({ error: "video not found" }, { status: 404 });
  }
  if (video.status !== "ready" || !video.storage_path) {
    return NextResponse.json(
      { error: `video is not ready yet (status: ${video.status})` },
      { status: 400 },
    );
  }

  const { data: signed, error: signError } = await db.storage
    .from("videos")
    .createSignedUrl(video.storage_path, 6 * 3600);
  if (signError || !signed) {
    return NextResponse.json(
      { error: signError?.message ?? "could not sign source url" },
      { status: 500 },
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
    sourceUrl: signed.signedUrl,
  });
}
