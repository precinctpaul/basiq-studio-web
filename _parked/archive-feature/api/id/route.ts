import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

/**
 * Must match the agent's own MEDIA_ROOT (.env.local) exactly, not just the
 * shared LucidLink drive tools/archive_consolidation/config.py calls
 * LUCID_ROOT -- the agent's /media/* proxy (basiq_agent.py safe_media_path)
 * is chrooted to this narrower folder, so a file under the wider drive but
 * outside this subfolder (e.g. still sitting in "Eluvio POC") would get a
 * relative_path here and then 404 from the agent, which is worse than no
 * play link at all. The archive scan also swept several LOCAL-ONLY dev
 * folders on the machine that built this index (cspan_discovery,
 * transcriptor, etc.); files under those correctly get no play link either,
 * since nothing can reach them.
 */
const MEDIA_ROOT = "c:/volumes/md-pac/media/archive/basiq-studio-hub";

function relativeMediaPath(fullPath: string): string | null {
  const normalized = fullPath.replace(/\\/g, "/");
  if (!normalized.toLowerCase().startsWith(MEDIA_ROOT)) return null;
  return normalized.slice(MEDIA_ROOT.length).replace(/^\/+/, "");
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const db = supabaseAdmin();

    // Concatenated (not a single literal) on purpose for readability --
    // supabase-js's embedded-relation type inference needs a literal select
    // string to parse at compile time, which a concatenated one defeats, so
    // this is cast to `any` rather than fighting that inference.
    const { data: item, error } = (await db
      .from("archive_items")
      .select(
        "id, title, description, publish_date, date_source, duration_seconds, source_platform, " +
          "source_url, is_institutional, video_completeness, transcript_status, transcript_source, " +
          "person_match_source, notes, " +
          "people(id, full_name, chamber, state, party, identifier_type, bioguide_id)"
      )
      .eq("id", id)
      .maybeSingle()) as any;
    if (error) throw new Error(`Archive item fetch failed: ${error.message}`);
    if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const [filesRes, tagsRes, legRes, transcriptRes] = await Promise.all([
      db
        .from("archive_item_files")
        .select("full_path, role, extension, size_mb, quality_guess, last_write_time")
        .eq("archive_item_id", id),
      db.from("archive_item_tags").select("label, kind, source").eq("archive_item_id", id),
      db
        .from("archive_item_legislation")
        .select("legislation(congress, bill_type, bill_number, title, display)")
        .eq("archive_item_id", id),
      db.from("archive_item_transcripts").select("full_text, source").eq("archive_item_id", id).maybeSingle(),
    ]);
    if (filesRes.error) throw new Error(`Files fetch failed: ${filesRes.error.message}`);
    if (tagsRes.error) throw new Error(`Tags fetch failed: ${tagsRes.error.message}`);
    if (legRes.error) throw new Error(`Legislation fetch failed: ${legRes.error.message}`);
    if (transcriptRes.error) throw new Error(`Transcript fetch failed: ${transcriptRes.error.message}`);

    const files = (filesRes.data ?? []).map((f: any) => ({
      role: f.role,
      extension: f.extension,
      size_mb: f.size_mb,
      quality_guess: f.quality_guess,
      last_write_time: f.last_write_time,
      relative_path: relativeMediaPath(f.full_path),
    }));

    const videoWriteTimes = files
      .filter((f) => f.role === "video" && f.last_write_time)
      .map((f) => f.last_write_time as string)
      .sort();
    const captureDate = videoWriteTimes[0] ?? null;

    return NextResponse.json({
      item: {
        id: item.id,
        title: item.title,
        description: item.description,
        publish_date: item.publish_date,
        date_source: item.date_source,
        duration_seconds: item.duration_seconds,
        source_platform: item.source_platform,
        source_url: item.source_url,
        is_institutional: item.is_institutional,
        video_completeness: item.video_completeness,
        transcript_status: item.transcript_status,
        transcript_source: item.transcript_source,
        person_match_source: item.person_match_source,
        notes: item.notes,
        person: (item as any).people ?? null,
        capture_date: captureDate,
        transcript_text: transcriptRes.data?.full_text || null,
      },
      files,
      tags: (tagsRes.data ?? []).map((t) => ({ label: t.label, kind: t.kind, source: t.source })),
      legislation: (legRes.data ?? []).map((l: any) => l.legislation).filter(Boolean),
    });
  } catch (error: any) {
    console.error("[API/Archive/Detail] Fatal Error:", error);
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}
