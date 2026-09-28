"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Same as PlayerPanel's ASPECT_OPTIONS short labels -- kept as its own tiny
 *  map rather than importing PlayerPanel's (which also carries player-only
 *  concerns) just for three strings. */
const ASPECT_SHORT: Record<string, string> = {
  native: "16:9",
  vertical_crop: "9:16 Crop",
  vertical_blur: "9:16 Blur",
};

/** Same shrink-to-handle-only pattern as QueuePanel's COLLAPSED_HEIGHT. */
const COLLAPSED_HEIGHT = 34;

export interface ReelSummary {
  id: string;
  title: string;
  canvas_width: number;
  canvas_height: number;
  segment_count: number;
}

export interface ReelSegmentRow {
  id: number;
  video_id: string;
  position: number;
  in_point: number;
  out_point: number;
  aspect_mode: string;
  videos: { id: string; title: string; duration_seconds: number } | null;
}

interface Props {
  reels: ReelSummary[];
  activeReelId: string | null;
  onSelectReel: (id: string) => void;
  onCreateReel: () => void;
  segments: ReelSegmentRow[];
  onRemoveSegment: (segmentId: number) => void;
  /** Drag-and-drop finished with a new order -- the full id list, same
   *  shape the PATCH .../segments reorder endpoint expects. Not called for
   *  every intermediate drag frame, only once on drop, and only if the
   *  order actually changed. */
  onReorder: (order: number[]) => void;
  onExportReel: () => void;
  exporting: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Ignored while collapsed -- the panel uses COLLAPSED_HEIGHT instead. */
  height?: number;
}

export function ReelPanel({
  reels,
  activeReelId,
  onSelectReel,
  onCreateReel,
  segments,
  onRemoveSegment,
  onReorder,
  onExportReel,
  exporting,
  collapsed,
  onToggleCollapsed,
  height,
}: Props) {
  const activeReel = reels.find((r) => r.id === activeReelId) ?? null;

  // --- Drag-to-reorder --------------------------------------------------
  // Same POINTER-CAPTURE mechanism Splitter.tsx uses (pointerdown sets
  // capture on the grip itself, so pointermove/pointerup keep firing on it
  // even once the cursor has outrun the block) rather than the native HTML5
  // drag-and-drop API, which needs draggable=true + dataTransfer, has no
  // real touch support, and fights custom drag visuals. What's different
  // from Splitter: that's a 1D resize-by-DELTA problem; this is a
  // reorder-by-INDEX problem, so the geometry (which slot is the pointer
  // over right now) has to be worked out here instead of just reporting a
  // delta upward.
  const blockRefs = useRef(new Map<number, HTMLDivElement>());
  const draggingIdRef = useRef<number | null>(null);
  const originalOrderRef = useRef<number[]>([]);
  const [dragOrder, setDragOrder] = useState<number[] | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);

  const byId = useMemo(() => new Map(segments.map((s) => [s.id, s])), [segments]);

  // The order actually rendered: live-reordered while dragging, otherwise
  // exactly what the server last returned (position order).
  const displayOrder = dragOrder ?? segments.map((s) => s.id);
  const displaySegments = displayOrder.map((id) => byId.get(id)).filter((s): s is ReelSegmentRow => !!s);

  const clearDragState = useCallback(() => {
    draggingIdRef.current = null;
    setDraggingId(null);
    setDragOrder(null);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }, []);

  const onGripPointerDown = useCallback(
    (id: number, e: React.PointerEvent<HTMLButtonElement>) => {
      const order = segments.map((s) => s.id);
      draggingIdRef.current = id;
      originalOrderRef.current = order;
      setDraggingId(id);
      setDragOrder(order);
      e.currentTarget.setPointerCapture(e.pointerId);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "grabbing";
    },
    [segments],
  );

  const onGripPointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const dragging = draggingIdRef.current;
    if (dragging === null) return;
    const clientX = e.clientX;

    setDragOrder((current) => {
      const order = current ?? originalOrderRef.current;
      // First block whose midpoint sits to the right of the pointer -- "the
      // dragged block belongs just before this one." Falls through to
      // order.length (append at the end) if the pointer is past everything.
      let targetIndex = order.length;
      for (let i = 0; i < order.length; i++) {
        const el = blockRefs.current.get(order[i]);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (clientX < rect.left + rect.width / 2) {
          targetIndex = i;
          break;
        }
      }
      const beforeId = order[targetIndex];
      const without = order.filter((id) => id !== dragging);
      const insertAt = beforeId === undefined ? without.length : without.indexOf(beforeId);
      if (insertAt === -1) return current;
      without.splice(insertAt, 0, dragging);
      return without;
    });
  }, []);

  const onGripPointerUp = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (draggingIdRef.current === null) return;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      const finalOrder = dragOrder;
      const changed =
        finalOrder &&
        (finalOrder.length !== originalOrderRef.current.length ||
          finalOrder.some((id, i) => id !== originalOrderRef.current[i]));
      clearDragState();
      if (changed && finalOrder) onReorder(finalOrder);
    },
    [dragOrder, onReorder, clearDragState],
  );

  // Same safety net as Splitter: a pointerup/pointercancel that lands
  // outside the grip (or a lost capture) must still clear drag state,
  // rather than leaving the strip stuck mid-reorder with the grabbing
  // cursor still on.
  useEffect(() => {
    const clear = () => {
      if (draggingIdRef.current === null) return;
      clearDragState();
    };
    window.addEventListener("pointercancel", clear);
    return () => window.removeEventListener("pointercancel", clear);
  }, [clearDragState]);

  return (
    <div className="flex flex-col" style={{ height: collapsed ? COLLAPSED_HEIGHT : height, flexShrink: 0 }}>
      {/* Drawer handle -- same shape as QueuePanel's: always visible, a
          caret to open/close, one line of status while collapsed. */}
      <div className="flex items-center" style={{ padding: "4px 8px 4px 12px", gap: 8 }}>
        <button
          type="button"
          className="btn-ghost"
          onClick={onToggleCollapsed}
          style={{ padding: "2px 6px" }}
          title={collapsed ? "Open reel timeline" : "Collapse reel timeline"}
          aria-expanded={!collapsed}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <span className="section-label">
          REEL{activeReel ? ` · ${activeReel.title}` : ""} ·{" "}
          {segments.length > 0 ? `${segments.length} clip${segments.length === 1 ? "" : "s"}` : "empty"}
        </span>
      </div>

      <div className="panel flex flex-col" hidden={collapsed} style={{ padding: "10px 14px 12px", gap: 8 }}>
        <div className="flex items-center" style={{ gap: 8 }}>
          <span className="section-label">TIMELINE</span>
          <select
            className="select"
            value={activeReelId ?? ""}
            onChange={(e) => onSelectReel(e.target.value)}
            title="Which reel ADD TO REEL appends to"
          >
            <option value="" disabled>
              Select a reel…
            </option>
            {reels.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title} ({r.segment_count})
              </option>
            ))}
          </select>
          <button type="button" className="btn-ghost" onClick={onCreateReel}>
            + NEW REEL
          </button>
          <span className="flex-1" />
          <button
            type="button"
            className="btn-export"
            disabled={!activeReelId || segments.length === 0 || exporting}
            title={
              !activeReelId
                ? "Pick or create a reel first"
                : segments.length === 0
                ? "Add at least one clip first"
                : "Cut, normalize, and join every segment into one file"
            }
            onClick={onExportReel}
          >
            {exporting ? "EXPORTING…" : "EXPORT REEL"}
          </button>
        </div>

        <div className="reel-strip">
          {!activeReelId ? (
            <div className="status-muted" style={{ padding: 12 }}>
              Pick or create a reel to start building.
            </div>
          ) : displaySegments.length === 0 ? (
            <div className="status-muted" style={{ padding: 12 }}>
              No clips yet — mark IN/OUT on a video and hit ADD TO REEL.
            </div>
          ) : (
            displaySegments.map((s, i) => (
              <div
                key={s.id}
                ref={(el) => {
                  if (el) blockRefs.current.set(s.id, el);
                  else blockRefs.current.delete(s.id);
                }}
                className="reel-block"
                data-dragging={draggingId === s.id ? "true" : undefined}
              >
                <button
                  type="button"
                  className="reel-block-grip"
                  title="Drag to reorder"
                  onPointerDown={(e) => onGripPointerDown(s.id, e)}
                  onPointerMove={onGripPointerMove}
                  onPointerUp={onGripPointerUp}
                  onPointerCancel={onGripPointerUp}
                >
                  ⠿
                </button>
                <button
                  type="button"
                  className="reel-block-remove"
                  onClick={() => onRemoveSegment(s.id)}
                  title="Remove from reel"
                >
                  ×
                </button>
                <span className="reel-block-index">{i + 1}</span>
                <span className="reel-block-title" title={s.videos?.title}>
                  {s.videos?.title ?? "Unknown video"}
                </span>
                <span className="reel-block-duration">{(s.out_point - s.in_point).toFixed(1)}s</span>
                <span className="reel-block-aspect">{ASPECT_SHORT[s.aspect_mode] ?? s.aspect_mode}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
