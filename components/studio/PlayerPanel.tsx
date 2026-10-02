"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatTc, parseTc } from "@/lib/timecode";
import { cropGeometry } from "@/lib/crop";
import { buildCues, outputSize, subStyleFor, PLAY_RES_Y, type Cue } from "@/lib/burn-subs";

/** ASPECT_SHORT_LABELS index-aligned with ASPECT_MODES, app/config.py:277-279 */
const ASPECT_OPTIONS = [
  { short: "16:9 Native", mode: "native" },
  { short: "9:16 Crop", mode: "vertical_crop" },
  { short: "9:16 Blur", mode: "vertical_blur" },
] as const;

/** CROP_BORDER_PX from app/ui/player_panel.py — the guide's stroke weight. */
const CROP_BORDER_PX = 3;

/** Playback speed step/bounds for the baked-in speed control -- +/- and the
 *  < / > shortcuts all move by SPEED_STEP. Bounds are generous (a review
 *  workflow, unlike normal playback, has real reason to go well past 2x or
 *  down near single-digit percent) but still stop short of 0, which would
 *  freeze the video rather than slow it. */
const SPEED_STEP = 0.1;
const SPEED_MIN = 0.1;
const SPEED_MAX = 4;

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
  /** SUBTITLES toggle: burn transcript text into the exported clip. */
  burnSubtitles?: boolean;
  /** False until this video has a finished transcript to burn. */
  subtitlesAvailable?: boolean;
  onToggleBurnSubtitles?: () => void;
  /**
   * The loaded transcript, for the SUBS ON preview. Read-only: cues are
   * rebuilt from it with the same code the export burns in.
   */
  subtitleSegments?: { start: number; end: number; text: string }[];
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

/**
 * ASS Fontsize is libass's line height (ascent + descent), not a CSS em.
 * Recoleta's ascent + descent is 1.36em, so CSS needs 1/1.36 of the ASS size.
 * Checked against a real libass 1080p render: same text, same width (1411px).
 */
const SUB_PREVIEW_EM = 1 / 1.36;

/** Largest box of the given aspect ratio centred in the stage (contain). */
function containFrame(stage: { w: number; h: number }, ratio: number): React.CSSProperties {
  if (stage.w <= 0 || stage.h <= 0) return { left: 0, top: 0, width: "100%", height: "100%" };
  const w = Math.min(stage.w, stage.h * ratio);
  const h = w / ratio;
  return { left: (stage.w - w) / 2, top: (stage.h - h) / 2, width: w, height: h };
}

/** The cue on screen at time t (cues are sorted and never overlap). */
function activeCue(cues: Cue[], t: number): Cue | null {
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].end <= t) lo = mid + 1;
    else if (cues[mid].start > t) hi = mid - 1;
    else return cues[mid];
  }
  return null;
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
  burnSubtitles = false,
  subtitlesAvailable = false,
  onToggleBurnSubtitles,
  subtitleSegments,
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
  // Measured stage size, for fitting the SUBS preview's export frame. The
  // stage's aspect-ratio isn't guaranteed: a short column flex-shrinks its
  // height (e.g. 9:16 Blur becomes a wide box), so the frame is fitted inside
  // it the same way object-fit: contain fits the video.
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStageSize({ w: el.clientWidth, h: el.clientHeight });
    // Measured now as well as on resize: ResizeObserver only reports at the
    // next rendering opportunity, and the stage's shape changes right away
    // with the framing (Blur forces 9:16) and with each new video.
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspectMode, media?.id]);
  
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const hasCaptions = Boolean(captionsUrl);
  // SUBS ON preview: the exported clip's burned-in subtitles, drawn live over
  // the player. CC hides meanwhile so the same words don't show twice.
  const previewSubs = burnSubtitles && subtitlesAvailable && Boolean(media) && !media?.isRecording;

  // Applied here rather than only where it's set, so a browser that resets
  // playbackRate on its own when the <video>'s src changes (some do) gets
  // corrected right back -- re-running on media?.id catches that; re-running
  // on playbackRate itself is what actually moves the video when +/- or the
  // </> shortcuts change it.
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = playbackRate;
    if (bgVideoRef.current) bgVideoRef.current.playbackRate = playbackRate;
  }, [playbackRate, media?.id]);

  const bumpSpeed = useCallback((delta: number) => {
    setPlaybackRate((r) => {
      const next = Math.round((r + delta) * 100) / 100;
      return Math.min(SPEED_MAX, Math.max(SPEED_MIN, next));
    });
  }, []);

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
    // Forcing play() here regardless of prior state meant every transcript
    // double-click (jump to word) kept running from the click point instead
    // of landing and staying there -- by the time you looked back at the
    // frame (or took a screenshot), playback had already moved on, looking
    // like the click landed in the wrong spot when the seek itself was
    // correct. Only resume if it was already playing before the seek.
    const wasPlaying = !videoRef.current.paused;
    const target = Math.max(0, seekTo.seconds);
    videoRef.current.currentTime = target;
    if (bgVideoRef.current) bgVideoRef.current.currentTime = target;
    if (wasPlaying) void videoRef.current.play().catch(() => {});
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
        track.mode = captionsOn && !previewSubs ? "showing" : "hidden";
      }
    };
    apply();
    // The track list is populated asynchronously after the source loads.
    v.textTracks.addEventListener?.("addtrack", apply);
    return () => v.textTracks.removeEventListener?.("addtrack", apply);
  }, [captionsOn, captionsUrl, previewSubs]);

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
  // (~1 frame at 25fps), Ctrl+E export. </> (Shift+,/.) +-10% playback
  // speed is new here, not in the desktop app this mirrors.
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
        // Shift+, / Shift+. -- same physical keys as the frame-nudge pair
        // above, and the same characters YouTube itself uses for playback
        // speed, so there's no new key to learn.
        case "<":
          bumpSpeed(-SPEED_STEP);
          break;
        case ">":
          bumpSpeed(SPEED_STEP);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, nudge, onMarkIn, onMarkOut, onExport, cropPanX, cropPanY, bumpSpeed]);

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

  // Forcing "16:9 Native" into an actual fixed 16:9 box (tried 2026-09-26)
  // was the wrong fix: it guarantees letterboxing on anything that isn't
  // already exactly 16:9, which most real source footage isn't -- for a
  // clipping tool, hiding part of the frame (object-fit: cover) to erase
  // those bars isn't acceptable either, since you need to see the whole
  // picture to cut it accurately. Sizing the frame to the SOURCE's own real
  // dimensions is the only way to guarantee a snug fit with zero wasted
  // space for whatever shape a given video actually is -- back to that.
  // Vertical Blur is still deliberately forced to 9:16.
  const displayAspect = aspectMode === "vertical_blur" ? { w: 9, h: 16 } : aspect;

  const showCrop =
    aspectMode === "vertical_crop" &&
    media &&
    media.width > 0 &&
    media.height > 0;
  // Same style choice and cue building as lib/burn-subs.ts's export path.
  // Only the frame's orientation matters to the style, hence 9x16 for the
  // vertical modes rather than the real export width.
  const subOut = outputSize(aspectMode, media?.width ?? 0, media?.height ?? 0, 9, 16);
  const subStyle = subStyleFor(subOut.width, subOut.height);
  const previewCues = useMemo<Cue[]>(
    () =>
      previewSubs && subtitleSegments
        ? buildCues(
            subtitleSegments.map((s) => ({ start_seconds: s.start, end_seconds: s.end, text: s.text })),
            { start: 0, end: Infinity },
            subStyle.maxCharsPerLine,
          )
        : [],
    [previewSubs, subtitleSegments, subStyle.maxCharsPerLine],
  );
  const previewCue = activeCue(previewCues, position);

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
      <span className="section-label" style={{ flexShrink: 0 }}>PRECISION PLAYER</span>

      {/* The video's own box is deliberately sized to hug its content
          exactly (see the aspect-ratio comment below) rather than
          flex-filling the panel -- correct for the video itself, but it
          means any extra vertical room the panel happens to have (a
          shortish 16:9 clip in a tall right-hand column, most commonly)
          was previously left to pool below EXPORT CLIP as one dead
          rectangle, which is what actually read as broken, not the video
          being letterboxed. Centering this whole block -- video, scrubber,
          transport -- in whatever space is actually left turns that same
          slack into even, intentional-looking breathing room above and
          below instead, the same way a lightbox or a media viewer centers
          its content rather than pinning it to one edge. min-h-0 lets this
          shrink back down (rather than push the controls off-panel) the
          moment the column is too short to need any centering at all --
          the common case on mobile. */}
      <div
        className="flex min-h-0 flex-1 flex-col justify-center"
        style={{ gap: 12 }}
      >
      {/* Sized to the ratio itself (native mode: the source's own real
          dimensions; blur mode: forced 9:16) via a plain aspect-ratio on
          THIS element, rather than flex-filling the panel's whole remaining
          height and centering a correctly-shaped box inside it. That
          flex-fill was the actual bug behind the "huge black gap above and
          below the video" report on 2026-09-26: a 1920x1080 (genuinely
          16:9) source sized a correctly-proportioned inner box, but the
          OUTER box still
          stretched to fill however much vertical room the panel happened to
          have (a lot, on a tall phone screen), leaving genuine dead space
          between this box's edges and both the label above and the controls
          below. A flex item with no flex-grow class defaults to
          flex-shrink: 1, and modern browsers apply that shrink to
          aspect-ratio'd boxes proportionally -- so this still shrinks to
          fit (preserving the ratio) on the rarer occasion the column is too
          SHORT for the width, e.g. a wide desktop window resized short. */}
      <div
        ref={stageRef}
        className="video-stage relative flex items-center justify-center overflow-hidden"
        style={{ width: "100%", aspectRatio: `${displayAspect.w} / ${displayAspect.h}` }}
      >
        {media && media.isRecording ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="hint whitespace-pre-line text-center">
              {"🔴 Recording…\n\nClip it from the transcript panel — highlight text to set IN / OUT."}
            </p>
          </div>
        ) : media ? (
          <>
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
              playsInline
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
            {previewCue && (
              /* The export frame (whole picture, or the 9:16 crop box), so
                 the subtitle lands where the export will put it. Sized in
                 container-height units of THIS box, mirroring how libass
                 scales the 288-high script canvas to the output height.
                 pointer-events: none keeps crop dragging working through it. */
              <div
                className="sub-preview-frame"
                style={cropStyle ?? containFrame(stageSize, aspectMode === "vertical_blur" ? 9 / 16 : aspect.w / aspect.h)}
                aria-hidden
              >
                <div
                  className="sub-preview"
                  style={{
                    bottom: `${(subStyle.marginV / PLAY_RES_Y) * 100}cqh`,
                    fontSize: `${(subStyle.fontSize / PLAY_RES_Y) * 100 * SUB_PREVIEW_EM}cqh`,
                  }}
                >
                  {previewCue.lines.map((l, i) => (
                    <span key={i}>{l}</span>
                  ))}
                </div>
              </div>
            )}
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
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="hint whitespace-pre-line text-center">
              {
                "No media loaded\n\nDouble-click a library item, or paste a URL above."
              }
            </p>
          </div>
        )}
      </div>

      {/* Timeline row: time · slider · duration hint · state. On mobile this
          row also carries the aspect toggle (moved here from the control row
          below, see .select-aspect-mobile in globals.css) so the control row
          only needs one line instead of two. */}
      <div className="player-timeline-row flex items-center" style={{ gap: 12 }}>
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
          className="player-timeline-extra status-muted whitespace-nowrap"
          title="Selected length, and length after 2s padding"
        >
          {durationHint}
        </span>
        <span
          className="player-timeline-extra status-muted whitespace-nowrap"
          style={{ marginLeft: 10 }}
          title={media?.title}
        >
          {stateLabel}
        </span>
        <select
          className="select select-aspect select-aspect-mobile"
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

      {/* Control bar — one row: transport · marks · aspect · export. On
          mobile several desktop-only controls are hidden (see globals.css)
          so the rest fits on a single line: the jump-to-IN/OUT buttons, CC,
          the editable IN/OUT timecode fields, the clear-marks button, and
          this row's own aspect select (duplicated above instead, since typing
          exact timecodes isn't really a mobile workflow and the timeline's
          own IN/OUT band already shows the selection visually). */}
      <div className="control-row">
        <div className="control-bar">
          <div className="control-cluster">
            <button
              type="button"
              className="transport-btn player-desktop-only"
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
              className="transport-btn player-desktop-only"
              title="Go to OUT point"
              onClick={() => seekSeconds(outPoint || duration)}
            >
              <span className="glyph">▶❘</span>
            </button>
            <button
              type="button"
              className="transport-btn transport-btn-text player-desktop-only"
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

          {/* Baked-in speed control -- no more needing a Chrome extension
              (Video Speed Controller) to review footage faster than 1x. The
              +/- buttons and the < / > keyboard shortcuts both step by the
              same SPEED_STEP, and the display itself resets to 1.00x on
              click since that's the rate you want back most often. */}
          <div className="control-cluster">
            <button
              type="button"
              className="transport-btn"
              title="Decrease speed 10%  (<)"
              onClick={() => bumpSpeed(-SPEED_STEP)}
            >
              <span className="glyph">−</span>
            </button>
            <button
              type="button"
              className="transport-btn speed-display"
              title="Click to reset to 1.00×"
              onClick={() => setPlaybackRate(1)}
            >
              {playbackRate.toFixed(2)}×
            </button>
            <button
              type="button"
              className="transport-btn"
              title="Increase speed 10%  (>)"
              onClick={() => bumpSpeed(SPEED_STEP)}
            >
              <span className="glyph">+</span>
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
              className="tc-field player-desktop-only"
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
              className="tc-field player-desktop-only"
              data-marker="out"
              value={outText}
              title="OUT timecode — editable"
              onChange={(e) => setOutDraft(e.target.value)}
              onBlur={commitOut}
              onKeyDown={(e) => e.key === "Enter" && commitOut()}
            />
            <button
              type="button"
              className="transport-btn transport-ghost player-desktop-only"
              title="Clear IN and OUT"
              onClick={onClearMarks}
            >
              ✕
            </button>
          </div>

          <span className="control-gap" />

          {/* Framing and EXPORT CLIP are a pair -- the button always exports
              in whatever framing the select is currently showing, so they
              need to wrap together as one unit or land together on the
              same line. They used to be split across two different flex
              containers (this select inside .control-bar's wrapping row,
              the button pinned outside it in .control-row), which kept the
              button glued to the row's right edge instead of next to its
              own select once the row wrapped -- exactly the mismatch this
              cluster fixes. */}
          <div className="control-cluster" style={{ gap: 8 }}>
            <select
              className="select select-aspect player-desktop-only"
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
            <button
              type="button"
              className="transport-btn transport-btn-text"
              data-checked={burnSubtitles && subtitlesAvailable ? "true" : undefined}
              onClick={onToggleBurnSubtitles}
              disabled={!subtitlesAvailable || exporting}
              aria-pressed={burnSubtitles && subtitlesAvailable}
              title={
                subtitlesAvailable
                  ? "Burn the transcript into the exported clip as subtitles"
                  : "Subtitles need a finished transcript for this video"
              }
            >
              SUBS {burnSubtitles && subtitlesAvailable ? "ON" : "OFF"}
            </button>
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
      </div>
      </div>
    </div>
  );
}