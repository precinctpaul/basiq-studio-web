import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { BUCKET_ORDER, UNCATEGORIZED } from "@/lib/buckets";

export const runtime = "nodejs";

const ALLOWED_BUCKETS: string[] = [...BUCKET_ORDER, UNCATEGORIZED];

const Body = z.object({
  bucket: z.string().refine((b) => ALLOWED_BUCKETS.includes(b), "unknown bucket"),
});

/**
 * POST — manually assign or clear a video's bucket. Until now, the only way
 * a video's bucket/person tags were ever set was automatically (see
 * lib/bucketClassifier.ts, run at grab time and again after auto-tagging) —
 * there was no way to fix one by hand at all, even though a manual tag typed
 * into the regular tag box looked like it should work (it didn't: it always
 * wrote kind=null, never kind="bucket").
 *
 * Replaces any existing bucket tag rather than adding a second one — a video
 * only ever lives under one bucket folder. Person tags are left untouched:
 * a manual bucket move doesn't imply a specific person (e.g. moving
 * something to "Institutional"), so this only ever touches kind="bucket".
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const db = supabaseAdmin();

  const { error: delError } = await db.from("tags").delete().eq("video_id", id).eq("kind", "bucket");
  if (delError) return NextResponse.json({ error: delError.message }, { status: 500 });

  if (parsed.data.bucket !== UNCATEGORIZED) {
    const { error } = await db
      .from("tags")
      .upsert(
        { video_id: id, label: parsed.data.bucket, source: "manual", kind: "bucket" },
        { onConflict: "video_id,label" },
      );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data } = await db
    .from("tags")
    .select("id, label, source, kind")
    .eq("video_id", id)
    .order("source", { ascending: false })
    .order("label");
  return NextResponse.json({ tags: data ?? [] });
}
