"use client";

import { useCallback, useEffect, useState } from "react";
import { formatTc } from "@/lib/timecode";
import { agentHealth, agentSummarize, waitForJobResult } from "@/lib/agent";

export interface KeyMoment {
  idx: number;
  start_seconds: number;
  end_seconds: number;
  label: string;
  summary: string | null;
}

interface Props {
  videoId: string | null;
  /** Whether the video has a ready transcript to section at all. */
  hasTranscript: boolean;
  emptyMessage: string;
  onSeek: (seconds: number) => void;
}

/**
 * Key Moments are LOADED, not derived on view.
 *
 * They used to be recomputed in the browser every time this tab was shown,
 * so every visit replayed the pipeline in front of the operator — keyword
 * labels, a pause, then the sentences — and switching away and back started
 * it over. Now the moments are computed and summarised once, stored, and
 * every later visit is a single GET that paints finished text immediately.
 *
 * There is still no generate button: the first view of a transcribed video
 * builds them automatically, because there is nothing to decide.
 */
export function KeyMomentsPanel({ videoId, hasTranscript, emptyMessage, onSeek }: Props) {
  // The parent keys this component by videoId, so state is naturally fresh per
  // video and there is nothing to reset when the selection changes. Switching
  // TABS does not remount it, which is what keeps the moments on screen.
  const [moments, setMoments] = useState<KeyMoment[]>([]);
  const [status, setStatus] = useState("");

  const build = useCallback(async (id: string) => {
    // 1. Section the transcript and store the moments (labels immediately).
    setStatus("Finding topic sections…");
    const res = await fetch(`/api/videos/${id}/key-moments`, { method: "POST" });
    const body = await res.json();
    if (!res.ok) {
      setStatus(body.error ?? "could not build key moments");
      return;
    }
    setMoments(body.keyMoments ?? []);

    // 2. Upgrade the labels to written headlines, if the agent can.
    const texts: string[] = body.texts ?? [];
    if (texts.length === 0) return;
    try {
      const health = await agentHealth();
      if (!health.summarizer) {
        setStatus("Keyword labels. For written summaries: pip install -r tools/requirements.txt");
        return;
      }
      setStatus("Writing summaries locally…");
      const { jobId } = await agentSummarize(texts);
      const result = await waitForJobResult<{ summaries: Array<string | null> }>(
        jobId,
        (s) => setStatus(s),
      );
      const patched = await fetch(`/api/videos/${id}/key-moments`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summaries: result.summaries ?? [] }),
      });
      const patchedBody = await patched.json();
      if (patched.ok) setMoments(patchedBody.keyMoments ?? []);
      setStatus("");
    } catch {
      // The agent being down is not worth shouting about — the keyword labels
      // are already on screen and still usable.
      setStatus("Keyword labels — the local agent isn't running.");
    }
  }, []);

  useEffect(() => {
    if (!videoId || !hasTranscript) return;
    let cancelled = false;

    (async () => {
      const res = await fetch(`/api/videos/${videoId}/key-moments`);
      const body = await res.json().catch(() => ({}));
      if (cancelled) return;

      const stored: KeyMoment[] = body.keyMoments ?? [];
      if (stored.length > 0) {
        setMoments(stored);
        // Summaries can be missing if an earlier run couldn't reach the agent;
        // finish the job rather than leaving keyword labels forever.
        if (!stored.some((m) => m.summary)) await build(videoId);
        return;
      }
      await build(videoId);
    })();

    return () => {
      cancelled = true;
    };
  }, [videoId, hasTranscript, build]);

  const empty = !hasTranscript
    ? emptyMessage
    : moments.length === 0 && !status
      ? "Not enough transcript here to find distinct moments."
      : "";

  return (
    <div className="panel flex h-full min-h-0 flex-col" style={{ padding: "16px 18px", gap: 10 }}>
      <span className="section-label">KEY MOMENTS</span>

      {status && <span className="hint">{status}</span>}

      {empty ? (
        <span className="hint whitespace-pre-line">{empty}</span>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto" style={{ paddingTop: 6 }}>
          <div className="flex flex-col" style={{ gap: 2 }}>
            {moments.map((m) => (
              <div
                key={m.idx}
                className="key-moment-row"
                title={`Jump to ${formatTc(m.start_seconds, 0)}`}
                onClick={() => onSeek(m.start_seconds)}
              >
                <span className="key-moment-stamp">{formatTc(m.start_seconds, 0)}</span>
                <span className="key-moment-text">{m.summary || m.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
