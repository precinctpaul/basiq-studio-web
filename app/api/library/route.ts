import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { isMissingTable } from "@/lib/supabase-errors";

export const runtime = "nodejs";

/**
 * Some Supabase calls fail with a bare `TypeError: fetch failed` — a dropped
 * TCP connection or DNS hiccup, not a real database error. There is no error
 * code to check because the request never got an HTTP response at all. This
 * retries a couple of times before giving up, so a one-off network blip
 * doesn't take down the whole library page the way it did on 2026-08-24.
 */
function isTransientNetworkError(error: { message?: string } | null | undefined): boolean {
  if (!error) return false;
  const m = (error.message || "").toLowerCase();
  return (
    m.includes("fetch failed") ||
    m.includes("econnreset") ||
    m.includes("etimedout") ||
    m.includes("enotfound") ||
    m.includes("network") ||
    m.includes("socket hang up")
  );
}

/**
 * videos and clips are paginated with the same page/offset, but they don't
 * have the same row count — one table runs out before the other. Asking a
 * table for rows past its own end isn't "empty" to PostgREST, it's an
 * invalid range (HTTP 416 / code PGRST103). That's not a real error, it
 * just means "nothing left in this particular table" — the other table may
 * still have more on the same page.
 */
function isRangeNotSatisfiable(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "PGRST103") return true;
  return (error.message || "").toLowerCase().includes("requested range not satisfiable");
}

async function withRetry<T extends { error: any }>(
  build: () => PromiseLike<T>,
  attempts = 3,
  delayMs = 300
): Promise<T> {
  let result: T;
  for (let i = 0; i < attempts; i++) {
    result = await build();
    if (!result.error || !isTransientNetworkError(result.error)) return result;
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  return result!;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get("page") || "0", 10);
    const pageSize = Math.min(parseInt(searchParams.get("limit") || "500", 10), 1000);
    const search = (searchParams.get("search") || "").trim().replace(/[,()]/g, "");
    const bucket = (searchParams.get("bucket") || "").trim();
    const person = (searchParams.get("person") || "").trim();

    const from = page * pageSize;
    const to = from + pageSize - 1;

    const db = supabaseAdmin();

    const videosSource = person
      ? { table: "videos_by_person", col: "person_label", val: person }
      : bucket === "Uncategorized"
      ? { table: "uncategorized_videos", col: null as string | null, val: null as string | null }
      : bucket
      ? { table: "videos_by_bucket", col: "bucket_label", val: bucket }
      : { table: "videos", col: null as string | null, val: null as string | null };

    const clipsSource = person
      ? { table: "clips_by_person", col: "person_label", val: person }
      : bucket === "Uncategorized"
      ? { table: "uncategorized_clips", col: null as string | null, val: null as string | null }
      : bucket
      ? { table: "clips_by_bucket", col: "bucket_label", val: bucket }
      : { table: "clips", col: null as string | null, val: null as string | null };

    const buildVideosQuery = () => {
      let q = db
        .from(videosSource.table)
        .select("id, title, duration_seconds, uploader, channel, status, created_at, local_path", { count: "exact" })
        .neq("status", "uploading");
      if (videosSource.col) q = q.eq(videosSource.col, videosSource.val as string);
      if (search) {
        q = q.or(`title.ilike.%${search}%,uploader.ilike.%${search}%,channel.ilike.%${search}%`);
      }
      return q.order("created_at", { ascending: false }).range(from, to);
    };

    const buildClipsQuery = () => {
      let q = db
        .from(clipsSource.table)
        .select("id, title, duration_seconds, status, created_at, video_id, local_path", { count: "exact" })
        .eq("status", "ready");
      if (clipsSource.col) q = q.eq(clipsSource.col, clipsSource.val as string);
      if (search) {
        q = q.ilike("title", `%${search}%`);
      }
      return q.order("created_at", { ascending: false }).range(from, to);
    };

    const [videosRes, clipsRes] = await Promise.all([
      withRetry(buildVideosQuery),
      withRetry(buildClipsQuery),
    ]);

    if (videosRes.error && !isRangeNotSatisfiable(videosRes.error)) {
      throw new Error(`Videos fetch failed: ${videosRes.error.message}`);
    }
    if (clipsRes.error && !isRangeNotSatisfiable(clipsRes.error)) {
      throw new Error(`Clips fetch failed: ${clipsRes.error.message}`);
    }

    const videos = videosRes.error ? [] : videosRes.data ?? [];
    const clips = clipsRes.error ? [] : clipsRes.data ?? [];
    const totalVideos = videosRes.count ?? 0;
    const totalClips = clipsRes.count ?? 0;

    const videoIdsOnPage = Array.from(
      new Set([
        ...videos.map((v) => v.id),
        ...clips.map((c) => c.video_id),
      ])
    ).filter((id): id is string => Boolean(id));

    const tagsByVideo = new Map<
      string,
      Array<{ label: string; source: string; kind: string | null }>
    >();

    if (videoIdsOnPage.length > 0) {
      const { data: tags, error: tagError } = await withRetry(() =>
        db.from("tags").select("video_id, label, source, kind").in("video_id", videoIdsOnPage)
      );

      if (tagError && !isMissingTable(tagError) && !isTransientNetworkError(tagError)) {
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
    const clipIdsOnPage = clips.map((c) => c.id).filter((id): id is string => Boolean(id));

    if (clipIdsOnPage.length > 0) {
      const { data: tokens, error: tokenError } = await withRetry(() =>
        db
          .from("share_tokens")
          .select("token, clip_id")
          .in("clip_id", clipIdsOnPage)
          .is("revoked_at", null)
      );

      if (tokenError && !isTransientNetworkError(tokenError)) {
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
