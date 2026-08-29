import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

/**
 * Read-only browse/search over the archive-consolidation schema
 * (supabase/migrations/0007_archive_consolidation.sql + 0008), separate
 * from /api/library's videos/clips/tags. That schema resolved person,
 * date, and tag metadata for ~9k historical items the live agent never
 * touched -- this just exposes it, it doesn't write anything.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get("page") || "0", 10);
    const pageSize = Math.min(parseInt(searchParams.get("limit") || "50", 10), 200);
    const search = (searchParams.get("search") || "").trim().replace(/[,()]/g, "");
    const personId = (searchParams.get("person") || "").trim();
    const tag = (searchParams.get("tag") || "").trim();
    const institutionalOnly = searchParams.get("institutional") === "1";

    const from = page * pageSize;
    const to = from + pageSize - 1;

    const db = supabaseAdmin();

    // Tag filter has to resolve to a set of item ids first -- archive_items
    // itself has no tag column to filter on directly.
    let tagItemIds: string[] | null = null;
    if (tag) {
      const { data, error } = await db
        .from("archive_item_tags")
        .select("archive_item_id")
        .eq("label", tag);
      if (error) throw new Error(`Tag filter failed: ${error.message}`);
      tagItemIds = (data ?? []).map((r) => r.archive_item_id);
      if (tagItemIds.length === 0) {
        return NextResponse.json({
          rows: [],
          pagination: { page, pageSize, total: 0, hasMore: false },
        });
      }
    }

    let query = db
      .from("archive_items")
      .select(
        "id, title, publish_date, duration_seconds, source_platform, is_institutional, " +
          "video_completeness, transcript_status, primary_person_id, " +
          "people(id, full_name, chamber, state)",
        { count: "exact" }
      );

    if (search) query = query.textSearch("search_tsv", search, { type: "websearch" });
    if (personId) query = query.eq("primary_person_id", personId);
    if (institutionalOnly) query = query.eq("is_institutional", true);
    if (tagItemIds) query = query.in("id", tagItemIds);

    query = query.order("publish_date", { ascending: false, nullsFirst: false }).range(from, to);

    const { data, error, count } = await query;
    if (error) throw new Error(`Archive query failed: ${error.message}`);

    const items = data ?? [];
    const ids = items.map((it: any) => it.id);

    const tagsByItem = new Map<string, string[]>();
    if (ids.length > 0) {
      const { data: tagRows, error: tagErr } = await db
        .from("archive_item_tags")
        .select("archive_item_id, label")
        .in("archive_item_id", ids);
      if (tagErr) throw new Error(`Tags fetch failed: ${tagErr.message}`);
      for (const t of tagRows ?? []) {
        const list = tagsByItem.get(t.archive_item_id) ?? [];
        list.push(t.label);
        tagsByItem.set(t.archive_item_id, list);
      }
    }

    const rows = items.map((it: any) => ({
      id: it.id,
      title: it.title || "Untitled",
      publish_date: it.publish_date,
      duration_seconds: it.duration_seconds,
      source_platform: it.source_platform,
      is_institutional: it.is_institutional,
      video_completeness: it.video_completeness,
      transcript_status: it.transcript_status,
      person: it.people
        ? { id: it.people.id, full_name: it.people.full_name, chamber: it.people.chamber, state: it.people.state }
        : null,
      tags: (tagsByItem.get(it.id) ?? []).sort(),
    }));

    const total = count ?? 0;
    return NextResponse.json({
      rows,
      pagination: { page, pageSize, total, hasMore: from + pageSize < total },
    });
  } catch (error: any) {
    console.error("[API/Archive] Fatal Error:", error);
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}
