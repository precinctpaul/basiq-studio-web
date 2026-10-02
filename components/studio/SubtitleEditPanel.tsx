"use client";

import { useEffect, useRef } from "react";
import { formatTc } from "@/lib/timecode";
import { decodeEntities } from "@/lib/burn-subs";
import type { Segment } from "@/lib/paragraphs";

export type RowSaveState = "saving" | "saved" | "error";

interface Props {
  /** The transcript as loaded -- displayed and edited as a copy, never written back. */
  segments: Segment[];
  /** idx -> edited subtitle text (saved or still being typed). */
  edits: Record<number, string>;
  /** idx -> save state of that line, for the per-line indicator. */
  rowStatus: Record<number, RowSaveState>;
  /** The export's padded IN/OUT window in source seconds, or null with no marks set. */
  window: { start: number; end: number } | null;
  /** Live, on every keystroke -- drives the player preview. */
  onEdit: (idx: number, text: string) => void;
  /** Persist one line. Called automatically; repeat calls with unchanged text are no-ops. */
  onCommit: (idx: number, text: string) => void;
  /** Back to the transcript's own text. */
  onReset: (idx: number) => void;
  onSeek: (seconds: number) => void;
  status: string;
}

/** Quiet time after the last keystroke before a line saves itself. */
const AUTOSAVE_MS = 600;

const ROW_LABEL: Record<RowSaveState, string> = {
  saving: "Saving…",
  saved: "✓ Saved",
  error: "Not saved",
};

/**
 * SUBTITLES tab (shown while SUBS is ON): the transcript lines inside the
 * clip, editable as SUBTITLE text only. Fixes go to subtitle_edits (per
 * video) and are overlaid at preview/export time; the transcript itself is
 * never modified.
 *
 * Saving is automatic -- shortly after typing stops, on leaving the box, or
 * on Enter -- so there is no "did I need to press something?" step.
 */
export function SubtitleEditPanel({
  segments,
  edits,
  rowStatus,
  window,
  onEdit,
  onCommit,
  onReset,
  onSeek,
  status,
}: Props) {
  // Lines typed into but not yet saved: idx -> pending timer + latest text.
  const pending = useRef(new Map<number, { timer: ReturnType<typeof setTimeout>; text: string }>());
  const commitRef = useRef(onCommit);
  useEffect(() => {
    commitRef.current = onCommit;
  }, [onCommit]);

  // Turning SUBS off unmounts this panel; whatever was still waiting to
  // autosave is saved right then rather than dropped.
  useEffect(() => {
    const waiting = pending.current;
    return () => {
      waiting.forEach(({ timer, text }, idx) => {
        clearTimeout(timer);
        commitRef.current(idx, text);
      });
      waiting.clear();
    };
  }, []);

  const saveNow = (idx: number, text: string) => {
    const p = pending.current.get(idx);
    if (p) clearTimeout(p.timer);
    pending.current.delete(idx);
    commitRef.current(idx, text);
  };

  const scheduleSave = (idx: number, text: string) => {
    const p = pending.current.get(idx);
    if (p) clearTimeout(p.timer);
    pending.current.set(idx, { timer: setTimeout(() => saveNow(idx, text), AUTOSAVE_MS), text });
  };

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
            // Shown decoded (">>", not "&gt;&gt;"); a line only counts as
            // edited when it differs from that.
            const original = decodeEntities(s.text);
            const edited = edits[s.idx] !== undefined && edits[s.idx] !== original;
            const value = edits[s.idx] ?? original;
            const state = rowStatus[s.idx];
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
                  {state && (
                    <span className="subs-edit-state" data-state={state}>
                      {ROW_LABEL[state]}
                    </span>
                  )}
                  <span className="flex-1" />
                  {edited && (
                    <button
                      type="button"
                      className="btn-ghost"
                      title={`Back to the transcript's text: "${original}"`}
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
                  onChange={(e) => {
                    onEdit(s.idx, e.target.value);
                    scheduleSave(s.idx, e.target.value);
                  }}
                  onBlur={(e) => saveNow(s.idx, e.target.value)}
                  onKeyDown={(e) => {
                    // Enter finishes the line (and saves via blur) rather than
                    // inserting a line break the subtitles would ignore anyway.
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      e.currentTarget.blur();
                    }
                  }}
                />
              </div>
            );
          })
        )}
      </div>
      <span className="transcript-hint">
        Changes save automatically · Add a period to split a subtitle · type &gt;&gt; for a new speaker
      </span>
    </div>
  );
}
