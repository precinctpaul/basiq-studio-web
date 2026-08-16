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
  onExport: () => void;
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
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const hasCaptions = Boolean(captionsUrl);

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
    videoRef.current.currentTime = Math.max(0, seekTo.seconds);
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
    if (v) v.currentTime = Math.max(0, v.currentTime + ms / 1000);
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
    if (v) v.currentTime = Math.max(0, s);
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
        onExport();
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
  }, [togglePlay, nudge, onMarkIn, onMarkOut, onExport]);

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

  // Crop guide — dead-centre only, matching player_panel.crop_offset() which
  // hard-returns (0, 0). A DOM overlay is safe here; the desktop build had to
  // burn this into libVLC's own filter chain because the hardware vout
  // composited above every window it tried.
  //
  // Expressed as PERCENTAGES of the picture, not pixels. An earlier version
  // measured the stage with a ResizeObserver and mirrored it into state, which
  // drew the guide 7px taller than the video whenever that measurement lagged
  // a layout pass. Percentages against an aspect-ratio box need no measurement
  // at all, so the guide cannot disagree with the frame it sits on.
  // Falls back to 16:9 for a clip row, whose probe columns live on its source
  // rather than on the clip itself.
  const aspect =
    media && media.width > 0 && media.height > 0
      ? { w: media.width, h: media.height }
      : { w: 16, h: 9 };

  const showCrop =
    aspectMode === "vertical_crop" &&
    media &&
    media.width > 0 &&
    media.height > 0;
  let cropStyle: React.CSSProperties | null = null;
  if (showCrop) {
    const r = cropGeometry(media.width, media.height, 0, 0);
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
          // An aspect-ratio box sized to the source means this element IS the
          // picture — no letterbox bars inside it — so a percentage overlay
          // lands exactly on the frame at any window size.
          //
          // Sized with container-query units because the obvious CSS doesn't
          // work: `height:100%` + `max-width:100%` fight each other and the
          // box ends up distorted (measured 1.727 against a 1.778 source),
          // which quietly distorts the crop guide with it. min(100cqw, …)
          // picks the fitting axis outright, with no JS measurement to go
          // stale and nothing to re-run on resize.
          <div
            className="relative"
            style={{
              aspectRatio: `${aspect.w} / ${aspect.h}`,
              width: `min(100cqw, calc(100cqh * ${aspect.w} / ${aspect.h}))`,
            }}
          >
            <video
              ref={videoRef}
              src={media.playbackUrl}
              className="absolute inset-0 h-full w-full"
              crossOrigin="anonymous"
              muted={muted}
              onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
              onDurationChange={(e) =>
                setDuration(e.currentTarget.duration || 0)
              }
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              // Swapping the source resets the element to paused WITHOUT
              // firing `pause`, so the button kept showing ❚❚ for a video
              // that wasn't playing. loadstart is the event that actually
              // marks a new resource, so the glyph follows the new source.
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
              /* Everything outside the 9:16 window dimmed to half black, so
                 what survives the crop reads at a glance. One box-shadow
                 spread rather than four bars: no seams to keep aligned, and
                 it tracks the rect automatically. */
              <div
                className="pointer-events-none absolute"
                style={{
                  ...cropStyle,
                  boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.5)",
                  border: `${CROP_BORDER_PX}px solid var(--acid)`,
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

      {/* Control bar — one row: transport · marks · aspect · export.
          Glyphs are geometric shapes (U+25B6 etc), NOT the media-control
          emoji the desktop uses. Qt renders ⏪/⏩ as monochrome text; every
          browser renders them as colour emoji, which is why they showed up
          blue. These are the same shapes with no emoji presentation. */}
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
              {/* The classic speaker glyph, not a text label like CC — stroke
                  is currentColor so it follows the same acid-when-on
                  treatment for free, no separate muted/unmuted color rule. */}
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

        {/* Outside the scrolling bar on purpose: in a narrow column the
            controls scroll, and the one button the whole panel exists to
            reach must never be the thing that scrolls out of sight. */}
        <button
          type="button"
          className="btn-export"
          onClick={onExport}
          disabled={!media || exporting || outPoint <= inPoint}
          title="Export with 2s handles + audio fades  (Ctrl+E)"
        >
          {exporting ? "EXPORTING…" : "EXPORT CLIP"}
        </button>
      </div>
    </div>
  );
}
