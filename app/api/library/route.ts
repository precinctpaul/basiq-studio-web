import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

/**
 * The library is videos AND clips in one list, exactly like the desktop app's
 * sidebar: an exported clip lands in the media folder and gets indexed
 * alongside its source, marked with the scissors glyph.
 *
 * Keeping them in separate tables but merging here is deliberate — a clip has
 * a dozen render columns (crf, preset, fades, crop offsets) that a source
 * video has no use for, and a source video has probe columns a clip inherits
 * rather than owns. One table would mean half the columns are null for half
 * the rows.
 */
export async function GET() {
  const db = supabaseAdmin();

  const [videosRes, clipsRes] = await Promise.all([
    db
      .from("videos")
      .select("id, title, duration_seconds, uploader, channel, status, created_at")
      // Mirrors database.scan_dir skipping ".part" files: a row whose bytes are
      // still arriving is not in the library yet. The queue is where in-flight
      // work is visible; showing it here too would offer an unplayable row.
      .neq("status", "uploading")
      .order("created_at", { ascending: false }),
    db
      .from("clips")
      .select("id, title, duration_seconds, status, created_at, video_id, aspect_mode")
      .eq("status", "ready")
      .order("created_at", { ascending: false }),
  ]);

  if (videosRes.error) {
    return NextResponse.json({ error: videosRes.error.message }, { status: 500 });
  }
  if (clipsRes.error) {
    return NextResponse.json({ error: clipsRes.error.message }, { status: 500 });
  }

  const clips = clipsRes.data ?? [];

  // One query for every clip's share token rather than one per clip — the
  // share link is the whole point of an exported clip, so it belongs in the
  // list payload, not behind another round trip per row.
  const tokensByClip = new Map<string, string>();
  if (clips.length > 0) {
    const { data: tokens } = await db
      .from("share_tokens")
      .select("token, clip_id")
      .in(
        "clip_id",
        clips.map((c) => c.id),
      )
      .is("revoked_at", null);
    for (const t of tokens ?? []) {
      if (!tokensByClip.has(t.clip_id)) tokensByClip.set(t.clip_id, t.token);
    }
  }

  const rows = [
    ...(videosRes.data ?? []).map((v) => ({
      id: v.id,
      kind: "video" as const,
      title: v.title,
      duration_seconds: v.duration_seconds,
      uploader: v.uploader,
      channel: v.channel,
      status: v.status,
      created_at: v.created_at,
      is_clip: false,
      share_token: null as string | null,
    })),
    ...clips.map((c) => ({
      id: c.id,
      kind: "clip" as const,
      title: c.title || "Untitled clip",
      duration_seconds: c.duration_seconds,
      uploader: "",
      channel: "",
      status: c.status,
      created_at: c.created_at,
      is_clip: true,
      share_token: tokensByClip.get(c.id) ?? null,
    })),
  ].sort((a, b) => b.created_at.localeCompare(a.created_at));

  return NextResponse.json({ rows });
}
