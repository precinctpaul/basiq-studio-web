import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { BUCKET_ORDER, UNCATEGORIZED } from "@/lib/buckets";
import rosterData from "@/lib/rosterData.json";

export const runtime = "nodejs";

const ALLOWED_BUCKETS: string[] = [...BUCKET_ORDER, UNCATEGORIZED];

// display name (as shown to and picked by the operator) -> that person's own
// roster bucket. Built once from the same roster lib/bucketClassifier.ts
// itself matches against, so a person can only ever be filed under the
// bucket the roster actually says they belong to -- never an arbitrary
// client-supplied pairing.
const PERSON_TO_BUCKET = new Map<string, string>(
  Object.values(rosterData as Record<string, { display: string; bucket: string }>).map((entry) => [
    entry.display.toLowerCase(),
    entry.bucket,
  ]),
);

const Body = z
  .object({
    bucket: z.string().refine((b) => ALLOWED_BUCKETS.includes(b), "unknown bucket").optional(),
    /** A specific roster person, deeper than just a bucket (e.g. "James
     *  Talarico", not just "The Bench") -- the bucket tag is derived from
     *  the roster, not taken from `bucket` above, so the two can never
     *  disagree. */
    person: z.string().trim().min(1).optional(),
  })
  .refine((data) => data.bucket || data.person, "must provide bucket or person");

/**
 * POST — manually assign or clear a video's bucket, optionally down to a
 * specific person. Until now, the only way a video's bucket/person tags
 * were ever set was automatically (see lib/bucketClassifier.ts, run at grab
 * time and again after auto-tagging) — there was no way to fix one by hand
 * at all, even though a manual tag typed into the regular tag box looked
 * like it should work (it didn't: it always wrote kind=null, never
 * kind="bucket").
 *
 * Always replaces both the existing bucket AND person tag rather than
 * layering a new one on top — a video only ever lives under one bucket
 * folder, and a stale person tag left over from a previous (correct or
 * incorrect) assignment would silently contradict a newly-picked bucket.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  let bucket = parsed.data.bucket;
  let person = parsed.data.person;
  if (person) {
    const rosterBucket = PERSON_TO_BUCKET.get(person.toLowerCase());
    if (!rosterBucket) {
      return NextResponse.json({ error: `unknown person: ${person}` }, { status: 400 });
    }
    bucket = rosterBucket;
  } else {
    person = undefined;
  }

  const db = supabaseAdmin();

  const { error: delError } = await db
    .from("tags")
    .delete()
    .eq("video_id", id)
    .in("kind", ["bucket", "person"]);
  if (delError) return NextResponse.json({ error: delError.message }, { status: 500 });

  const rows: { video_id: string; label: string; source: "manual"; kind: "bucket" | "person" }[] = [];
  if (bucket && bucket !== UNCATEGORIZED) {
    rows.push({ video_id: id, label: bucket, source: "manual", kind: "bucket" });
  }
  if (person) {
    rows.push({ video_id: id, label: person, source: "manual", kind: "person" });
  }
  if (rows.length > 0) {
    const { error } = await db.from("tags").upsert(rows, { onConflict: "video_id,label" });
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
