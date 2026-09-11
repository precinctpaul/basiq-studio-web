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

    // Every video with a bucket tag counts toward that bucket's total, but
    // only ones that ALSO have a person tag get a named sub-folder --
    // videos with a bucket tag and no person (e.g. an "Institutional"
    // floor session, or a bucket assigned by hand without picking a
    // specific person) used to be lumped into a synthetic "Unsorted"
    // person entry, which read as a real name in the list. Tracking the
    // bucket's full video-id set separately from its named people keeps
    // the count accurate while just leaving those videos out of the
    // people breakdown instead of inventing a fake one.
    const bucketVideoIds = new Map<string, Set<string>>();
    const bucketPeople = new Map<string, Map<string, Set<string>>>();
    const categorizedVideoIds = new Set<string>();

    for (const t of tagRows) {
      if (t.kind !== "bucket") continue;
      categorizedVideoIds.add(t.video_id);
      const allIds = bucketVideoIds.get(t.label) ?? new Set<string>();
      allIds.add(t.video_id);
      bucketVideoIds.set(t.label, allIds);

      const person = personByVideo.get(t.video_id);
      if (person) {
        const people = bucketPeople.get(t.label) ?? new Map<string, Set<string>>();
        const set = people.get(person) ?? new Set<string>();
        set.add(t.video_id);
        people.set(person, set);
        bucketPeople.set(t.label, people);
      }
    }

    const buckets = [...bucketVideoIds.entries()].map(([label, allIds]) => {
      const people = bucketPeople.get(label) ?? new Map<string, Set<string>>();
      const peopleList = [...people.entries()].map(([name, ids]) => ({ name, count: ids.size }));
      peopleList.sort((a, b) => a.name.localeCompare(b.name));
      return { label, count: allIds.size, people: peopleList };
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
