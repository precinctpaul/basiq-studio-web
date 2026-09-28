import { notFound } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { ASPECT_SHORT_LABELS, type AspectMode } from "@/lib/crop";
import { ShareClipPlayer } from "@/components/ShareClipPlayer";

export const runtime = "nodejs";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let value = n;
  let i = -1;
  do {
    value /= 1024;
    i++;
  } while (value >= 1024 && i < units.length - 1);
  return `${value.toFixed(1)} ${units[i]}`;
}

function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * The no-login "forever" link the brief asks for. Server component so a
 * revoked or unknown token 404s before any client JS runs, and so the lookup
 * uses the service-role client directly rather than round-tripping through an
 * API route just to render a page.
 *
 * The clip PLAYS here before it downloads. A recipient handed a bare download
 * button has to commit to a file to find out whether it is the right cut;
 * watching first is the whole point of sending a link rather than a file.
 *
 * The clip/reel lives on the shared drive, not a bucket, so THIS component
 * only validates the token and 404s — it hands local_path to a client
 * component (ShareClipPlayer) that builds the actual playback/download url,
 * because only the viewer's own browser knows their agent's address.
 * Internal-only sharing: the viewer needs their own agent running against
 * the same drive.
 *
 * A token resolves to exactly one of a clip or a reel (see
 * share_tokens_one_target in supabase/migrations/0016_reels.sql) — a
 * rendered reel is a shared file the same way a clip is, just produced by
 * a different pipeline (REELS_DESIGN.md), so it gets the same page rather
 * than a separate one.
 */
export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const db = supabaseAdmin();

  // Cast the WHOLE row right after the fetch, once, rather than casting
  // each property access individually -- supabase-js's select-string-based
  // type inference falls back to an opaque error type once a query embeds
  // two different relations off the same base table (clips AND reels,
  // both off share_tokens here), so `row`'s own inferred type can't be
  // relied on at all past this point regardless of which field is touched.
  const { data: rawRow } = await db
    .from("share_tokens")
    .select(
      "token, clip_id, revoked_at, " +
        "clips(id, title, duration_seconds, size_bytes, aspect_mode, status, local_path), " +
        "reels(id, title, duration_seconds, size_bytes, canvas_width, canvas_height, status, local_path)",
    )
    .eq("token", token)
    .single();

  const row = rawRow as unknown as {
    clip_id: string | null;
    revoked_at: string | null;
    clips: {
      id: string;
      title: string;
      duration_seconds: number;
      size_bytes: number;
      aspect_mode: AspectMode;
      status: string;
      local_path: string | null;
    } | null;
    reels: {
      id: string;
      title: string;
      duration_seconds: number;
      size_bytes: number;
      canvas_width: number;
      canvas_height: number;
      status: string;
      local_path: string | null;
    } | null;
  } | null;

  const clip = row?.clips ?? null;
  const reel = row?.reels ?? null;
  const target = row?.clip_id ? clip : reel;
  if (!row || row.revoked_at || !target || target.status !== "ready" || !target.local_path) {
    notFound();
  }

  // A vertical clip/reel in a wide box is mostly letterbox; cap the width
  // so 9:16 gets a sensible portrait frame and 16:9 still fills the page.
  // Clips carry an explicit aspect_mode; a reel has no single mode (its
  // segments can mix modes — REELS_DESIGN.md), so its own fixed canvas
  // dimensions are what actually decide the shape here instead.
  const vertical = clip ? clip.aspect_mode !== "native" : reel!.canvas_height > reel!.canvas_width;
  const aspectLabel = clip ? ASPECT_SHORT_LABELS[clip.aspect_mode] : vertical ? "9:16" : "16:9";

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center px-6 py-10 text-center">
      <h1 className="mb-2 text-2xl font-semibold text-neutral-100">
        {target.title || (clip ? "Untitled clip" : "Untitled reel")}
      </h1>
      <p className="mb-6 text-neutral-500">
        {aspectLabel} · {formatDuration(target.duration_seconds)} · {formatBytes(target.size_bytes)}
      </p>

      <ShareClipPlayer token={token} localPath={target.local_path} vertical={vertical} />
    </main>
  );
}
