"use client";

import { useEffect, useMemo, useState } from "react";
import { groupParagraphs, type Segment } from "@/lib/paragraphs";
import { extractTopicSections } from "@/lib/highlights";
import { formatTc } from "@/lib/timecode";
import { agentHealth, agentSummarize, waitForJobResult } from "@/lib/agent";

interface Props {
  segments: Segment[];
  loaded: boolean;
  emptyMessage: string;
  onSeek: (seconds: number) => void;
}

/**
 * Key Moments has no generate button — deliberately. The sections are pure
 * synchronous math over the paragraphs the transcript already produced, so
 * there is nothing to wait for and nothing to ask permission for.
 *
 * The WRITTEN summaries are the slow part, and they run automatically too,
 * upgrading each row in place once the local agent returns them. Until then
 * (or forever, if the summariser isn't installed) the rows show distinctive
 * keyword labels, which is the documented fallback rather than a failure.
 */
export function KeyMomentsPanel({ segments, loaded, emptyMessage, onSeek }: Props) {
  const sections = useMemo(() => {
    if (!segments.length) return [];
    return extractTopicSections(groupParagraphs(segments));
  }, [segments]);

  // Identity of the section set, so summaries written for one video can never
  // paint onto another. Stored WITH the values rather than in a ref, so the
  // match can be evaluated during render without reading mutable state.
  const sectionKey =
    sections.length > 0
      ? `${sections.length}:${sections[0].start}:${sections[sections.length - 1].end}`
      : "";

  const [summaryState, setSummaryState] = useState<{
    key: string;
    values: Array<string | null>;
    status: string;
  }>({ key: "", values: [], status: "" });

  useEffect(() => {
    if (sections.length === 0) return;
    const key = `${sections.length}:${sections[0].start}:${sections[sections.length - 1].end}`;
    let cancelled = false;
    const note = (status: string) => {
      if (!cancelled) setSummaryState((s) => (s.key === key ? { ...s, status } : { key, values: [], status }));
    };

    (async () => {
      try {
        const health = await agentHealth();
        if (cancelled) return;
        if (!health.summarizer) {
          note("Keyword labels. For written summaries: pip install -r tools/requirements.txt");
          return;
        }
        note("Writing summaries locally… (first run downloads the model)");
        const { jobId } = await agentSummarize(sections.map((s) => s.text));
        const result = await waitForJobResult<{ summaries: Array<string | null> }>(jobId, note);
        if (cancelled) return;
        const values = result.summaries ?? [];
        setSummaryState({ key, values, status: values.some(Boolean) ? "" : "Showing keyword labels." });
      } catch {
        // The agent being down is not worth shouting about here — the keyword
        // labels are already on screen and still usable.
        note("Keyword labels — the local agent isn't running.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sections]);

  const shownSummaries = summaryState.key === sectionKey ? summaryState.values : [];
  const status = summaryState.key === sectionKey ? summaryState.status : "";

  const empty = !loaded
    ? emptyMessage
    : sections.length === 0
      ? "Not enough transcript here to find distinct moments."
      : "";

  return (
    <div className="panel flex h-full min-h-0 flex-col" style={{ padding: "16px 18px", gap: 10 }}>
      <span className="section-label">KEY MOMENTS</span>

      {sections.length > 0 && status && <span className="hint">{status}</span>}

      {empty ? (
        <span className="hint whitespace-pre-line">{empty}</span>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto" style={{ paddingTop: 6 }}>
          <div className="flex flex-col" style={{ gap: 2 }}>
            {sections.map((s, i) => (
              <div
                key={i}
                className="key-moment-row"
                title={`Jump to ${formatTc(s.start, 0)}`}
                onClick={() => onSeek(s.start)}
              >
                <span className="key-moment-stamp">{formatTc(s.start, 0)}</span>
                <span className="key-moment-text">{shownSummaries[i] || s.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
