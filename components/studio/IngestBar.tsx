"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { agentProbeLive } from "@/lib/agent";

/** QUALITY_PRESETS, app/config.py:275 */
const QUALITY_PRESETS = ["HD", "SD", "Proxy", "Audio Only"] as const;

/** Debounce before spending a yt-dlp probe on a half-typed URL (450ms in the original). */
const PROBE_DEBOUNCE_MS = 450;

/**
 * Free, instant, offline classification — the first tier of app/livecapture.py's
 * classify_source. A direct manifest (.m3u8/.mpd) or a streaming protocol
 * address is knowably live from the string alone, so the button arms to
 * GO LIVE with no network call, ever. Anything else is a watch page whose
 * liveness only yt-dlp can answer.
 */
function isKnowablyLive(url: string): boolean {
  const u = url.trim().toLowerCase();
  if (!u) return false;
  if (/^(rtmp|rtmps|rtmpe|rtsp|srt|udp|rtp|tcp):\/\//.test(u)) return true;
  if (/\.(m3u8|mpd|f4m|ism)(\?|$)/.test(u)) return true;
  return false;
}

/** A watch page is worth probing; a bare fragment or a plain file URL is not. */
function looksLikePage(url: string): boolean {
  const u = url.trim();
  if (u.length < 12) return false;
  if (!/^https?:\/\//i.test(u)) return false;
  return !isKnowablyLive(u);
}

export interface CaptureOptions {
  title: string;
  maxMinutes: number;
}

interface Props {
  quality: string;
  onQualityChange: (q: string) => void;
  subs: boolean;
  onSubsChange: (v: boolean) => void;
  aiTranscribe: boolean;
  onAiTranscribeChange: (v: boolean) => void;
  onGrab: (url: string, live: boolean, options: CaptureOptions) => void;
  busy?: boolean;
}

export function IngestBar({
  quality,
  onQualityChange,
  subs,
  onSubsChange,
  aiTranscribe,
  onAiTranscribeChange,
  onGrab,
  busy = false,
}: Props) {
  const [url, setUrl] = useState("");
  const [probing, setProbing] = useState(false);
  const [titleOverride, setTitleOverride] = useState("");
  const [stopAfter, setStopAfter] = useState(0);

  // The probe result is stored WITH the url it describes, and the live flag is
  // derived by comparing that url to the current one. A result for a url the
  // operator has since edited therefore can't arm GO LIVE — staleness is
  // structurally impossible rather than something the counter has to catch.
  const [probeResult, setProbeResult] = useState<{ url: string; isLive: boolean } | null>(null);

  // Still needed for the in-flight case: two probes can be outstanding at once
  // and only the newest may write.
  const probeGen = useRef(0);

  const trimmed = url.trim();
  const knownLive = isKnowablyLive(url);
  const live = knownLive || (probeResult?.url === trimmed && probeResult.isLive);

  useEffect(() => {
    const generation = ++probeGen.current;
    // A knowably-live url needs no probe, and neither does a fragment that
    // isn't a watch page yet.
    if (knownLive || !looksLikePage(url)) return;

    const timer = setTimeout(async () => {
      setProbing(true);
      try {
        const { is_live } = await agentProbeLive(trimmed);
        if (generation === probeGen.current) setProbeResult({ url: trimmed, isLive: is_live });
      } catch {
        // Agent down, or the extractor refused. Stay on GRAB — the safe
        // default — rather than surfacing an error for something the operator
        // never explicitly asked for.
        if (generation === probeGen.current) setProbeResult({ url: trimmed, isLive: false });
      } finally {
        if (generation === probeGen.current) setProbing(false);
      }
    }, PROBE_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [url, trimmed, knownLive]);

  const trigger = useCallback(() => {
    const value = url.trim();
    if (!value) return;
    onGrab(value, live, { title: titleOverride.trim(), maxMinutes: stopAfter });
  }, [url, live, titleOverride, stopAfter, onGrab]);

  return (
    <div className="flex flex-1 flex-col" style={{ gap: 8 }}>
      <div className="flex flex-1 items-center gap-3">
        <input
          type="text"
          className="field flex-1"
          placeholder="Paste a C-SPAN, YouTube, X or direct media URL…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") trigger();
          }}
        />

        {/* Download-only options; they mean nothing for a live capture, so they
            give up their space to the capture options row instead. */}
        {!live && (
          <>
            <select
              className="select"
              value={quality}
              onChange={(e) => onQualityChange(e.target.value)}
              aria-label="Quality"
            >
              {QUALITY_PRESETS.map((q) => (
                <option key={q} value={q}>
                  {q}
                </option>
              ))}
            </select>
            <label className="check" title="Download publisher subtitles when available">
              <input type="checkbox" checked={subs} onChange={(e) => onSubsChange(e.target.checked)} />
              <span>Subs</span>
            </label>
          </>
        )}

        <label
          className="check"
          title={
            live
              ? "Queue a Whisper pass as soon as the capture lands"
              : "Queue a local Whisper transcript after download"
          }
        >
          <input
            type="checkbox"
            checked={aiTranscribe}
            onChange={(e) => onAiTranscribeChange(e.target.checked)}
          />
          <span>AI Transcribe</span>
        </label>

        {/* Never disabled while a probe is in flight — pressing it always acts
            on the current best guess, which defaults to a download. */}
        <button
          type="button"
          className="btn-primary"
          onClick={trigger}
          disabled={busy}
          title={
            live
              ? "Start recording this stream  (Ctrl+D)"
              : "Queue a download  (Ctrl+D)"
          }
        >
          {live ? "GO LIVE" : "GRAB"}
        </button>
      </div>

      {live && (
        <div className="flex items-center" style={{ gap: 10 }}>
          <span className="live-badge">● LIVE</span>
          <input
            type="text"
            className="field"
            style={{ maxWidth: 320 }}
            placeholder="Title override (optional)"
            value={titleOverride}
            onChange={(e) => setTitleOverride(e.target.value)}
          />
          <span className="status-muted whitespace-nowrap">Stop after</span>
          <input
            type="number"
            className="field"
            style={{ width: 90 }}
            min={0}
            max={1440}
            step={1}
            value={stopAfter}
            onChange={(e) => setStopAfter(Math.max(0, Math.min(1440, Number(e.target.value) || 0)))}
            title="Safety cap in minutes — 0 means record until you press STOP"
          />
          <span className="status-muted whitespace-nowrap">
            {stopAfter === 0 ? "min · no limit" : "min"}
          </span>
          {probing && <span className="status-muted">checking…</span>}
        </div>
      )}
    </div>
  );
}
