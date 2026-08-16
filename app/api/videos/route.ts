import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

const CreateVideoBody = z.object({
  title: z.string().trim().min(1).max(300),
  filename: z.string().trim().min(1).max(300),
  mimeType: z.string().trim().min(1).max(200),
  // nonnegative, not positive: a GRAB creates its row BEFORE the download
  // starts (the row is what mints the signed upload URL the agent needs), so
  // the real size genuinely isn't known yet and arrives later via PATCH.
  sizeBytes: z.number().int().nonnegative(),
  sourceKind: z.enum(["upload", "url"]).default("upload"),
  sourceUrl: z.string().max(2000).default(""),
});

/**
 * Filesystem/storage-safe slug for the object path. Keeps the original name
 * recognisable in the Supabase dashboard while dropping characters that upset
 * a storage path. Trims from the FRONT (keeps the tail) because the extension
 * — which decides how the browser and FFmpeg treat the file — lives at the
 * end, while an overlong prefix is just a descriptive title losing characters.
 */
function safeFilename(name: string): string {
  const trimmed = name.trim().slice(-200);
  const cleaned = trimmed.replace(/[^A-Za-z0-9._-]+/g, "_");
  return cleaned || "video";
}

export async function POST(req: NextRequest) {
  const json = await req.json().catch(() => null);
  const parsed = CreateVideoBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { title, filename, mimeType, sizeBytes, sourceKind, sourceUrl } = parsed.data;

  const db = supabaseAdmin();
  const { data: video, error: insertError } = await db
    .from("videos")
    .insert({
      title,
      source_kind: sourceKind,
      source_url: sourceUrl,
      mime_type: mimeType,
      size_bytes: sizeBytes,
      status: "uploading",
    })
    .select()
    .single();

  if (insertError || !video) {
    return NextResponse.json(
      { error: insertError?.message ?? "could not create video row" },
      { status: 500 },
    );
  }

  const path = `${video.id}/${safeFilename(filename)}`;
  const { data: signed, error: signError } = await db.storage
    .from("videos")
    .createSignedUploadUrl(path);

  if (signError || !signed) {
    await db
      .from("videos")
      .update({ status: "failed", error: signError?.message ?? "could not sign upload url" })
      .eq("id", video.id);
    return NextResponse.json(
      { error: signError?.message ?? "could not sign upload url" },
      { status: 500 },
    );
  }

  const { error: pathUpdateError } = await db
    .from("videos")
    .update({ storage_path: path })
    .eq("id", video.id);
  if (pathUpdateError) {
    return NextResponse.json({ error: pathUpdateError.message }, { status: 500 });
  }

  return NextResponse.json({
    videoId: video.id,
    path,
    signedUrl: signed.signedUrl,
    token: signed.token,
  });
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
