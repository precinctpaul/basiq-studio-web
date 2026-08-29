import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

async function fetchAll<T>(db: ReturnType<typeof supabaseAdmin>, table: string, cols: string): Promise<T[]> {
  const out: T[] = [];
  let page = 0;
  for (;;) {
    const { data, error } = await db.from(table).select(cols).range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`${table} fetch failed: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
    page += 1;
  }
  return out;
}

/**
 * Tag filter data for the archive view: the most common tags, with counts.
 * Person/institutional/uncategorized navigation moved to /api/archive/
 * buckets, which drives the explorer -- this stays focused on tags. The
 * source table is small enough (~2k rows) that pulling it whole and
 * counting in JS is simpler than PostgREST's embedded-count syntax, and it
 * doesn't need to be fast -- this loads once per page visit.
 */
export async function GET() {
  try {
    const db = supabaseAdmin();

    const tagRows = await fetchAll<{ label: string }>(db, "archive_item_tags", "label");

    const tagCounts = new Map<string, number>();
    for (const t of tagRows) {
      tagCounts.set(t.label, (tagCounts.get(t.label) ?? 0) + 1);
    }
    const tagsFacet = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 60)
      .map(([label, count]) => ({ label, count }));

    return NextResponse.json({ tags: tagsFacet });
  } catch (error: any) {
    console.error("[API/Archive/Facets] Fatal Error:", error);
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}
