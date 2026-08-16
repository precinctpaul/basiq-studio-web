import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { isMissingTable } from "@/lib/supabase-errors";

export const runtime = "nodejs";

/** Answered when migration 0004 hasn't been run yet. 503 rather than 500: the
 *  feature is unavailable, not broken, and the client degrades to "no tags". */
function migrationNeeded() {
  return NextResponse.json(
    { error: "tags table missing — run supabase/migrations/0004_tags.sql", tags: [] },
    { status: 503 },
  );
}

/** GET — every tag on a video, manual first so the operator's own work leads. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("tags")
    .select("id, label, source, kind")
    .eq("video_id", id)
    .order("source", { ascending: false }) // 'manual' > 'auto' alphabetically
    .order("label");
  if (isMissingTable(error)) return migrationNeeded();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ tags: data ?? [] });
}

const PostBody = z.object({
  /** A single label typed by an operator. */
  label: z.string().trim().min(1).max(60).optional(),
  /** A full auto-derived set from the agent, replacing any previous auto set. */
  auto: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(60),
        kind: z.string().max(20).optional(),
      }),
    )
    .max(50)
    .optional(),
});

/**
 * POST — add one manual tag, or replace the whole auto set.
 *
 * Replacing rather than merging the auto set is deliberate and matches the
 * desktop: auto tags are derived from the media, so a re-derivation is the
 * truth and anything left over from a previous run is stale. Manual tags are
 * never touched by this.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = PostBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const db = supabaseAdmin();

  if (parsed.data.label) {
    const label = parsed.data.label;
    // Upsert on (video_id, label): if the agent already derived this tag, the
    // operator typing it PROMOTES it to manual rather than creating a
    // duplicate or failing on the unique constraint. Their version then
    // survives the next re-derivation, which is the whole point.
    const { error } = await db
      .from("tags")
      .upsert({ video_id: id, label, source: "manual", kind: null }, { onConflict: "video_id,label" });
    if (isMissingTable(error)) return migrationNeeded();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (parsed.data.auto) {
    const { error: delError } = await db
      .from("tags")
      .delete()
      .eq("video_id", id)
      .eq("source", "auto");
    if (isMissingTable(delError)) return migrationNeeded();
    if (delError) return NextResponse.json({ error: delError.message }, { status: 500 });

    // Drop any auto tag whose label an operator already owns manually —
    // inserting it would violate the unique constraint and, more importantly,
    // would silently demote their tag to disposable.
    const { data: manual } = await db
      .from("tags")
      .select("label")
      .eq("video_id", id)
      .eq("source", "manual");
    const owned = new Set((manual ?? []).map((t) => t.label.toLowerCase()));

    const rows = parsed.data.auto
      .filter((t) => !owned.has(t.label.toLowerCase()))
      .map((t) => ({ video_id: id, label: t.label, source: "auto", kind: t.kind ?? null }));

    if (rows.length > 0) {
      const { error } = await db.from("tags").insert(rows);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  const { data } = await db
    .from("tags")
    .select("id, label, source, kind")
    .eq("video_id", id)
    .order("source", { ascending: false })
    .order("label");
  return NextResponse.json({ tags: data ?? [] });
}

/** DELETE — remove one tag by label, whatever its source. */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const label = req.nextUrl.searchParams.get("label");
  if (!label) return NextResponse.json({ error: "missing 'label'" }, { status: 400 });

  const db = supabaseAdmin();
  const { error } = await db.from("tags").delete().eq("video_id", id).eq("label", label);
  if (isMissingTable(error)) return migrationNeeded();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
