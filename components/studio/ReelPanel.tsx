"use client";

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
  collapsed,
  onToggleCollapsed,
  height,
}: Props) {
  const activeReel = reels.find((r) => r.id === activeReelId) ?? null;

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
        </div>

        <div className="reel-strip">
          {!activeReelId ? (
            <div className="status-muted" style={{ padding: 12 }}>
              Pick or create a reel to start building.
            </div>
          ) : segments.length === 0 ? (
            <div className="status-muted" style={{ padding: 12 }}>
              No clips yet — mark IN/OUT on a video and hit ADD TO REEL.
            </div>
          ) : (
            segments.map((s, i) => (
              <div key={s.id} className="reel-block">
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
