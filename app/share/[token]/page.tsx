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
 * The clip lives on the shared drive, not a bucket, so THIS component only
 * validates the token and 404s — it hands local_path to a client component
 * (ShareClipPlayer) that builds the actual playback/download url, because
 * only the viewer's own browser knows their agent's address. Internal-only
 * sharing: the viewer needs their own agent running against the same drive.
 */
export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const db = supabaseAdmin();

  const { data: row } = await db
    .from("share_tokens")
    .select(
      "token, revoked_at, clips(id, title, duration_seconds, size_bytes, aspect_mode, status, local_path)",
    )
    .eq("token", token)
    .single();

  const clip = row?.clips as unknown as
    | {
        id: string;
        title: string;
        duration_seconds: number;
        size_bytes: number;
        aspect_mode: AspectMode;
        status: string;
        local_path: string | null;
      }
    | null;

  if (!row || row.revoked_at || !clip || clip.status !== "ready" || !clip.local_path) {
    notFound();
  }

  // A vertical clip in a wide box is mostly letterbox; cap the width so 9:16
  // gets a sensible portrait frame and 16:9 still fills the page.
  const vertical = clip.aspect_mode !== "native";

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center px-6 py-10 text-center">
      <h1 className="mb-2 text-2xl font-semibold text-neutral-100">
        {clip.title || "Untitled clip"}
      </h1>
      <p className="mb-6 text-neutral-500">
        {ASPECT_SHORT_LABELS[clip.aspect_mode]} · {formatDuration(clip.duration_seconds)} ·{" "}
        {formatBytes(clip.size_bytes)}
      </p>

      <ShareClipPlayer token={token} localPath={clip.local_path} vertical={vertical} />
    </main>
  );
}
