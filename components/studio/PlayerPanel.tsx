"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatTc, parseTc } from "@/lib/timecode";
import { cropGeometry } from "@/lib/crop";

/** ASPECT_SHORT_LABELS index-aligned with ASPECT_MODES, app/config.py:277-279 */
const ASPECT_OPTIONS = [
  { short: "16:9 Native", mode: "native" },
  { short: "9:16 Crop", mode: "vertical_crop" },
  { short: "9:16 Blur", mode: "vertical_blur" },
] as const;

/** CROP_BORDER_PX from app/ui/player_panel.py — the guide's stroke weight. */
const CROP_BORDER_PX = 3;

export interface PlayerMedia {
  id: string;
  title: string;
  playbackUrl: string;
  width: number;
  height: number;
  duration_seconds: number;
  /**
   * A live capture in progress. Its bytes are MPEG-TS, which Chrome's
   * <video> element cannot play regardless of playbackUrl — that is why the
   * recording is remuxed to MP4 once it stops, not a bug to work around here.
   * Clipping still works during this state: IN/OUT come from selecting
   * transcript text, never from scrubbing this player.
   */
  isRecording?: boolean;
}

interface Props {
  media: PlayerMedia | null;
  inPoint: number;
  outPoint: number;
  onMarkIn: (seconds: number) => void;
  onMarkOut: (seconds: number) => void;
  onClearMarks: () => void;
  aspectMode: string;
  onAspectChange: (mode: string) => void;
  onExport: (cropOffsetX: number, cropOffsetY: number) => void;
  exporting: boolean;
  /** Imperative seek target pushed from the transcript / key moments panels. */
  seekTo: { seconds: number; token: number } | null;
  /** Bumped when the library row is double-clicked: load, then play. */
  playToken?: number;
  padSeconds?: number;
  /** Captions are generated from the transcript — see /api/videos/[id]/captions. */
  captionsUrl?: string | null;
  captionsOn?: boolean;
  onToggleCaptions?: () => void;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function PlayerPanel({
  media,
  inPoint,
  outPoint,
  onMarkIn,
  onMarkOut,
  onClearMarks,
  aspectMode,
  onAspectChange,
  onExport,
  exporting,
  seekTo,
  playToken = 0,
  padSeconds = 4.0,
  captionsUrl = null,
  captionsOn = false,
  onToggleCaptions,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const bgVideoRef = useRef<HTMLVideoElement>(null);
  
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const hasCaptions = Boolean(captionsUrl);

  // Crop overlay dragging states
  const [cropPanX, setCropPanX] = useState(0);
  const [cropPanY, setCropPanY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0, time: 0 });

  // Reset crop pan whenever a new video is loaded
  useEffect(() => {
    setCropPanX(0);
    setCropPanY(0);
  }, [media?.id]);

  // The timecode fields show the authoritative mark UNLESS the operator is
  // mid-edit, in which case their half-typed text wins until they commit.
  // Derived at render rather than mirrored into state by an effect: a mirror
  // would repaint the old value for one frame every time a transcript
  // selection moved the marks, which is exactly the flicker this avoids.
  const [inDraft, setInDraft] = useState<string | null>(null);
  const [outDraft, setOutDraft] = useState<string | null>(null);
  const inText = inDraft ?? formatTc(inPoint);
  const outText = outDraft ?? formatTc(outPoint);

  useEffect(() => {
    if (!seekTo || !videoRef.current) return;
    const target = Math.max(0, seekTo.seconds);
    videoRef.current.currentTime = target;
    if (bgVideoRef.current) bgVideoRef.current.currentTime = target;
    void videoRef.current.play().catch(() => {});
  }, [seekTo]);

  // Double-click in the library. The token is bumped in the same commit that
  // swaps the source, so the element is usually still loading when this runs —
  // calling play() on a src with no data would reject and silently do nothing.
  // Waiting for `canplay` covers the swap; readyState covers double-clicking
  // the row that is already loaded.
  useEffect(() => {
    if (!playToken) return;
    const v = videoRef.current;
    if (!v) return;
    const go = () => void v.play().catch(() => {});
    if (v.readyState >= 2) go();
    else v.addEventListener("canplay", go, { once: true });
    return () => v.removeEventListener("canplay", go);
  }, [playToken]);

  // Captions are toggled by setting the track's mode, not by re-rendering the
  // <track> element: `default` is only consulted when the media element first
  // loads its tracks, so flipping it later does nothing at all.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const apply = () => {
      for (const track of Array.from(v.textTracks)) {
        track.mode = captionsOn ? "showing" : "hidden";
      }
    };
    apply();
    // The track list is populated asynchronously after the source loads.
    v.textTracks.addEventListener?.("addtrack", apply);
    return () => v.textTracks.removeEventListener?.("addtrack", apply);
  }, [captionsOn, captionsUrl]);

  const nudge = useCallback((ms: number) => {
    const v = videoRef.current;
    if (v) {
      const target = Math.max(0, v.currentTime + ms / 1000);
      v.currentTime = target;
      if (bgVideoRef.current) bgVideoRef.current.currentTime = target;
    }
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((m) => !m);
  }, []);

  const seekSeconds = useCallback((s: number) => {
    const v = videoRef.current;
    if (v) {
      const target = Math.max(0, s);
      v.currentTime = target;
      if (bgVideoRef.current) bgVideoRef.current.currentTime = target;
    }
  }, []);

  // Keyboard map from main_window._install_shortcuts: Space play/pause (but a
  // focused text field keeps its space), I/O marks, J/L +-5s, ,/. +-40ms
  // (~1 frame at 25fps), Ctrl+E export.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (e.ctrlKey && (e.key === "e" || e.key === "E")) {
        e.preventDefault();
        onExport(cropPanX, cropPanY);
        return;
      }
      if (typing) return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "i":
        case "I":
          onMarkIn(videoRef.current?.currentTime ?? 0);
          break;
        case "o":
        case "O":
          onMarkOut(videoRef.current?.currentTime ?? 0);
          break;
        case "j":
        case "J":
          nudge(-5000);
          break;
        case "l":
        case "L":
          nudge(5000);
          break;
        case ",":
          nudge(-40);
          break;
        case ".":
          nudge(40);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, nudge, onMarkIn, onMarkOut, onExport, cropPanX, cropPanY]);

  const commitIn = () => {
    onMarkIn(parseTc(inText));
    setInDraft(null);
  };
  const commitOut = () => {
    onMarkOut(parseTc(outText));
    setOutDraft(null);
  };

  const selLen = Math.max(0, outPoint - inPoint);
  const durationHint =
    outPoint > inPoint
      ? `${selLen.toFixed(1)}s  →  ${(selLen + padSeconds).toFixed(1)}s padded`
      : "";

  const stateLabel = media
    ? media.title.length <= 30
      ? media.title
      : media.title.slice(0, 29) + "…"
    : "Ready";

  // Timeline geometry — the acid IN/OUT band with its acid and red end ticks.
  const pct = (s: number) =>
    duration > 0 ? Math.min(1, Math.max(0, s / duration)) * 100 : 0;
  const bandIn = pct(inPoint);
  const bandOut = outPoint > 0 ? pct(outPoint) : inPoint > 0 ? 100 : 0;

  const onScrub = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(
      1,
      Math.max(0, (e.clientX - rect.left) / rect.width),
    );
    seekSeconds(ratio * duration);
  };

  // Draggable Crop Handlers
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (aspectMode !== "vertical_crop") return;
    if (e.button !== 0) return; // Only allow left-click dragging
    e.preventDefault();
    setIsDragging(true);
    dragStart.current = {
      x: e.clientX,
      y: e.clientY,
      panX: cropPanX,
      panY: cropPanY,
      time: Date.now(),
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [aspectMode, cropPanX, cropPanY]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging || !videoRef.current || !media || media.width <= 0 || media.height <= 0) return;
    
    const rect = videoRef.current.getBoundingClientRect();
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;

    // Use absolute 0,0 to calculate exactly how much leftover margin we have to drag within
    const r = cropGeometry(media.width, media.height, 0, 0);
    const movableFracX = 1 - (r.w / media.width);
    const movableFracY = 1 - (r.h / media.height);

    let newPanX = dragStart.current.panX;
    if (movableFracX > 0) {
      const pxMovableX = rect.width * movableFracX;
      // Multiplying by 2 maps the pixel delta directly to the API's -1 to 1 range
      newPanX += (dx / pxMovableX) * 2;
    }

    let newPanY = dragStart.current.panY;
    if (movableFracY > 0) {
      const pxMovableY = rect.height * movableFracY;
      newPanY += (dy / pxMovableY) * 2;
    }

    setCropPanX(clamp(newPanX, -1, 1));
    setCropPanY(clamp(newPanY, -1, 1));
  }, [isDragging, media]);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    setIsDragging(false);
    e.currentTarget.releasePointerCapture(e.pointerId);
    
    // If it was a clean click with no dragging, passthrough the play/pause toggle
    if (Date.now() - dragStart.current.time < 250) {
      const dx = Math.abs(e.clientX - dragStart.current.x);
      const dy = Math.abs(e.clientY - dragStart.current.y);
      if (dx < 5 && dy < 5) togglePlay();
    }
  }, [isDragging, togglePlay]);

  // Crop guide — expressed as PERCENTAGES of the picture, not pixels.
  const aspect =
    media && media.width > 0 && media.height > 0
      ? { w: media.width, h: media.height }
      : { w: 16, h: 9 };

  // If Vertical Blur is selected, we forcefully frame the container itself to 9:16
  const displayAspect = aspectMode === "vertical_blur" ? { w: 9, h: 16 } : aspect;

  const showCrop =
    aspectMode === "vertical_crop" &&
    media &&
    media.width > 0 &&
    media.height > 0;
  let cropStyle: React.CSSProperties | null = null;
  if (showCrop && media) {
    const r = cropGeometry(media.width, media.height, cropPanX, cropPanY);
    cropStyle = {
      left: `${(r.x / media.width) * 100}%`,
      top: `${(r.y / media.height) * 100}%`,
      width: `${(r.w / media.width) * 100}%`,
      height: `${(r.h / media.height) * 100}%`,
    };
  }

  return (
    <div
      className="panel flex h-full min-h-0 flex-col"
      style={{ padding: "16px 18px", gap: 12 }}
    >
      <span className="section-label">PRECISION PLAYER</span>

      <div
        className="video-stage relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        style={{ containerType: "size" }}
      >
        {media && media.isRecording ? (
          <div className="flex h-full items-center justify-center">
            <p className="hint whitespace-pre-line text-center">
              {"🔴 Recording…\n\nClip it from the transcript panel — highlight text to set IN / OUT."}
            </p>
          </div>
        ) : media ? (
          // Sized with container-query units because `height:100%` + `max-width:100%` 
          // fight each other and distort the box.
          <div
            className="relative overflow-hidden"
            style={{
              aspectRatio: `${displayAspect.w} / ${displayAspect.h}`,
              width: `min(100cqw, calc(100cqh * ${displayAspect.w} / ${displayAspect.h}))`,
              backgroundColor: "#000",
            }}
          >
            {aspectMode === "vertical_blur" && (
              <video
                ref={bgVideoRef}
                src={media.playbackUrl}
                className="absolute inset-0 h-full w-full pointer-events-none"
                style={{
                  objectFit: "cover",
                  filter: "blur(24px) brightness(0.6)",
                  transform: "scale(1.1)",
                }}
                crossOrigin="anonymous"
                muted
                playsInline
              />
            )}
            <video
              ref={videoRef}
              src={media.playbackUrl}
              className="absolute inset-0 h-full w-full"
              style={{ objectFit: "contain" }}
              crossOrigin="anonymous"
              muted={muted}
              onTimeUpdate={(e) => {
                setPosition(e.currentTarget.currentTime);
                if (bgVideoRef.current && Math.abs(bgVideoRef.current.currentTime - e.currentTarget.currentTime) > 0.3) {
                  bgVideoRef.current.currentTime = e.currentTarget.currentTime;
                }
              }}
              onDurationChange={(e) =>
                setDuration(e.currentTarget.duration || 0)
              }
              onPlay={() => {
                setPlaying(true);
                if (bgVideoRef.current) void bgVideoRef.current.play().catch(() => {});
              }}
              onPause={() => {
                setPlaying(false);
                if (bgVideoRef.current) bgVideoRef.current.pause();
              }}
              onSeeked={(e) => {
                if (bgVideoRef.current) bgVideoRef.current.currentTime = e.currentTarget.currentTime;
              }}
              onLoadStart={() => setPlaying(false)}
              onClick={togglePlay}
            >
              {captionsUrl && (
                <track
                  key={captionsUrl}
                  kind="subtitles"
                  srcLang="en"
                  label="Transcript"
                  src={captionsUrl}
                  default={captionsOn}
                />
              )}
            </video>
            {cropStyle && (
              /* The pointer-events-none class is stripped when vertical_crop is active so we can drag it. */
              <div
                className={`absolute ${aspectMode === "vertical_crop" ? (isDragging ? "cursor-grabbing" : "cursor-grab") : "pointer-events-none"}`}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                style={{
                  ...cropStyle,
                  boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.5)",
                  border: `${CROP_BORDER_PX}px solid var(--acid)`,
                  touchAction: "none",
                }}
              />
            )}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="hint whitespace-pre-line text-center">
              {
                "No media loaded\n\nDouble-click a library item, or paste a URL above."
              }
            </p>
          </div>
        )}
      </div>

      {/* Timeline row: time · slider · duration hint · state */}
      <div className="flex items-center" style={{ gap: 12 }}>
        <span className="timecode whitespace-nowrap">
          {formatTc(position)} / {formatTc(duration)}
        </span>
        <div
          className="relative flex-1 cursor-pointer"
          style={{ height: 44 }}
          onClick={onScrub}
          onMouseDown={onScrub}
        >
          {/* groove */}
          <div
            className="absolute left-0 right-0"
            style={{ top: 15, height: 14, background: "#2a2a2a" }}
          />
          {/* played portion */}
          <div
            className="absolute left-0"
            style={{
              top: 15,
              height: 14,
              width: `${pct(position)}%`,
              background: "var(--blue)",
            }}
          />
          {/* IN/OUT band + end ticks */}
          {(inPoint > 0 || outPoint > 0) && (
            <>
              <div
                className="absolute"
                style={{
                  left: `${bandIn}%`,
                  width: `${Math.max(0.3, bandOut - bandIn)}%`,
                  top: 11,
                  height: 22,
                  background: "rgba(231, 235, 148, 0.75)",
                }}
              />
              <div
                className="absolute"
                style={{
                  left: `${bandIn}%`,
                  top: 2,
                  width: 3,
                  height: 40,
                  background: "var(--acid)",
                }}
              />
              <div
                className="absolute"
                style={{
                  left: `calc(${bandOut}% - 3px)`,
                  top: 2,
                  width: 3,
                  height: 40,
                  background: "var(--red)",
                }}
              />
            </>
          )}
          {/* handle */}
          <div
            className="absolute"
            style={{
              left: `calc(${pct(position)}% - 7px)`,
              top: 5,
              width: 14,
              height: 34,
              background: "var(--milk)",
            }}
          />
        </div>
        <span
          className="status-muted whitespace-nowrap"
          title="Selected length, and length after 2s padding"
        >
          {durationHint}
        </span>
        <span
          className="status-muted whitespace-nowrap"
          style={{ marginLeft: 10 }}
          title={media?.title}
        >
          {stateLabel}
        </span>
      </div>

      {/* Control bar — one row: transport · marks · aspect · export. */}
      <div className="control-row">
        <div className="control-bar">
          <div className="control-cluster">
            <button
              type="button"
              className="transport-btn"
              title="Go to IN point"
              onClick={() => seekSeconds(inPoint)}
            >
              <span className="glyph">❘◀</span>
            </button>
            <button
              type="button"
              className="transport-btn"
              title="Back 5s  (J)"
              onClick={() => nudge(-5000)}
            >
              <span className="glyph">◀◀</span>
            </button>
            <button
              type="button"
              className="transport-btn transport-primary"
              title="Play / Pause  (Space)"
              onClick={togglePlay}
            >
              <span className="glyph">{playing ? "❚❚" : "▶"}</span>
            </button>
            <button
              type="button"
              className="transport-btn"
              title="Forward 5s  (L)"
              onClick={() => nudge(5000)}
            >
              <span className="glyph">▶▶</span>
            </button>
            <button
              type="button"
              className="transport-btn"
              title="Go to OUT point"
              onClick={() => seekSeconds(outPoint || duration)}
            >
              <span className="glyph">▶❘</span>
            </button>
            <button
              type="button"
              className="transport-btn"
              data-checked={captionsOn ? "true" : undefined}
              disabled={!hasCaptions}
              title={
                hasCaptions
                  ? "Toggle captions from the transcript"
                  : "No transcript for this file yet — captions come from it"
              }
              onClick={() => onToggleCaptions?.()}
            >
              CC
            </button>
            <button
              type="button"
              className="transport-btn"
              data-checked={muted ? "true" : undefined}
              title={muted ? "Unmute" : "Mute"}
              onClick={toggleMute}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                {muted ? (
                  <>
                    <line x1="23" y1="9" x2="17" y2="15" />
                    <line x1="17" y1="9" x2="23" y2="15" />
                  </>
                ) : (
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14" />
                )}
              </svg>
            </button>
          </div>

          <span className="control-gap" />

          <div className="control-cluster">
            <button
              type="button"
              className="transport-btn mark-in"
              title="Set IN point at the playhead  (I)"
              onClick={() => onMarkIn(position)}
            >
              <span className="mark-glyph">[</span>
            </button>
            <input
              className="tc-field"
              data-marker="in"
              value={inText}
              title="IN timecode — editable"
              onChange={(e) => setInDraft(e.target.value)}
              onBlur={commitIn}
              onKeyDown={(e) => e.key === "Enter" && commitIn()}
            />
            <button
              type="button"
              className="transport-btn mark-out"
              title="Set OUT point at the playhead  (O)"
              onClick={() => onMarkOut(position)}
            >
              <span className="mark-glyph">]</span>
            </button>
            <input
              className="tc-field"
              data-marker="out"
              value={outText}
              title="OUT timecode — editable"
              onChange={(e) => setOutDraft(e.target.value)}
              onBlur={commitOut}
              onKeyDown={(e) => e.key === "Enter" && commitOut()}
            />
            <button
              type="button"
              className="transport-btn transport-ghost"
              title="Clear IN and OUT"
              onClick={onClearMarks}
            >
              ✕
            </button>
          </div>

          <span className="control-gap" />

          <select
            className="select select-aspect"
            value={aspectMode}
            onChange={(e) => onAspectChange(e.target.value)}
            title="Output framing for the exported clip"
          >
            {ASPECT_OPTIONS.map((a) => (
              <option key={a.mode} value={a.mode}>
                {a.short}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          className="btn-export"
          onClick={() => onExport(cropPanX, cropPanY)}
          disabled={!media || exporting || outPoint <= inPoint}
          title="Export with 2s handles + audio fades  (Ctrl+E)"
        >
          {exporting ? "EXPORTING…" : "EXPORT CLIP"}
        </button>
      </div>
    </div>
  );
}