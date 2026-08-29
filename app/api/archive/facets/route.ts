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
 * Filter sidebar data for the archive view: every person with at least one
 * item (plus their item count) and the most common tags. Both source tables
 * are small enough (~9k items, ~2k tags) that pulling them whole and
 * counting in JS is simpler than leaning on PostgREST's embedded-count
 * syntax, and it doesn't need to be fast -- this loads once per page visit.
 */
export async function GET() {
  try {
    const db = supabaseAdmin();

    const [items, tagRows, people] = await Promise.all([
      fetchAll<{ primary_person_id: string | null; is_institutional: boolean }>(
        db,
        "archive_items",
        "primary_person_id, is_institutional"
      ),
      fetchAll<{ label: string }>(db, "archive_item_tags", "label"),
      fetchAll<{ id: string; full_name: string; chamber: string | null; state: string | null }>(
        db,
        "people",
        "id, full_name, chamber, state"
      ),
    ]);

    const peopleById = new Map(people.map((p) => [p.id, p]));
    const personCounts = new Map<string, number>();
    let institutionalCount = 0;
    let uncategorizedCount = 0;
    for (const it of items) {
      if (it.is_institutional) institutionalCount += 1;
      if (it.primary_person_id) {
        personCounts.set(it.primary_person_id, (personCounts.get(it.primary_person_id) ?? 0) + 1);
      } else if (!it.is_institutional) {
        uncategorizedCount += 1;
      }
    }

    const peopleFacet = [...personCounts.entries()]
      .map(([id, count]) => {
        const p = peopleById.get(id);
        return p ? { id, full_name: p.full_name, chamber: p.chamber, state: p.state, count } : null;
      })
      .filter((p): p is NonNullable<typeof p> => Boolean(p))
      .sort((a, b) => b.count - a.count || a.full_name.localeCompare(b.full_name));

    const tagCounts = new Map<string, number>();
    for (const t of tagRows) {
      tagCounts.set(t.label, (tagCounts.get(t.label) ?? 0) + 1);
    }
    const tagsFacet = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 60)
      .map(([label, count]) => ({ label, count }));

    return NextResponse.json({
      people: peopleFacet,
      tags: tagsFacet,
      institutionalCount,
      uncategorizedCount,
      totalItems: items.length,
    });
  } catch (error: any) {
    console.error("[API/Archive/Facets] Fatal Error:", error);
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}
