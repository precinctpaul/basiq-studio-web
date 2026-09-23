/**
 * lucid-root.ts — a per-browser (not per-user-account) setting: "what does
 * this machine's LucidLink mount look like." Every teammate has the same
 * shared drive mounted, just at a different path per OS/machine (a drive
 * letter on Windows, /Volumes/LucidLink on a Mac). videos.local_path and
 * clips.local_path are always stored RELATIVE to that drive (see
 * supabase/migrations/0005_local_media.sql), so this is the one missing
 * piece needed to turn a relative path into something a teammate can
 * actually paste into Explorer/Finder — without needing a locally-running
 * agent at all (contrast with isLocalAgent()-gated features in lib/agent.ts,
 * which act on a REMOTE machine's filesystem and genuinely do need one).
 */
const STORAGE_KEY = "basiq.lucidRoot";

export function getLucidRoot(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(STORAGE_KEY) || "";
}

export function setLucidRoot(root: string): void {
  window.localStorage.setItem(STORAGE_KEY, root.trim());
}

/**
 * local_path is always POSIX-style ("/" separators — see scan_media's
 * path.relative_to(root).as_posix() in tools/basiq_agent.py); a configured
 * root may be a native Windows path (backslashes). Joining the two naively
 * would leave a mixed "C:\...\folder/file.mp4" path — technically openable
 * in Explorer's address bar, but not what a teammate expects on their
 * clipboard.
 */
export function joinNativePath(root: string, relPath: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  const rel = sep === "\\" ? relPath.replace(/\//g, "\\") : relPath;
  const base = root.endsWith(sep) ? root.slice(0, -1) : root;
  return `${base}${sep}${rel}`;
}

/**
 * Returns the saved root, prompting once (and saving the answer) if this
 * browser has never been configured. Returns "" if the user cancels — the
 * caller should treat that as "do nothing," not fall back to a bare
 * relative path (which is not a real, pasteable location on this machine).
 */
export function ensureLucidRoot(): string {
  const existing = getLucidRoot();
  if (existing) return existing;
  const entered = window.prompt(
    "What's your LucidLink root on THIS machine?\n\n" +
      "Windows example:  Z:\\Archive\\Basiq-Studio-Hub\n" +
      "Mac example:       /Volumes/LucidLink/Archive/Basiq-Studio-Hub\n\n" +
      "Saved only in this browser — set it once per machine."
  );
  if (!entered?.trim()) return "";
  const root = entered.trim();
  setLucidRoot(root);
  return root;
}
