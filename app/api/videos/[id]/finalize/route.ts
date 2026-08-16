import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { probeUrl } from "@/lib/media-probe";

export const runtime = "nodejs";
// Comfortably above the ~45s ffprobe timeout in lib/media-probe.ts; a probe
// itself only reads a few Range requests, not the file, so this is generous
// headroom rather than a number the app expects to actually need.
export const maxDuration = 60;

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = supabaseAdmin();

  const { data: video, error: fetchError } = await db
    .from("videos")
    .select("*")
    .eq("id", id)
    .single();
  if (fetchError || !video) {
    return NextResponse.json({ error: fetchError?.message ?? "video not found" }, { status: 404 });
  }
  if (!video.storage_path) {
    return NextResponse.json({ error: "video has no storage_path yet" }, { status: 400 });
  }

  await db.from("videos").update({ status: "probing" }).eq("id", id);

  // Short-lived signed READ url: it never leaves this function, so 5 minutes
  // is purely headroom for ffprobe's own Range requests to complete.
  const { data: signed, error: signError } = await db.storage
    .from("videos")
    .createSignedUrl(video.storage_path, 300);
  if (signError || !signed) {
    const message = signError?.message ?? "could not sign read url";
    await db.from("videos").update({ status: "failed", error: message }).eq("id", id);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  try {
    const info = await probeUrl(signed.signedUrl);

    // A file that probes to zero duration and no streams at all almost
    // certainly means the upload didn't land intact, not that this is a
    // legitimately empty video — fail loudly instead of storing a ready row
    // that will only confuse the crop/export UI later.
    if (!info.hasVideo && !info.hasAudio) {
      throw new Error("ffprobe found no audio or video streams — upload may be incomplete or corrupt");
    }

    const { error: updateError } = await db
      .from("videos")
      .update({
        duration_seconds: info.duration,
        width: info.width,
        height: info.height,
        fps: info.fps,
        has_video: info.hasVideo,
        has_audio: info.hasAudio,
        vcodec: info.vcodec,
        acodec: info.acodec,
        status: "ready",
        error: "",
      })
      .eq("id", id);
    if (updateError) throw new Error(updateError.message);

    return NextResponse.json({ ok: true, info });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.from("videos").update({ status: "failed", error: message }).eq("id", id);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
