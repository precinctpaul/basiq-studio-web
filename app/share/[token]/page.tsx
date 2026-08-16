import { notFound } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { ASPECT_SHORT_LABELS, type AspectMode } from "@/lib/crop";

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
 * uses the service-role client directly rather than round-tripping through
 * an API route just to render a page.
 */
export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const db = supabaseAdmin();

  const { data: row } = await db
    .from("share_tokens")
    .select("token, revoked_at, clips(title, duration_seconds, size_bytes, aspect_mode, status)")
    .eq("token", token)
    .single();

  const clip = row?.clips as unknown as
    | { title: string; duration_seconds: number; size_bytes: number; aspect_mode: AspectMode; status: string }
    | null;

  if (!row || row.revoked_at || !clip || clip.status !== "ready") {
    notFound();
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center px-6 text-center">
      <h1 className="mb-2 text-2xl font-semibold text-neutral-100">{clip.title || "Untitled clip"}</h1>
      <p className="mb-8 text-neutral-500">
        {ASPECT_SHORT_LABELS[clip.aspect_mode]} · {formatDuration(clip.duration_seconds)} ·{" "}
        {formatBytes(clip.size_bytes)}
      </p>
      <a
        href={`/api/share/${token}/download`}
        className="rounded-full bg-neutral-100 px-8 py-3 font-medium text-neutral-900 transition-colors hover:bg-white"
      >
        Download
      </a>
    </main>
  );
}
