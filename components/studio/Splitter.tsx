"use client";

import { useCallback, useEffect, useRef } from "react";

interface Props {
  /** "vertical" = a vertical bar dragged left/right between columns. */
  orientation: "vertical" | "horizontal";
  onDrag: (deltaPx: number) => void;
  onDoubleClick?: () => void;
  title?: string;
}

/**
 * A drag handle between two panes.
 *
 * Reports a DELTA rather than an absolute position so the parent stays the
 * single owner of the layout arithmetic — it knows the clamps and the other
 * panes' sizes, and a splitter that tried to compute a final size would have
 * to duplicate all of that.
 *
 * Pointer capture (rather than window listeners) means the drag keeps
 * tracking when the cursor outruns the 6px handle, which it always does.
 */
export function Splitter({ orientation, onDrag, onDoubleClick, title }: Props) {
  const dragging = useRef(false);
  const last = useRef(0);
  const vertical = orientation === "vertical";

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      dragging.current = true;
      last.current = vertical ? e.clientX : e.clientY;
      e.currentTarget.setPointerCapture(e.pointerId);
      // Without this the drag selects text across the whole app.
      document.body.style.userSelect = "none";
      document.body.style.cursor = vertical ? "col-resize" : "row-resize";
    },
    [vertical],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      const now = vertical ? e.clientX : e.clientY;
      const delta = now - last.current;
      if (delta === 0) return;
      last.current = now;
      onDrag(delta);
    },
    [vertical, onDrag],
  );

  const stop = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }, []);

  // A pointerup that lands outside the handle (or a lost capture) must still
  // clear the global cursor/selection styles.
  useEffect(() => {
    const clear = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    window.addEventListener("pointerup", clear);
    window.addEventListener("pointercancel", clear);
    return () => {
      window.removeEventListener("pointerup", clear);
      window.removeEventListener("pointercancel", clear);
    };
  }, []);

  return (
    <div
      className={vertical ? "splitter splitter-v" : "splitter splitter-h"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={onDoubleClick}
      title={title ?? "Drag to resize  ·  double-click to reset"}
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
    >
      <span className="splitter-grip" />
    </div>
  );
}
