import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

/**
 * GET /api/share/{token}/download - validates the token, counts the
 * download atomically (see migrations/0002), and hands back the clip's
 * local_path. The actual bytes never pass through Vercel: the CLIENT turns
 * this into an agent url (agentMediaUrl in lib/agent.ts) and navigates
 * there directly, because only the browser knows which agent to ask —
 * exactly the same reasoning as video playback in the main app.
 *
 * This used to redirect straight to a signed Supabase url. There is no
 * bucket left to sign a url against; a clip on the shared drive has no
 * server-side download step to redirect to at all.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const db = supabaseAdmin();

  const { data: row, error } = await db
    .from("share_tokens")
    .select("token, clip_id, revoked_at, clips(local_path, status)")
    .eq("token", token)
    .single();

  if (error || !row || row.revoked_at) {
    return NextResponse.json({ error: "link not found" }, { status: 404 });
  }

  const clip = row.clips as unknown as { local_path: string | null; status: string } | null;
  if (!clip || clip.status !== "ready" || !clip.local_path) {
    return NextResponse.json({ error: "clip is not ready" }, { status: 404 });
  }

  // Fire-and-forget: a slow or failed counter update should never block or
  // break an actual download. Atomic (migrations/0002) so concurrent
  // downloads of the same link don't lose an increment to a race. The
  // explicit catch is load-bearing, not decoration — an un-caught rejection
  // here is an unhandled promise rejection in the function process, which
  // Node can escalate into a crash of a request that otherwise succeeded.
  // Promise.resolve(...) is required, not stylistic: supabase-js's query
  // builder is thenable (has .then, so `await` works on it) but is NOT a
  // real Promise and has no .catch method of its own — confirmed live, that
  // exact call threw "db.rpc(...).catch is not a function" the first time
  // this shipped. Promise.resolve() on a thenable produces a genuine Promise.
  Promise.resolve(db.rpc("increment_download_count", { p_token: token })).catch((err) => {
    console.error("increment_download_count failed:", err);
  });

  return NextResponse.json({ localPath: clip.local_path });
}
