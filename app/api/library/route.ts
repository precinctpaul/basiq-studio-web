import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

const PAGE_SIZE = 1000;

/**
 * Supabase/PostgREST caps a query at 1,000 rows by default unless you
 * explicitly page through it. A first version of this endpoint didn't, and
 * silently undercounted every bucket once total tags passed 1,000 — this is
 * the fix, same pagination pattern used everywhere else in this app.
 */
async function fetchAllTags(db: ReturnType<typeof supabaseAdmin>, kinds: string[]) {
  const rows: Array<{ video_id: string; label: string; kind: string }> = [];
  let page = 0;
  while (true) {
    const { data, error } = await db
      .from("tags")
      .select("video_id, label, kind")
      .in("kind", kinds)
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (error) throw new Error(`Tags fetch failed: ${error.message}`);
    const batch = data ?? [];
    rows.push(...(batch as any));
    if (batch.length < PAGE_SIZE) break;
    page++;
  }
  return rows;
}

/**
 * GET /api/library/buckets
 *
 * Returns bucket + person counts WITHOUT loading any video rows, so the
 * sidebar's folder counts are accurate the instant the page opens rather
 * than depending on how much of the library has progressively loaded.
 *
 * A bucket can be flat (Majority Democrats, The Bench — people sit directly
 * inside) or subdivided by chamber (Watch List — House/Senate/Cabinet
 * subfolders, each holding people). Whichever shape applies is detected
 * from whether a kind='chamber' tag exists on the matching videos; the
 * frontend checks for `chambers` vs `people` on each bucket to know which
 * layout to render.
 */
export async function GET() {
  try {
    const db = supabaseAdmin();

    const { count: totalVideos, error: totalErr } = await db
      .from("videos")
      .select("id", { count: "exact", head: true })
      .neq("status", "uploading");
    if (totalErr) throw new Error(`Video count failed: ${totalErr.message}`);

    const tagRows = await fetchAllTags(db, ["bucket", "person", "chamber"]);

    const personByVideo = new Map<string, string>();
    const chamberByVideo = new Map<string, string>();
    for (const t of tagRows) {
      if (t.kind === "person") personByVideo.set(t.video_id, t.label);
      if (t.kind === "chamber") chamberByVideo.set(t.video_id, t.label);
    }

    // bucket -> chamber ("" = no subdivision) -> person -> Set(video_id)
    const bucketMap = new Map<string, Map<string, Map<string, Set<string>>>>();
    const categorizedVideoIds = new Set<string>();

    for (const t of tagRows) {
      if (t.kind !== "bucket") continue;
      categorizedVideoIds.add(t.video_id);
      const chamber = chamberByVideo.get(t.video_id) ?? "";
      const person = personByVideo.get(t.video_id) ?? "Unsorted";

      const chambers = bucketMap.get(t.label) ?? new Map<string, Map<string, Set<string>>>();
      const people = chambers.get(chamber) ?? new Map<string, Set<string>>();
      const set = people.get(person) ?? new Set<string>();
      set.add(t.video_id);
      people.set(person, set);
      chambers.set(chamber, people);
      bucketMap.set(t.label, chambers);
    }

    const buckets = [...bucketMap.entries()].map(([label, chambers]) => {
      const allIds = new Set<string>();
      const hasChambers = [...chambers.keys()].some((c) => c !== "");

      if (hasChambers) {
        const chamberList = [...chambers.entries()]
          .map(([chamberName, people]) => {
            const chamberIds = new Set<string>();
            const peopleList = [...people.entries()]
              .map(([name, ids]) => {
                ids.forEach((id) => {
                  chamberIds.add(id);
                  allIds.add(id);
                });
                return { name, count: ids.size };
              })
              .sort((a, b) => a.name.localeCompare(b.name));
            return { chamber: chamberName || "Other", count: chamberIds.size, people: peopleList };
          })
          .sort((a, b) => a.chamber.localeCompare(b.chamber));
        return { label, count: allIds.size, chambers: chamberList };
      }

      const peopleList = [...(chambers.get("") ?? new Map<string, Set<string>>()).entries()]
        .map(([name, ids]) => {
          ids.forEach((id) => allIds.add(id));
          return { name, count: ids.size };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
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
