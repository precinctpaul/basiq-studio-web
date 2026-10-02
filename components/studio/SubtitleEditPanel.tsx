"use client";

import { formatTc } from "@/lib/timecode";
import type { Segment } from "@/lib/paragraphs";

interface Props {
  /** The transcript as loaded -- displayed and edited as a copy, never written back. */
  segments: Segment[];
  /** idx -> edited subtitle text (saved or still being typed). */
  edits: Record<number, string>;
  /** The export's padded IN/OUT window in source seconds, or null with no marks set. */
  window: { start: number; end: number } | null;
  /** Live, on every keystroke -- drives the player preview. */
  onEdit: (idx: number, text: string) => void;
  /** Persist one line (on blur). */
  onCommit: (idx: number, text: string) => void;
  /** Back to the transcript's own text. */
  onReset: (idx: number) => void;
  onSeek: (seconds: number) => void;
  status: string;
}

/**
 * SUBTITLES tab (shown while SUBS is ON): the transcript lines inside the
 * clip, editable as SUBTITLE text only. Fixes go to subtitle_edits (per
 * video) and are overlaid at preview/export time; the transcript itself is
 * never modified.
 */
export function SubtitleEditPanel({ segments, edits, window, onEdit, onCommit, onReset, onSeek, status }: Props) {
  const rows = window
    ? segments.filter(
        (s): s is Segment & { idx: number } =>
          s.idx !== undefined && s.end > window.start && s.start < window.end && s.text.trim() !== "",
      )
    : [];

  return (
    <div className="panel flex h-full min-h-0 flex-col" style={{ padding: "16px 18px", gap: 12 }}>
      <div className="flex items-center">
        <span className="section-label">CLIP SUBTITLES</span>
        <span className="flex-1" />
        <span className="status-muted">{status}</span>
      </div>
      <p className="subs-edit-banner">
        Edits change this video&apos;s subtitles only. The transcript is not modified.
      </p>

      <div className="transcript-surface min-h-0 flex-1 overflow-y-auto">
        {!window ? (
          <p className="hint">Set IN and OUT to edit this clip&apos;s subtitles.</p>
        ) : rows.length === 0 ? (
          <p className="hint">No transcript text between IN and OUT.</p>
        ) : (
          rows.map((s) => {
            const edited = edits[s.idx] !== undefined && edits[s.idx] !== s.text;
            const value = edits[s.idx] ?? s.text;
            return (
              <div key={s.idx} className="subs-edit-row">
                <div className="flex items-center" style={{ gap: 8 }}>
                  <button
                    type="button"
                    className="key-moment-stamp subs-edit-stamp"
                    title="Jump here"
                    onClick={() => onSeek(s.start)}
                  >
                    [{formatTc(s.start).slice(0, 8)}]
                  </button>
                  {edited && <span className="subs-edit-flag">EDITED</span>}
                  <span className="flex-1" />
                  {edited && (
                    <button
                      type="button"
                      className="btn-ghost"
                      title={`Back to the transcript's text: "${s.text}"`}
                      onClick={() => onReset(s.idx)}
                    >
                      RESET
                    </button>
                  )}
                </div>
                <textarea
                  className="field subs-edit-field"
                  value={value}
                  rows={Math.max(1, Math.ceil(value.length / 42))}
                  spellCheck
                  onChange={(e) => onEdit(s.idx, e.target.value)}
                  onBlur={(e) => onCommit(s.idx, e.target.value)}
                />
              </div>
            );
          })
        )}
      </div>
      <span className="transcript-hint">
        Add a period to split a subtitle · type &gt;&gt; for a new speaker
      </span>
    </div>
  );
}
