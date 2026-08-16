"use client";

import { useState } from "react";
import { agentMediaUrl, AgentUnreachable } from "@/lib/agent";

interface Props {
  token: string;
  localPath: string;
  vertical: boolean;
}

/**
 * The video and DOWNLOAD button for a share link — split out as a client
 * component because both need agentMediaUrl(), which reads the viewer's OWN
 * agent address from their browser's localStorage. SharePage itself stays a
 * server component so a revoked/unknown token still 404s before any client
 * JS runs.
 *
 * Internal-only sharing (the current scope) means the viewer is a teammate
 * with their own agent running against the same shared drive — there is
 * nothing here for a truly external recipient with no agent at all.
 */
export function ShareClipPlayer({ token, localPath, vertical }: Props) {
  const [error, setError] = useState("");

  const download = async () => {
    setError("");
    try {
      const res = await fetch(`/api/share/${token}/download`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "link not found");
      // A plain navigation, not fetch: Content-Disposition: attachment is
      // what makes the browser save the file rather than open it, and that
      // only works for a real top-level request, not one drained by fetch.
      window.location.href = agentMediaUrl(body.localPath as string, { download: true });
    } catch (err) {
      setError(
        err instanceof AgentUnreachable
          ? "Can't reach your local agent — start it to download this clip."
          : err instanceof Error
            ? err.message
            : String(err),
      );
    }
  };

  return (
    <>
      <video
        src={agentMediaUrl(localPath)}
        controls
        playsInline
        preload="metadata"
        className="mb-8 w-full rounded-lg bg-black"
        style={{ maxWidth: vertical ? 380 : 760, maxHeight: "60vh" }}
      />

      <button
        type="button"
        onClick={() => void download()}
        className="rounded-full bg-neutral-100 px-8 py-3 font-medium text-neutral-900 transition-colors hover:bg-white"
      >
        Download
      </button>
      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
    </>
  );
}
