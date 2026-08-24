import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { isMissingTable } from "@/lib/supabase-errors";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get("page") || "0", 10);
    const pageSize = Math.min(parseInt(searchParams.get("limit") || "500", 10), 1000);
    const search = (searchParams.get("search") || "").trim().replace(/[,()]/g, "");
    
    const from = page * pageSize;
    const to = from + pageSize - 1;

    const db = supabaseAdmin();

    let videosQuery = db
      .from("videos")
      .select("id, title, duration_seconds, uploader, channel, status, created_at, local_path, upload_date", { count: "exact" })
      .neq("status", "uploading");

    let clipsQuery = db
      .from("clips")
      .select("id, title, duration_seconds, status, created_at, video_id, aspect_mode, local_path", { count: "exact" })
      .eq("status", "ready");

    if (search) {
      videosQuery = videosQuery.or(`title.ilike.%${search}%,uploader.ilike.%${search}%,channel.ilike.%${search}%`);
      clipsQuery = clipsQuery.ilike("title", `%${search}%`);
    }

    const [videosRes, clipsRes] = await Promise.all([
      videosQuery.order("created_at", { ascending: false }).range(from, to),
      clipsQuery.order("created_at", { ascending: false }).range(from, to),
    ]);

    if (videosRes.error) {
      throw new Error(`Videos fetch failed: ${videosRes.error.message}`);
    }
    if (clipsRes.error) {
      throw new Error(`Clips fetch failed: ${clipsRes.error.message}`);
    }

    const videos = videosRes.data ?? [];
    const clips = clipsRes.data ?? [];
    const totalVideos = videosRes.count ?? 0;
    const totalClips = clipsRes.count ?? 0;

    const videoIdsOnPage = [
      ...videos.map((v) => v.id),
      ...clips.map((c) => c.video_id),
    ];

    const tagsByVideo = new Map<
      string,
      Array<{ label: string; source: string; kind: string | null }>
    >();

    if (videoIdsOnPage.length > 0) {
      const { data: tags, error: tagError } = await db
        .from("tags")
        .select("video_id, label, source, kind")
        .in("video_id", videoIdsOnPage);

      if (tagError && !isMissingTable(tagError)) {
        throw new Error(`Tags fetch failed: ${tagError.message}`);
      }

      for (const t of tags ?? []) {
        const list = tagsByVideo.get(t.video_id) ?? [];
        list.push({ label: t.label, source: t.source, kind: t.kind });
        tagsByVideo.set(t.video_id, list);
      }

      for (const list of tagsByVideo.values()) {
        list.sort((a, b) =>
          a.source === b.source
            ? a.label.localeCompare(b.label)
            : a.source === "manual"
            ? -1
            : 1
        );
      }
    }

    const tokensByClip = new Map<string, string>();
    const clipIdsOnPage = clips.map((c) => c.id);

    if (clipIdsOnPage.length > 0) {
      const { data: tokens, error: tokenError } = await db
        .from("share_tokens")
        .select("token, clip_id")
        .in("clip_id", clipIdsOnPage)
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
        tags: tagsByVideo.get(c.video_id) ?? [],
        probed: (c.duration_seconds ?? 0) > 0,
      })),
    ].sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));

    return NextResponse.json({
      rows,
      pagination: {
        page,
        pageSize,
        totalVideos,
        totalClips,
        totalCombined: totalVideos + totalClips,
        hasMore: from + pageSize < Math.max(totalVideos, totalClips),
      },
    });
  } catch (error: any) {
    console.error("[API/Library] Fatal Error:", error);
    return NextResponse.json(
      { error: error.message || "Internal Server Error" },
      { status: 500 }
    );
  }
}