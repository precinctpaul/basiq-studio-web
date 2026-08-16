import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

/**
 * GET /api/share/{token}/download - the actual "downloads clips forever, no
 * auth" mechanism. Looks up the token, 404s if it's missing/revoked/points at
 * a clip that never finished, mints a short-lived signed url for the real
 * file, counts the download atomically (see migrations/0002), and redirects.
 *
 * A fresh signed url every time rather than a stored one: signed urls expire,
 * so persisting one would only ever work until it did - "forever" has to mean
 * re-signing on each request, not a link that outlives its own signature.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const db = supabaseAdmin();

  const { data: row, error } = await db
    .from("share_tokens")
    .select("token, clip_id, revoked_at, clips(storage_path, status)")
    .eq("token", token)
    .single();

  if (error || !row || row.revoked_at) {
    return NextResponse.json({ error: "link not found" }, { status: 404 });
  }

  const clip = row.clips as unknown as { storage_path: string | null; status: string } | null;
  if (!clip || clip.status !== "ready" || !clip.storage_path) {
    return NextResponse.json({ error: "clip is not ready" }, { status: 404 });
  }

  const { data: signed, error: signError } = await db.storage
    .from("clips")
    .createSignedUrl(clip.storage_path, 300, { download: true });
  if (signError || !signed) {
    return NextResponse.json({ error: signError?.message ?? "could not sign url" }, { status: 500 });
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

  return NextResponse.redirect(signed.signedUrl, { status: 302 });
}
