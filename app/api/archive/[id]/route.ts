import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

/**
 * Same shared drive tools/archive_consolidation/config.py calls LUCID_ROOT
 * and basiq_agent.py mounts as MEDIA_ROOT -- a file under here is reachable
 * through the agent's /media/* proxy from any machine (or the droplet). The
 * archive scan also swept several LOCAL-ONLY dev folders on the machine
 * that built this index (cspan_discovery, transcriptor, etc.); files under
 * those get no play link at all rather than a broken one, since nothing
 * else can actually reach them.
 */
const MEDIA_ROOT = "c:/volumes/md-pac/media";

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

    const [filesRes, tagsRes, legRes] = await Promise.all([
      db
        .from("archive_item_files")
        .select("full_path, role, extension, size_mb, quality_guess")
        .eq("archive_item_id", id),
      db.from("archive_item_tags").select("label, kind, source").eq("archive_item_id", id),
      db
        .from("archive_item_legislation")
        .select("legislation(congress, bill_type, bill_number, title, display)")
        .eq("archive_item_id", id),
    ]);
    if (filesRes.error) throw new Error(`Files fetch failed: ${filesRes.error.message}`);
    if (tagsRes.error) throw new Error(`Tags fetch failed: ${tagsRes.error.message}`);
    if (legRes.error) throw new Error(`Legislation fetch failed: ${legRes.error.message}`);

    const files = (filesRes.data ?? []).map((f: any) => ({
      role: f.role,
      extension: f.extension,
      size_mb: f.size_mb,
      quality_guess: f.quality_guess,
      relative_path: relativeMediaPath(f.full_path),
    }));

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
