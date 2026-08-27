import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

const CreateVideoBody = z.object({
  // The live-capture job's own id -- the same value basiq_agent.py uses as
  // both its job_id and the videos.id in run_live_capture's own write at
  // the end of the capture (see tools/basiq_agent.py, on_conflict=id).
  // Passing it here instead of letting Postgres mint a fresh id is what
  // makes this row and that later write land on the SAME row. Without it,
  // the two writes create two different rows that both end up pointing at
  // the same local_path once the capture finishes and remuxes -- which
  // trips videos_local_path_key on whichever write loses the race.
  id: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(300),
  sourceUrl: z.string().max(2000).default(""),
  // The agent reserves the destination on the shared drive and reports it
  // the moment the name is chosen — well before the recording finishes — so
  // this row can exist, and its transcript can start growing, while a live
  // capture is still running.
  localPath: z.string().trim().min(1).max(1000),
});

/**
 * A bare row for a LIVE CAPTURE IN PROGRESS. This is the only remaining way
 * a video row gets created ahead of its bytes: a grab's row is discovered by
 * the library scan once the download finishes (see /api/library/sync), but a
 * live capture needs the row to exist immediately so the operator can watch
 * its transcript grow and clip from it before the stream ends.
 *
 * There is no upload here and never will be — masters live on the shared
 * drive, full stop. If MEDIA_ROOT isn't mounted, the agent has nowhere to
 * put the bytes and this route is never called.
 */
export async function POST(req: NextRequest) {
  const parsed = CreateVideoBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { id, title, sourceUrl, localPath } = parsed.data;

  const db = supabaseAdmin();
  // Upsert on id, not a plain insert: this call can retry (a dropped
  // response, a re-render), and basiq_agent.py's own write at the end of
  // run_live_capture targets this same id too -- both need to land on one
  // row, never create a second one that later collides on local_path.
  const { data: video, error } = await db
    .from("videos")
    .upsert(
      {
        id,
        title,
        source_kind: "url",
        source_url: sourceUrl,
        local_path: localPath,
        status: "recording",
      },
      { onConflict: "id" },
    )
    .select()
    .single();
  if (error || !video) {
    return NextResponse.json(
      { error: error?.message ?? "could not create video row" },
      { status: 500 },
    );
  }

  return NextResponse.json({ videoId: video.id, video });
}

/** Library listing — most recent first, capped the same as the desktop app's own query() default. */
export async function GET() {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("videos")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ videos: data });
}
