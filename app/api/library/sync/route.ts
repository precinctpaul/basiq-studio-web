import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

const FileRow = z.object({
  path: z.string().min(1).max(1000),
  name: z.string().max(300).default(""),
  sizeBytes: z.number().int().nonnegative().default(0),
  duration: z.number().nonnegative().default(0),
  width: z.number().int().nonnegative().default(0),
  height: z.number().int().nonnegative().default(0),
  fps: z.number().nonnegative().default(0),
  hasVideo: z.boolean().default(true),
  hasAudio: z.boolean().default(true),
  vcodec: z.string().max(50).default(""),
  acodec: z.string().max(50).default(""),
});

const Body = z.object({ files: z.array(FileRow).max(5000) });

/**
 * Reconcile the shared drive's contents with the library.
 *
 * Each teammate's agent scans the SAME mounted folder, so this is what makes
 * one library out of many machines: whoever opens the app first files the
 * new footage, and everyone else's sync is a no-op because local_path is
 * unique.
 *
 * Rows are matched on local_path. A file missing from the scan is deleted —
 * but ONLY when the scan itself returned at least one file. An unmounted
 * drive's scan comes back completely empty (agentLibrary/scan_media both
 * short-circuit to `[]` the moment MEDIA_ROOT isn't a real directory), so
 * that one guard is what stops a teammate's temporarily-offline volume from
 * reading as "every file vanished" and wiping the whole library's rows —
 * transcripts, tags and key moments included — in one sync. A real scan
 * that's merely missing a FEW files (deleted from the drive on purpose)
 * still prunes exactly those rows.
 *
 * A 'recording' row is skipped entirely, even if its file's size or duration
 * changed — which, for a live capture still being written to, it constantly
 * does. Its title, probe fields and eventual flip to 'ready' are owned by the
 * capture flow itself (see onGrab's live branch); if a passive scan raced
 * that and won, an operator clicking RESCAN mid-stream would see a recording
 * marked "ready" with a snapshot duration, and the player would try to load
 * a still-growing .ts file that Chrome cannot play regardless.
 */
export async function POST(req: NextRequest) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const db = supabaseAdmin();

  const { data: existing, error: readError } = await db
    .from("videos")
    .select("id, local_path, size_bytes, duration_seconds, status")
    .not("local_path", "is", null);
  if (readError) {
    return NextResponse.json({ error: readError.message }, { status: 500 });
  }

  const byPath = new Map((existing ?? []).map((r) => [r.local_path as string, r]));
  const seen = new Set<string>();
  let added = 0;
  let updated = 0;

  for (const file of parsed.data.files) {
    seen.add(file.path);
    const row = {
      title: file.name || file.path,
      source_kind: "local" as const,
      local_path: file.path,
      size_bytes: file.sizeBytes,
      duration_seconds: file.duration,
      width: file.width,
      height: file.height,
      fps: file.fps,
      has_video: file.hasVideo,
      has_audio: file.hasAudio,
      vcodec: file.vcodec,
      acodec: file.acodec,
      status: "ready" as const,
    };

    const found = byPath.get(file.path);
    if (!found) {
      const { error } = await db.from("videos").insert(row);
      // A unique-violation means another teammate's agent filed it a moment
      // ago. That is the system working, not a failure.
      if (error && !error.message.includes("duplicate key")) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      if (!error) added++;
      continue;
    }
    if (found.status === "recording") continue;
    // Only rewrite when the file actually changed, so a routine scan of a
    // large drive isn't thousands of pointless writes.
    if (found.size_bytes !== file.sizeBytes || Math.abs((found.duration_seconds ?? 0) - file.duration) > 0.5) {
      const { error } = await db.from("videos").update(row).eq("id", found.id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      updated++;
    }
  }

  const missingRows = (existing ?? []).filter((r) => !seen.has(r.local_path as string));

  let removed = 0;
  if (missingRows.length && parsed.data.files.length > 0) {
    const { error } = await db.from("videos").delete().in("id", missingRows.map((r) => r.id));
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    removed = missingRows.length;
  }

  return NextResponse.json({ added, updated, removed, total: parsed.data.files.length });
}
