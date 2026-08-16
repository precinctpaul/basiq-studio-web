import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

/**
 * A single clip, plus its share link.
 *
 * No playback url is minted here — a clip on the shared drive is served by
 * the operator's own agent, exactly like a video master, and only the
 * client knows that agent's address (see agentMediaUrl in lib/agent.ts).
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = supabaseAdmin();

  const { data: clip, error } = await db.from("clips").select("*").eq("id", id).single();
  if (error || !clip) {
    return NextResponse.json({ error: error?.message ?? "clip not found" }, { status: 404 });
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
    localPath: clip.local_path,
    shareToken: token?.token ?? null,
    shareUrl: token ? `/share/${token.token}` : null,
    downloadCount: token?.download_count ?? 0,
  });
}
