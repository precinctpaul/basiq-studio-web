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
 * GET /api/archive/buckets
 *
 * Same shape of idea as /api/library/buckets: folder counts computed
 * up front, independent of whatever page of results happens to be loaded.
 * The archive has no "Majority Democrats / The Bench" party-affiliation
 * buckets the way videos does (that classification lives in bulk_tag_
 * buckets.py's member rosters, which archive_items was never run through)
 * -- chamber (House/Senate) plus a Notable Figures bucket for resolved
 * non-Congress people is the grouping this schema actually supports.
 */
export async function GET() {
  try {
    const db = supabaseAdmin();

    const [items, people] = await Promise.all([
      fetchAll<{ primary_person_id: string | null; is_institutional: boolean }>(
        db,
        "archive_items",
        "primary_person_id, is_institutional"
      ),
      fetchAll<{
        id: string;
        full_name: string;
        chamber: string | null;
        state: string | null;
        identifier_type: string;
      }>(db, "people", "id, full_name, chamber, state, identifier_type"),
    ]);

    const peopleById = new Map(people.map((p) => [p.id, p]));
    // Mutually exclusive so the five folder counts sum to totalItems: a
    // person (when resolved) is the primary bucket even for an item also
    // flagged institutional -- "Institutional" means ONLY institutional,
    // no specific person attached (a pure floor session/hearing).
    const personCounts = new Map<string, number>();
    let institutionalCount = 0;
    let uncategorizedCount = 0;
    for (const it of items) {
      if (it.primary_person_id) {
        personCounts.set(it.primary_person_id, (personCounts.get(it.primary_person_id) ?? 0) + 1);
      } else if (it.is_institutional) {
        institutionalCount += 1;
      } else {
        uncategorizedCount += 1;
      }
    }

    const chamberMap = new Map<string, Array<{ id: string; name: string; state: string | null; count: number }>>();
    const notableFigures: Array<{ id: string; name: string; count: number }> = [];

    for (const [personId, count] of personCounts.entries()) {
      const p = peopleById.get(personId);
      if (!p) continue;
      if (p.identifier_type === "name_slug" || !p.chamber) {
        notableFigures.push({ id: p.id, name: p.full_name, count });
        continue;
      }
      const list = chamberMap.get(p.chamber) ?? [];
      list.push({ id: p.id, name: p.full_name, state: p.state, count });
      chamberMap.set(p.chamber, list);
    }

    const chambers = [...chamberMap.entries()]
      .map(([chamber, list]) => ({
        chamber,
        count: list.reduce((sum, p) => sum + p.count, 0),
        people: list.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => b.count - a.count);

    notableFigures.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    return NextResponse.json({
      chambers,
      notableFigures,
      institutionalCount,
      uncategorizedCount,
      totalItems: items.length,
    });
  } catch (error: any) {
    console.error("[API/Archive/Buckets] Fatal Error:", error);
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}
