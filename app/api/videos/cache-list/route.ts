import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

export interface TranscriptInfo {
  status: string; // 'pending' | 'running' | 'ready' | 'failed'
  source: string; // 'whisper-local' | 'imported-srt' | 'imported-vtt'
  model: string;
  language: string;
}

export interface CachedVideoRow {
  id: string;
  title: string;
  local_path: string | null;
  storage_path: string | null;
  duration_seconds: number;
  size_bytes: number;
  status: string;
  error: string;
  uploader: string;
  channel: string;
  created_at: string;
  transcript: TranscriptInfo | null;
}

interface Cache {
  videos: CachedVideoRow[];
  cachedAt: string;
  mediaRoot: string;
}

// Module-level -- survives across requests as long as the Next.js server
// process stays up, and is wiped only by a restart or an explicit refresh.
// This is what turns "list all 11k videos" from a ~1.5MB Supabase read on
// every page load into one read per manual refresh -- the archive only
// grows, so a stale list is never wrong, just possibly missing the newest
// rows until someone clicks refresh.
let cache: Cache | null = null;

const PAGE_SIZE = 1000;

async function loadAllRows<T>(
  table: string,
  columns: string,
  orderBy: string,
): Promise<T[]> {
  const db = supabaseAdmin();
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from(table)
      .select(columns)
      .order(orderBy, { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...(data as T[]));
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return out;
}

interface RawVideoRow {
  id: string;
  title: string;
  local_path: string | null;
  storage_path: string | null;
  duration_seconds: number;
  size_bytes: number;
  status: string;
  error: string;
  uploader: string;
  channel: string;
  created_at: string;
}

interface RawTranscriptRow {
  video_id: string;
  status: string;
  source: string;
  model: string;
  language: string;
}

async function loadAllVideos(): Promise<CachedVideoRow[]> {
  const [videos, transcripts] = await Promise.all([
    loadAllRows<RawVideoRow>(
      "videos",
      "id, title, local_path, storage_path, duration_seconds, size_bytes, status, error, uploader, channel, created_at",
      "created_at",
    ),
    loadAllRows<RawTranscriptRow>("transcripts", "video_id, status, source, model, language", "created_at"),
  ]);

  const byVideoId = new Map<string, TranscriptInfo>();
  for (const t of transcripts) {
    byVideoId.set(t.video_id, { status: t.status, source: t.source, model: t.model, language: t.language });
  }

  return videos.map((v) => ({ ...v, transcript: byVideoId.get(v.id) ?? null }));
}

/** GET ?refresh=1 forces a fresh Supabase read; otherwise serves the
 *  in-memory cache, building it on first request. */
export async function GET(req: NextRequest) {
  const forceRefresh = req.nextUrl.searchParams.get("refresh") === "1";

  if (!cache || forceRefresh) {
    try {
      const videos = await loadAllVideos();
      cache = { videos, cachedAt: new Date().toISOString(), mediaRoot: process.env.MEDIA_ROOT || "" };
    } catch (err) {
      if (cache) {
        // Serve the stale cache rather than an error page if a refresh
        // attempt fails but we already had something to show.
        return NextResponse.json({ ...cache, refreshError: (err as Error).message });
      }
      return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
  }

  return NextResponse.json(cache);
}
