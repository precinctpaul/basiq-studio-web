import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

/**
 * A single clip, with a fresh playback url and its share link.
 *
 * Signed urls are minted here rather than stored for the same reason as the
 * video route: they expire, so the only correct time to make one is when
 * somebody is about to use it. The share TOKEN is the durable artifact — the
 * /share/<token> page re-signs on every download, which is what lets a link
 * keep working long after any individual signature has died.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = supabaseAdmin();

  const { data: clip, error } = await db.from("clips").select("*").eq("id", id).single();
  if (error || !clip) {
    return NextResponse.json({ error: error?.message ?? "clip not found" }, { status: 404 });
  }

  let playbackUrl: string | null = null;
  let playbackError = "";
  if (clip.storage_path) {
    const { data: signed, error: signError } = await db.storage
      .from("clips")
      .createSignedUrl(clip.storage_path, 3600);
    playbackUrl = signed?.signedUrl ?? null;
    if (signError) playbackError = signError.message;
  }

  const { data: token } = await db
    .from("share_tokens")
    .select("token, download_count")
    .eq("clip_id", id)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({
    clip,
    playbackUrl,
    playbackError,
    shareToken: token?.token ?? null,
    shareUrl: token ? `/share/${token.token}` : null,
    downloadCount: token?.download_count ?? 0,
  });
}
