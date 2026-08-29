import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { MAJORITY_DEMOCRATS, THE_BENCH } from "@/lib/archiveBuckets";

export const runtime = "nodejs";

const SNIPPET_RADIUS = 160;

/** Best-effort snippet around the first hit of `term` in `text` -- a plain
 *  case-insensitive substring search, not the same ranking websearch's
 *  tsquery uses, but close enough to show WHY a result matched. Falls back
 *  to the first word of a multi-word query if the full phrase never
 *  appears verbatim (stemming can match "voting" to a query for "vote"). */
function extractSnippet(text: string, term: string): { snippet: string; matchStart: number; matchLength: number } | null {
  if (!text) return null;
  const candidates = [term, ...term.split(/\s+/)].filter(Boolean);
  for (const candidate of candidates) {
    const idx = text.toLowerCase().indexOf(candidate.toLowerCase());
    if (idx === -1) continue;
    const start = Math.max(0, idx - SNIPPET_RADIUS);
    const end = Math.min(text.length, idx + candidate.length + SNIPPET_RADIUS);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < text.length ? "…" : "";
    return {
      snippet: prefix + text.slice(start, end).trim() + suffix,
      matchStart: idx - start + prefix.length,
      matchLength: candidate.length,
    };
  }
  return null;
}

/**
 * Read-only browse/search over the archive-consolidation schema
 * (supabase/migrations/0007_archive_consolidation.sql + 0008), separate
 * from /api/library's videos/clips/tags. That schema resolved person,
 * date, and tag metadata for ~9k historical items the live agent never
 * touched -- this just exposes it, it doesn't write anything.
 *
 * bucket param drives the explorer (mirrors /api/library's bucket/person
 * split): "Institutional", "Uncategorized", a chamber name ("House" /
 * "Senate"), or "Notable Figures". person is a people.id, used either
 * alone or combined with bucket to scope a chamber's person list.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get("page") || "0", 10);
    const pageSize = Math.min(parseInt(searchParams.get("limit") || "50", 10), 200);
    const search = (searchParams.get("search") || "").trim().replace(/[,()]/g, "");
    const personId = (searchParams.get("person") || "").trim();
    const tag = (searchParams.get("tag") || "").trim();
    const bucket = (searchParams.get("bucket") || "").trim();

    const from = page * pageSize;
    const to = from + pageSize - 1;

    const db = supabaseAdmin();

    // Tag and search both have to resolve to an explicit id set first --
    // archive_items has no tag column, and a search term matches transcript
    // CONTENT as well as title, which lives in a different table. Resolving
    // both to plain id sets and intersecting them in JS lets the actual page
    // query stay a single .in() plus simple .eq()/.is() filters, all of
    // which compose as a normal AND -- unlike an .or() clause, which
    // supabase-js can't safely combine with a second, independent .or().
    let tagItemIds: Set<string> | null = null;
    if (tag) {
      const { data, error } = await db
        .from("archive_item_tags")
        .select("archive_item_id")
        .eq("label", tag);
      if (error) throw new Error(`Tag filter failed: ${error.message}`);
      tagItemIds = new Set((data ?? []).map((r) => r.archive_item_id));
    }

    let searchItemIds: Set<string> | null = null;
    if (search) {
      // Plain substring match, not textSearch()'s stemmed tsquery -- English
      // stemming collapsed "helene" and "helen" to the same lexeme, so a
      // search for Hurricane Helene was returning transcripts that only
      // mention someone named Helen. A newsroom typing an exact term wants
      // that exact term, not "close enough after stemming".
      const [titleRes, transcriptRes] = await Promise.all([
        db.from("archive_items").select("id").ilike("title", `%${search}%`),
        db.from("archive_item_transcripts").select("archive_item_id").ilike("full_text", `%${search}%`),
      ]);
      if (titleRes.error) throw new Error(`Title search failed: ${titleRes.error.message}`);
      if (transcriptRes.error) {
        console.error("[API/Archive] Transcript search failed (non-fatal):", transcriptRes.error.message);
      }
      searchItemIds = new Set([
        ...(titleRes.data ?? []).map((r) => r.id),
        ...(transcriptRes.data ?? []).map((r) => r.archive_item_id),
      ]);
    }

    let requiredIds: string[] | null = null;
    if (tagItemIds && searchItemIds) {
      requiredIds = [...tagItemIds].filter((id) => searchItemIds!.has(id));
    } else if (tagItemIds) {
      requiredIds = [...tagItemIds];
    } else if (searchItemIds) {
      requiredIds = [...searchItemIds];
    }
    if (requiredIds && requiredIds.length === 0) {
      return NextResponse.json({ rows: [], pagination: { page, pageSize, total: 0, hasMore: false } });
    }

    let query = db
      .from("archive_items")
      .select(
        "id, title, publish_date, duration_seconds, source_platform, is_institutional, " +
          "video_completeness, transcript_status, source_url, primary_person_id, " +
          "people(id, full_name, chamber, state, identifier_type)",
        { count: "exact" }
      );

    if (personId) {
      query = query.eq("primary_person_id", personId);
    } else if (bucket === "Institutional") {
      // Matches /api/archive/buckets' definition: institutional AND no
      // specific person attached, so this folder and every person folder
      // stay mutually exclusive (an item with both is filed under its person).
      query = query.is("primary_person_id", null).eq("is_institutional", true);
    } else if (bucket === "Uncategorized") {
      query = query.is("primary_person_id", null).eq("is_institutional", false);
    } else if (bucket === "Majority Democrats" || bucket === "The Bench") {
      const roster = bucket === "Majority Democrats" ? MAJORITY_DEMOCRATS : THE_BENCH;
      const { data: rosterPeople, error: rosterErr } = await db
        .from("people")
        .select("id")
        .in("full_name", [...roster]);
      if (rosterErr) throw new Error(`Roster lookup failed: ${rosterErr.message}`);
      query = query.in("primary_person_id", (rosterPeople ?? []).map((p) => p.id));
    }
    // bucket = a chamber name or "Notable Figures" is purely a UI grouping
    // for picking a person from the explorer -- once a person is chosen,
    // `person` already scopes the query; the bare chamber/group view itself
    // never lists items directly (see the panel's explorer levels).

    if (requiredIds) query = query.in("id", requiredIds);

    query = query.order("publish_date", { ascending: false, nullsFirst: false }).range(from, to);

    const { data, error, count } = await query;
    if (error) throw new Error(`Archive query failed: ${error.message}`);

    const items = data ?? [];
    const ids = items.map((it: any) => it.id);

    const [tagsRes, filesRes, transcriptTextRes] = await Promise.all([
      ids.length > 0
        ? db.from("archive_item_tags").select("archive_item_id, label").in("archive_item_id", ids)
        : Promise.resolve({ data: [], error: null }),
      ids.length > 0
        ? db
            .from("archive_item_files")
            .select("archive_item_id, role, last_write_time")
            .eq("role", "video")
            .in("archive_item_id", ids)
        : Promise.resolve({ data: [], error: null }),
      // Only needed to build a "why this matched" snippet -- skip the
      // (potentially large) full_text fetch entirely outside of search.
      search && ids.length > 0
        ? db.from("archive_item_transcripts").select("archive_item_id, full_text").in("archive_item_id", ids)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (tagsRes.error) throw new Error(`Tags fetch failed: ${tagsRes.error.message}`);
    if (filesRes.error) throw new Error(`Files fetch failed: ${filesRes.error.message}`);
    if (transcriptTextRes.error) throw new Error(`Transcript text fetch failed: ${transcriptTextRes.error.message}`);

    const transcriptTextByItem = new Map<string, string>();
    for (const t of transcriptTextRes.data ?? []) {
      transcriptTextByItem.set(t.archive_item_id, t.full_text);
    }

    const tagsByItem = new Map<string, string[]>();
    for (const t of tagsRes.data ?? []) {
      const list = tagsByItem.get(t.archive_item_id) ?? [];
      list.push(t.label);
      tagsByItem.set(t.archive_item_id, list);
    }
    const captureDateByItem = new Map<string, string | null>();
    for (const f of filesRes.data ?? []) {
      const existing = captureDateByItem.get(f.archive_item_id);
      if (!existing || (f.last_write_time && f.last_write_time < existing)) {
        captureDateByItem.set(f.archive_item_id, f.last_write_time);
      }
    }

    const rows = items.map((it: any) => ({
      id: it.id,
      title: it.title || "Untitled",
      publish_date: it.publish_date,
      duration_seconds: it.duration_seconds,
      source_platform: it.source_platform,
      source_url: it.source_url,
      is_institutional: it.is_institutional,
      video_completeness: it.video_completeness,
      transcript_status: it.transcript_status,
      capture_date: captureDateByItem.get(it.id) ?? null,
      person: it.people
        ? { id: it.people.id, full_name: it.people.full_name, chamber: it.people.chamber, state: it.people.state }
        : null,
      tags: (tagsByItem.get(it.id) ?? []).sort(),
      snippet: search ? extractSnippet(transcriptTextByItem.get(it.id) || "", search) : null,
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
