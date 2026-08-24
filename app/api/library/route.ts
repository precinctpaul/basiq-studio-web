import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { isMissingTable } from "@/lib/supabase-errors";

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
  try {
    const db = supabaseAdmin();

    const [videosRes, clipsRes] = await Promise.all([
      db
        .from("videos")
        .select("id, title, duration_seconds, uploader, channel, status, created_at, local_path")
        // Mirrors database.scan_dir skipping ".part" files: a row whose bytes are
        // still arriving is not in the library yet. The queue is where in-flight
        // work is visible; showing it here too would offer an unplayable row.
        .neq("status", "uploading")
        .order("created_at", { ascending: false })
        .limit(100), // ADD THIS LINE
      db
        .from("clips")
        .select("id, title, duration_seconds, status, created_at, video_id, aspect_mode, local_path")
        .eq("status", "ready")
        .order("created_at", { ascending: false })
        .limit(100) // ADD THIS LINE
    ]);

    if (videosRes.error) {
      throw new Error(`Videos fetch failed: ${videosRes.error.message}`);
    }
    if (clipsRes.error) {
      throw new Error(`Clips fetch failed: ${clipsRes.error.message}`);
    }

    const clips = clipsRes.data ?? [];
    const videos = videosRes.data ?? [];

    // Every video's tags in one query rather than one per row — the library
    // list is the surface that has to search over them, so they travel with it.
    const tagsByVideo = new Map<string, Array<{ label: string; source: string; kind: string | null }>>();
    if (videos.length > 0) {
      // Tolerates the tags table not existing yet (migration 0004 unrun): the
      // library is the app's primary surface and must not 500 because an
      // additive feature hasn't been migrated in.
      // Fetching without .in() prevents URL query length overflow when library exceeds ~200 items.
      const { data: tags, error: tagError } = await db
        .from("tags")
        .select("video_id, label, source, kind");
      
      if (tagError && !isMissingTable(tagError)) {
        throw new Error(`Tags fetch failed: ${tagError.message}`);
      }
      
      for (const t of tags ?? []) {
        const list = tagsByVideo.get(t.video_id) ?? [];
        list.push({ label: t.label, source: t.source, kind: t.kind });
        tagsByVideo.set(t.video_id, list);
      }
      
      // Manual first so an operator's own tags lead the chip row and the
      // search-match preview.
      for (const list of tagsByVideo.values()) {
        list.sort((a, b) => (a.source === b.source ? a.label.localeCompare(b.label) : a.source === "manual" ? -1 : 1));
      }
    }

    // One query for every clip's share token rather than one per clip — the
    // share link is the whole point of an exported clip, so it belongs in the
    // list payload, not behind another round trip per row.
    const tokensByClip = new Map<string, string>();
    if (clips.length > 0) {
      // Fetching without .in() prevents URL query length overflow when library grows large.
      const { data: tokens, error: tokenError } = await db
        .from("share_tokens")
        .select("token, clip_id")
        .is("revoked_at", null);
      
      if (tokenError) {
        throw new Error(`Tokens fetch failed: ${tokenError.message}`);
      }
      
      for (const t of tokens ?? []) {
        if (!tokensByClip.has(t.clip_id)) tokensByClip.set(t.clip_id, t.token);
      }
    }

    const rows = [
      ...videos.map((v) => ({
        id: v.id,
        kind: "video" as const,
        title: v.title || "Untitled",
        duration_seconds: v.duration_seconds ?? 0,
        uploader: v.uploader || "",
        channel: v.channel || "",
        status: v.status || "",
        created_at: v.created_at || new Date().toISOString(),
        is_clip: false,
        // Lets a just-filed grab find its own row exactly, rather than guessing
        // by title — the filename is sanitised and may carry a " (2)" suffix.
        local_path: v.local_path ?? null,
        share_token: null as string | null,
        tags: tagsByVideo.get(v.id) ?? [],
        probed: (v.duration_seconds ?? 0) > 0,
      })),
      ...clips.map((c) => ({
        id: c.id,
        kind: "clip" as const,
        title: c.title || "Untitled clip",
        duration_seconds: c.duration_seconds ?? 0,
        uploader: "",
        channel: "",
        status: c.status || "",
        created_at: c.created_at || new Date().toISOString(),
        is_clip: true,
        local_path: c.local_path ?? null,
        share_token: tokensByClip.get(c.id) ?? null,
        // A clip inherits its source's subject matter; tags live on the video.
        tags: tagsByVideo.get(c.video_id) ?? [],
        probed: (c.duration_seconds ?? 0) > 0,
      })),
    ].sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));

    return NextResponse.json({ rows });

  } catch (error: any) {
    console.error("[API/Library] Fatal Error:", error);
    return NextResponse.json(
      { error: error.message || "Internal Server Error" }, 
      { status: 500 }
    );
  }
}