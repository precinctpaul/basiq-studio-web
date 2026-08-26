import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

/**
 * GET /api/library/buckets
 *
 * Returns bucket + person counts WITHOUT loading any video rows. This is
 * what makes the sidebar's folder counts accurate the instant the page
 * opens, instead of depending on how much of the library has progressively
 * streamed in so far.
 *
 * The tags query pages through in chunks of 1000 rather than a single
 * unbounded fetch, because PostgREST caps unbounded queries at a default
 * row limit (1000 on a standard hosted Supabase project). With well over
 * 1000 bucket+person tag rows in this table, a single fetch was silently
 * truncated -- undercounting every named bucket and, as a side effect,
 * inflating the "Uncategorized" count, since videos whose bucket tag never
 * made it into that truncated slice looked uncategorized here even though
 * they aren't (2026-08-26).
 */
export async function GET() {
  try {
    const db = supabaseAdmin();

    const { count: totalVideos, error: totalErr } = await db
      .from("videos")
      .select("id", { count: "exact", head: true })
      .neq("status", "uploading");
    if (totalErr) throw new Error(`Video count failed: ${totalErr.message}`);

    const PAGE_SIZE = 1000;
    const tagRows: { video_id: string; label: string; kind: string }[] = [];
    let from = 0;
    while (true) {
      const { data, error } = await db
        .from("tags")
        .select("video_id, label, kind")
        .in("kind", ["bucket", "person"])
        .order("video_id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw new Error(`Tags fetch failed: ${error.message}`);
      if (!data || data.length === 0) break;
      tagRows.push(...data);
      if (data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }

    const personByVideo = new Map<string, string>();
    for (const t of tagRows) {
      if (t.kind === "person") personByVideo.set(t.video_id, t.label);
    }

    const bucketMap = new Map<string, Map<string, Set<string>>>();
    const categorizedVideoIds = new Set<string>();

    for (const t of tagRows) {
      if (t.kind !== "bucket") continue;
      categorizedVideoIds.add(t.video_id);
      const person = personByVideo.get(t.video_id) ?? "Unsorted";
      const people = bucketMap.get(t.label) ?? new Map<string, Set<string>>();
      const set = people.get(person) ?? new Set<string>();
      set.add(t.video_id);
      people.set(person, set);
      bucketMap.set(t.label, people);
    }

    const buckets = [...bucketMap.entries()].map(([label, people]) => {
      const allIdsInBucket = new Set<string>();
      const peopleList = [...people.entries()].map(([name, ids]) => {
        ids.forEach((id) => allIdsInBucket.add(id));
        return { name, count: ids.size };
      });
      peopleList.sort((a, b) => a.name.localeCompare(b.name));
      return { label, count: allIdsInBucket.size, people: peopleList };
    });

    return NextResponse.json({
      buckets,
      uncategorizedCount: Math.max(0, (totalVideos ?? 0) - categorizedVideoIds.size),
      totalVideos: totalVideos ?? 0,
    });
  } catch (error: any) {
    console.error("[API/Library/Buckets] Fatal Error:", error);
    return NextResponse.json(
      { error: error.message || "Internal Server Error" },
      { status: 500 }
    );
  }
}
