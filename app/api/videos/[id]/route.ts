import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

/**
 * Single video + a FRESH signed playback url. Never persisted — signed urls
 * expire, so the only correct place to mint one is on demand, same reasoning
 * as the finalize route's read url.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = supabaseAdmin();

  const { data: video, error } = await db.from("videos").select("*").eq("id", id).single();
  if (error || !video) {
    return NextResponse.json({ error: error?.message ?? "video not found" }, { status: 404 });
  }

  let playbackUrl: string | null = null;
  let playbackError = "";
  // A master on the shared drive is served by the operator's own agent — the
  // client turns this relative marker into an agent URL, because only it
  // knows where that agent is listening.
  if (video.local_path) {
    return NextResponse.json({
      video,
      playbackUrl: null,
      localPath: video.local_path,
      playbackError: "",
    });
  }
  if (video.storage_path) {
    // 1 hour: long enough for an editing session, short enough that a leaked
    // link in a browser history entry doesn't work forever.
    const { data: signed, error: signError } = await db.storage
      .from("videos")
      .createSignedUrl(video.storage_path, 3600);
    playbackUrl = signed?.signedUrl ?? null;
    // Surfaced, not swallowed: discarding this error made a failed signing
    // look identical to a row that simply has no file yet, which sent me
    // hunting the wrong bug entirely.
    if (signError) playbackError = signError.message;
  }

  return NextResponse.json({ video, playbackUrl, playbackError });
}

const PatchBody = z.object({
  title: z.string().min(1).max(500).optional(),
  uploader: z.string().max(300).optional(),
  channel: z.string().max(300).optional(),
  // "YYYYMMDD", whatever yt-dlp reported — see migrations/0003.
  upload_date: z.string().max(20).optional(),
  source_url: z.string().max(2000).optional(),
  size_bytes: z.number().int().nonnegative().optional(),
  // The rest are for a LIVE CAPTURE finishing: its local_path changes (a
  // successful remux renames the file from .ts to .mp4) and its probe fields
  // arrive from the SAME agentLibrary() scan the client already used to find
  // that file, rather than from a library rescan.
  //
  // That distinction matters: /api/library/sync's update path unconditionally
  // resets `title` back to the sanitised filename whenever size or duration
  // changed, which is exactly what just happened to a file that finished
  // recording. Setting probe fields here, in the same PATCH that also sets
  // the real title, sidesteps that clobber entirely — sync sees them already
  // matching and does nothing.
  local_path: z.string().min(1).max(1000).optional(),
  status: z.enum(["ready", "failed"]).optional(),
  duration_seconds: z.number().nonnegative().optional(),
  width: z.number().int().nonnegative().optional(),
  height: z.number().int().nonnegative().optional(),
  fps: z.number().nonnegative().optional(),
  has_video: z.boolean().optional(),
  has_audio: z.boolean().optional(),
  vcodec: z.string().max(50).optional(),
  acodec: z.string().max(50).optional(),
});

/**
 * PATCH — metadata the local agent only learns after yt-dlp has resolved the
 * page: the real title, uploader, publish date. For a grab, the row is
 * discovered by the library scan already probed; this only overlays what
 * ffprobe can't know. For a live capture finishing, this is also how the row
 * moves out of 'recording' — see the local_path/status fields above.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = PatchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: "no fields to update" }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("videos")
    .update(parsed.data)
    .eq("id", id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ video: data });
}
