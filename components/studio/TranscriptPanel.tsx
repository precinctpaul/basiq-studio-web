"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { groupParagraphs, type Segment } from "@/lib/paragraphs";
import { formatTc } from "@/lib/timecode";

/** Cap from transcript_panel._highlight_matches — a 5-hour hearing can match
 *  a common word thousands of times and painting them all locks the UI. */
const MATCH_CAP = 800;
/** Debounce on drag-selection before it commits to IN/OUT (280ms in the original). */
const SELECTION_DEBOUNCE_MS = 280;

interface Props {
  segments: Segment[];
  loaded: boolean;
  emptyMessage: string;
  position: number;
  onSeek: (seconds: number) => void;
  onRangeSelected: (start: number, end: number) => void;
}

export function TranscriptPanel({
  segments,
  loaded,
  emptyMessage,
  position,
  onSeek,
  onRangeSelected,
}: Props) {
  const [search, setSearch] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const viewRef = useRef<HTMLDivElement>(null);
  const selTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const paragraphs = useMemo(() => groupParagraphs(segments), [segments]);

  const meta = useMemo(() => {
    if (!paragraphs.length) return "";
    const total = segments.length ? segments[segments.length - 1].end : 0;
    return `${paragraphs.length} paragraphs · ${segments.length} segments · ${formatTc(total)}`;
  }, [paragraphs, segments]);

  const term = search.trim();
  const matchCount = useMemo(() => {
    if (term.length < 2) return 0;
    const needle = term.toLowerCase();
    let count = 0;
    for (const p of paragraphs) {
      const hay = p.text.toLowerCase();
      let from = 0;
      while (count < MATCH_CAP) {
        const at = hay.indexOf(needle, from);
        if (at === -1) break;
        count++;
        from = at + needle.length;
      }
      if (count >= MATCH_CAP) break;
    }
    return count;
  }, [term, paragraphs]);

  /** Paragraph currently under the playhead — tinted blue at ~20% like the original. */
  const activePara = useMemo(
    () => paragraphs.findIndex((p) => position >= p.start && position <= p.end),
    [paragraphs, position],
  );

  // Selection -> IN/OUT. Reading which SEGMENTS the selection touches (via
  // data attributes on their spans) rather than character offsets, which is
  // what the Qt version had to do with its _spans/_starts bisect tables.
  const commitSelection = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !viewRef.current) return;
    const range = sel.getRangeAt(0);
    if (!viewRef.current.contains(range.commonAncestorContainer)) return;

    const touched: number[] = [];
    for (const el of viewRef.current.querySelectorAll<HTMLElement>("[data-seg]")) {
      if (range.intersectsNode(el)) {
        const idx = Number(el.dataset.seg);
        if (!Number.isNaN(idx)) touched.push(idx);
      }
    }
    if (!touched.length) return;
    const first = segments[Math.min(...touched)];
    const last = segments[Math.max(...touched)];
    if (!first || !last) return;
    const start = Math.min(first.start, last.start);
    let end = Math.max(first.end, last.end);
    if (end <= start) end = start + 0.5; // minimum 0.5s range, as in the original
    onRangeSelected(start, end);
  }, [segments, onRangeSelected]);

  useEffect(() => {
    const onSelectionChange = () => {
      if (selTimer.current) clearTimeout(selTimer.current);
      selTimer.current = setTimeout(commitSelection, SELECTION_DEBOUNCE_MS);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      if (selTimer.current) clearTimeout(selTimer.current);
    };
  }, [commitSelection]);

  const jumpToMatch = useCallback(
    (dir: 1 | -1) => {
      if (!matchCount) return;
      const next = (matchIndex + dir + matchCount) % matchCount; // wraps, like find_next/find_prev
      setMatchIndex(next);
      const nodes = viewRef.current?.querySelectorAll<HTMLElement>("[data-match]");
      nodes?.[next]?.scrollIntoView({ block: "center", behavior: "smooth" });
    },
    [matchCount, matchIndex],
  );

  /** Split a paragraph's text on the search term so matches can be painted acid-on-ink. */
  const renderText = (text: string, segIndex: number) => {
    if (term.length < 2) return <span data-seg={segIndex}>{text}</span>;
    const needle = term.toLowerCase();
    const parts: React.ReactNode[] = [];
    let from = 0;
    let key = 0;
    const hay = text.toLowerCase();
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at === -1) {
        parts.push(text.slice(from));
        break;
      }
      if (at > from) parts.push(text.slice(from, at));
      parts.push(
        <mark
          key={key++}
          data-match=""
          style={{ background: "var(--acid)", color: "var(--ink)" }}
        >
          {text.slice(at, at + term.length)}
        </mark>,
      );
      from = at + term.length;
    }
    return <span data-seg={segIndex}>{parts}</span>;
  };

  let segCursor = 0;

  return (
    <div className="panel flex h-full min-h-0 flex-col" style={{ padding: "16px 18px", gap: 12 }}>
      <div className="flex items-center">
        <span className="section-label">SYNCHRONISED TRANSCRIPT</span>
        <span className="flex-1" />
        <span className="status-muted">{meta}</span>
      </div>

      <div className="flex items-center" style={{ gap: 8 }}>
        <input
          type="text"
          className="field flex-1"
          placeholder="Search transcript…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setMatchIndex(0);
          }}
          onKeyDown={(e) => e.key === "Enter" && jumpToMatch(1)}
        />
        <button type="button" className="btn-ghost" style={{ width: 44 }} onClick={() => jumpToMatch(-1)}>
          ◀
        </button>
        <button type="button" className="btn-ghost" style={{ width: 44 }} onClick={() => jumpToMatch(1)}>
          ▶
        </button>
        <span className="status-muted whitespace-nowrap">
          {term.length >= 2 ? `${matchCount} hit${matchCount !== 1 ? "s" : ""}` : ""}
        </span>
      </div>

      <div ref={viewRef} className="transcript-surface min-h-0 flex-1 overflow-y-auto">
        {!loaded || paragraphs.length === 0 ? (
          <p className="whitespace-pre-line" style={{ color: "var(--muted)" }}>
            {emptyMessage}
          </p>
        ) : (
          paragraphs.map((p, i) => {
            const startSeg = segCursor;
            segCursor += p.segments.length;
            return (
              <p
                key={i}
                style={{
                  marginBottom: "1em",
                  background: i === activePara ? "rgba(60, 119, 187, 0.20)" : undefined,
                }}
                onDoubleClick={() => onSeek(Math.max(0, p.start))}
              >
                <span
                  className="key-moment-stamp"
                  style={{ cursor: "pointer" }}
                  onDoubleClick={() => onSeek(Math.max(0, p.start))}
                >
                  [{formatTc(p.start, 0)}]{"  "}
                </span>
                {p.segments.map((seg, j) => (
                  <span key={j}>{renderText(seg.text + " ", startSeg + j)}</span>
                ))}
              </p>
            );
          })
        )}
      </div>

      <span className="transcript-hint">
        Double-click to jump{"  ·  "}Highlight text to set IN / OUT{"  ·  "}Ctrl+E to export
      </span>
    </div>
  );
}
