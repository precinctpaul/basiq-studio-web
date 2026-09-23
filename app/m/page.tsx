"use client";

/**
 * app/m — a deliberately separate, minimal route for phones.
 *
 * The real studio page (app/page.tsx) is a full desktop editor -- library
 * browsing, a player, transcript-based clipping, bucket assignment. None of
 * that translates to a phone screen, and the request was never "make that
 * responsive": on mobile the only job is getting a URL onto the shared
 * drive fast, full stop. Building this as its own route means it can stay
 * this simple forever without fighting the desktop layout, and the desktop
 * page is completely untouched by this file existing.
 *
 * Reuses the same agent calls the desktop GRAB button uses (agentGrab,
 * waitForJob) -- the real download path, not a reimplementation -- but
 * skips the desktop-only orchestration that follows a grab there (the
 * LucidLink-sync-then-auto-transcribe chain in app/page.tsx's runGrab).
 * That's fine here: the file lands on the shared drive either way, and
 * transcription/tagging can happen whenever someone opens the real app.
 */
import { useState } from "react";
import { agentDiskLibrary, agentGrab, waitForJob } from "@/lib/agent";

type Status = "idle" | "checking" | "working" | "done" | "error";

export default function MobileGrabPage() {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [pct, setPct] = useState<number | null>(null);

  const busy = status === "checking" || status === "working";

  const submit = async () => {
    const trimmed = url.trim();
    if (!trimmed || busy) return;
    setStatus("checking");
    setMessage("Checking the shared drive…");
    setPct(null);
    try {
      // Same pre-flight the desktop GRAB does (requireSharedDrive in
      // app/page.tsx) -- catches "the agent's LucidLink mount isn't up"
      // before burning a whole download on it.
      const lib = await agentDiskLibrary().catch(() => ({ exists: false, root: "", files: [] }));
      if (!lib.exists) {
        throw new Error("The shared drive isn't mounted on the agent right now — try again in a bit.");
      }

      setStatus("working");
      setMessage("Starting…");
      const { jobId } = await agentGrab({ url: trimmed, quality: "HD", subs: true });
      const done = await waitForJob(jobId, (job) => {
        setMessage(job.detail || job.status || "Working…");
        setPct(job.pct ?? null);
      });

      setStatus("done");
      setMessage(`Saved to the shared drive: ${done.result?.title || trimmed}`);
      setUrl("");
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        gap: 16,
        padding: "24px 20px",
        background: "var(--bg-panel)",
        color: "var(--milk)",
        fontFamily: "var(--font-body)",
      }}
    >
      <h1 style={{ fontFamily: "var(--font-mono)", fontSize: 18, letterSpacing: 1, margin: 0 }}>
        BASIQ · GRAB
      </h1>
      <p style={{ color: "#999", fontSize: 14, margin: 0 }}>
        Paste a link. It downloads straight to the shared drive — nothing else to set up.
      </p>

      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
        placeholder="https://…"
        inputMode="url"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        disabled={busy}
        style={{
          fontSize: 16, // 16px+ stops iOS Safari auto-zooming into the field on focus
          padding: 14,
          background: "#161616",
          color: "var(--milk)",
          border: "1px solid var(--border)",
          borderRadius: 6,
        }}
      />

      <button
        type="button"
        onClick={() => void submit()}
        disabled={!url.trim() || busy}
        style={{
          fontSize: 16,
          padding: 16,
          background: busy ? "#333" : "var(--red)",
          color: "#fff",
          border: "none",
          borderRadius: 6,
          fontWeight: 700,
          letterSpacing: 1,
        }}
      >
        {status === "checking" ? "CHECKING…" : status === "working" ? "GRABBING…" : "GRAB"}
      </button>

      {message && (
        <div
          style={{
            fontSize: 14,
            color: status === "error" ? "var(--red)" : status === "done" ? "var(--acid)" : "#ccc",
          }}
        >
          {message}
          {status === "working" && pct != null && ` (${Math.round(pct)}%)`}
        </div>
      )}
    </main>
  );
}
