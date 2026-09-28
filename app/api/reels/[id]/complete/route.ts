import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { generateShareToken } from "@/lib/share-token";

export const runtime = "nodejs";

const Body = z.object({
  localPath: z.string().min(1).max(1000),
  sizeBytes: z.number().int().nonnegative(),
  durationSeconds: z.number().nonnegative().default(0),
});

/**
 * Finish a reel the LOCAL AGENT rendered (cut+normalized every segment,
 * then concatenated them — see REELS_DESIGN.md) and filed onto the shared
 * drive. Mirrors /api/clips/[id]/complete exactly: the drive write already
 * happened, this only records where it landed and mints the share token.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data: reel, error: readError } = await db
    .from("reels")
    .select("id, title")
    .eq("id", id)
    .single();
  if (readError || !reel) {
    return NextResponse.json({ error: "reel not found" }, { status: 404 });
  }

  const { error: updateError } = await db
    .from("reels")
    .update({
      local_path: parsed.data.localPath,
      size_bytes: parsed.data.sizeBytes,
      duration_seconds: parsed.data.durationSeconds,
      status: "ready",
      progress: 100,
      completed_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  const { data: existing } = await db
    .from("share_tokens")
    .select("token")
    .eq("reel_id", id)
    .is("revoked_at", null)
    .limit(1)
    .maybeSingle();

  let token = existing?.token;
  if (!token) {
    token = generateShareToken();
    const { error: tokenError } = await db.from("share_tokens").insert({ reel_id: id, token });
    if (tokenError) {
      return NextResponse.json({ error: tokenError.message }, { status: 500 });
    }
  }

  return NextResponse.json({
    reelId: id,
    shareToken: token,
    shareUrl: `/share/${token}`,
    sizeBytes: parsed.data.sizeBytes,
    durationSeconds: parsed.data.durationSeconds,
  });
}
