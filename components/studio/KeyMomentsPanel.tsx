"use client";

import { useMemo } from "react";
import { groupParagraphs, type Segment } from "@/lib/paragraphs";
import { extractTopicSections } from "@/lib/highlights";
import { formatTc } from "@/lib/timecode";

interface Props {
  segments: Segment[];
  loaded: boolean;
  emptyMessage: string;
  onSeek: (seconds: number) => void;
}

/**
 * Key Moments has no generate button — deliberately. In the desktop app the
 * list is produced automatically from the same paragraph list the transcript
 * just parsed (key_moments_panel.load), and extract_topic_sections is pure
 * synchronous math with no model behind it, so there is nothing to wait for
 * and nothing to ask permission for. Same here: it recomputes from segments.
 *
 * The desktop build then upgrades each keyword label into a written sentence
 * via a local ~1.2GB summarizer when one is installed, falling back to these
 * keyword labels when it isn't. That fallback is what ships here; the hint
 * below says so in the app's own words rather than pretending the labels are
 * the finished feature.
 */
export function KeyMomentsPanel({ segments, loaded, emptyMessage, onSeek }: Props) {
  const sections = useMemo(() => {
    if (!segments.length) return [];
    return extractTopicSections(groupParagraphs(segments));
  }, [segments]);

  const empty = !loaded
    ? emptyMessage
    : sections.length === 0
      ? "Not enough transcript here to find distinct moments."
      : "";

  return (
    <div className="panel flex h-full min-h-0 flex-col" style={{ padding: "16px 18px", gap: 10 }}>
      <span className="section-label">KEY MOMENTS</span>

      {sections.length > 0 && (
        <span className="hint">
          Keyword labels. For written summaries, install the local model: pip install torch
          transformers
        </span>
      )}

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
                <span className="key-moment-text">{s.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
