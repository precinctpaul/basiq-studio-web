import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

/**
 * WebVTT captions built from the transcript.
 *
 * The desktop's CC button lists subtitle tracks libVLC found inside the file.
 * A browser cannot do that: HTML5 video only exposes tracks that arrive as
 * separate <track> elements, and subtitles muxed into an MP4 (mov_text) are
 * invisible to it entirely. Downloading publisher subtitles as sidecars would
 * only help the files that happen to have them.
 *
 * The transcript is a better source anyway — it exists for every file the
 * operator has transcribed, it is the same text the transcript pane and
 * search already use, and it costs no extra storage because it is generated
 * on request from rows we already have.
 */
function formatVttTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${sec
    .toFixed(3)
    .padStart(6, "0")}`;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: videoId } = await ctx.params;
  const db = supabaseAdmin();

  const { data: transcript } = await db
    .from("transcripts")
    .select("id, status")
    .eq("video_id", videoId)
    .maybeSingle();

  if (!transcript || transcript.status !== "ready") {
    return NextResponse.json({ error: "no transcript for this video" }, { status: 404 });
  }

  const { data: segments, error } = await db
    .from("transcript_segments")
    .select("start_seconds, end_seconds, text")
    .eq("transcript_id", transcript.id)
    .order("idx", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const cues = (segments ?? [])
    .filter((s) => (s.text ?? "").trim().length > 0)
    .map((s, i) => {
      // A zero-length cue never paints. Whisper occasionally emits one when a
      // segment is clipped at a boundary.
      const end = s.end_seconds > s.start_seconds ? s.end_seconds : s.start_seconds + 1;
      return `${i + 1}\n${formatVttTime(s.start_seconds)} --> ${formatVttTime(end)}\n${s.text.trim()}`;
    });

  const vtt = `WEBVTT\n\n${cues.join("\n\n")}\n`;

  return new NextResponse(vtt, {
    headers: {
      "Content-Type": "text/vtt; charset=utf-8",
      // Regenerated from the DB on demand and cheap, but stable for a given
      // transcript — a short cache keeps track-switching from re-querying.
      "Cache-Control": "private, max-age=300",
    },
  });
}
