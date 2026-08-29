import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { MAJORITY_DEMOCRATS, THE_BENCH } from "@/lib/archiveBuckets";

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
 * Seven mutually-exclusive folders, matching the same taxonomy the videos/
 * tags schema already uses: Majority Democrats, The Bench, House, Senate,
 * Notable Figures, Institutional, Uncategorized. A person is checked
 * against the MD/Bench rosters FIRST -- a sitting House member on the
 * Majority Democrats list is filed there, not under House, same as the
 * old system pulls MD/Bench members out of the generic chamber buckets.
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
    // Mutually exclusive so the folder counts sum to totalItems: a person
    // (when resolved) is the primary bucket even for an item also flagged
    // institutional -- "Institutional" means ONLY institutional, no
    // specific person attached (a pure floor session/hearing).
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

    type PersonRow = { id: string; name: string; state: string | null; count: number };
    const majorityDemocrats: PersonRow[] = [];
    const bench: PersonRow[] = [];
    const chamberMap = new Map<string, PersonRow[]>();
    const notableFigures: PersonRow[] = [];

    for (const [personId, count] of personCounts.entries()) {
      const p = peopleById.get(personId);
      if (!p) continue;
      const row = { id: p.id, name: p.full_name, state: p.state, count };
      if (MAJORITY_DEMOCRATS.has(p.full_name)) {
        majorityDemocrats.push(row);
      } else if (THE_BENCH.has(p.full_name)) {
        bench.push(row);
      } else if (p.identifier_type === "name_slug" || !p.chamber) {
        notableFigures.push(row);
      } else {
        const list = chamberMap.get(p.chamber) ?? [];
        list.push(row);
        chamberMap.set(p.chamber, list);
      }
    }

    const byCountThenName = (a: PersonRow, b: PersonRow) => b.count - a.count || a.name.localeCompare(b.name);
    majorityDemocrats.sort(byCountThenName);
    bench.sort(byCountThenName);
    notableFigures.sort(byCountThenName);

    const chambers = [...chamberMap.entries()]
      .map(([chamber, list]) => ({
        chamber,
        count: list.reduce((sum, p) => sum + p.count, 0),
        people: list.sort(byCountThenName),
      }))
      .sort((a, b) => b.count - a.count);

    return NextResponse.json({
      majorityDemocrats: { count: majorityDemocrats.reduce((s, p) => s + p.count, 0), people: majorityDemocrats },
      bench: { count: bench.reduce((s, p) => s + p.count, 0), people: bench },
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
