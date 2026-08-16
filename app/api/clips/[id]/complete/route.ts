import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { generateShareToken } from "@/lib/share-token";

export const runtime = "nodejs";

const Body = z.object({
  localPath: z.string().min(1).max(1000),
  sizeBytes: z.number().int().nonnegative(),
});

/**
 * Finish a clip the LOCAL AGENT rendered and filed onto the shared drive.
 *
 * The drive write already happened, so this only records where it landed
 * and mints the share token. Internal-only sharing means the token just has
 * to resolve for a teammate whose own agent has the same drive mounted —
 * see app/share/[token]/page.tsx.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data: clip, error: readError } = await db
    .from("clips")
    .select("id, status, duration_seconds")
    .eq("id", id)
    .single();
  if (readError || !clip) {
    return NextResponse.json({ error: "clip not found" }, { status: 404 });
  }

  const { error: updateError } = await db
    .from("clips")
    .update({
      local_path: parsed.data.localPath,
      size_bytes: parsed.data.sizeBytes,
      status: "ready",
      progress: 100,
      completed_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  // Reuse an existing live token if this clip is being re-completed, so a
  // link already sent to someone keeps working.
  const { data: existing } = await db
    .from("share_tokens")
    .select("token")
    .eq("clip_id", id)
    .is("revoked_at", null)
    .limit(1)
    .maybeSingle();

  let token = existing?.token;
  if (!token) {
    token = generateShareToken();
    const { error: tokenError } = await db.from("share_tokens").insert({ clip_id: id, token });
    if (tokenError) {
      return NextResponse.json({ error: tokenError.message }, { status: 500 });
    }
  }

  return NextResponse.json({
    clipId: id,
    shareToken: token,
    shareUrl: `/share/${token}`,
    sizeBytes: parsed.data.sizeBytes,
    durationSeconds: clip.duration_seconds,
  });
}
