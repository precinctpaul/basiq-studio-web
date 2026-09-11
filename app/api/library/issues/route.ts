import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

/**
 * Real per-category counts for the Filter dropdown (2026-09-10), sourced
 * from the `kind="issue"` tags tools/classify_video_issues.py wrote --
 * distinct from the older, messier `kind="topics"` auto-tags (see
 * HANDOFF.md's 2026-09-10 entry for why those needed a real classification
 * pass rather than a rename).
 *
 * Aggregated here in Node rather than via a stored SQL function: kind="issue"
 * is ~18-19k rows total, small enough to page through and count in one
 * request without needing another migration for the user to remember to run
 * (see 0012_transcript_search_rank.sql's "has this been run yet?" fallback
 * for what that cost once already) -- and this endpoint is only called once
 * per page load, not per keystroke, so the extra round trips don't matter.
 */
export async function GET() {
  try {
    const db = supabaseAdmin();
    const counts = new Map<string, number>();
    const pageSize = 1000;
    let page = 0;
    for (;;) {
      const { data, error } = await db
        .from("tags")
        .select("label")
        .eq("kind", "issue")
        .range(page * pageSize, page * pageSize + pageSize - 1);
      if (error) throw new Error(error.message);
      for (const row of data ?? []) {
        counts.set(row.label, (counts.get(row.label) ?? 0) + 1);
      }
      if (!data || data.length < pageSize) break;
      page++;
    }

    const issues = Array.from(counts.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);

    return NextResponse.json({ issues });
  } catch (error: any) {
    console.error("[API/Library/Issues] Fatal Error:", error);
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}
