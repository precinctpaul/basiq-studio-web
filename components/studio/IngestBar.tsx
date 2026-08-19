"use client";

import { useEffect, useRef, useState } from "react";
import { agentProbeLive, startTranscription } from "@/lib/agent";

const QUALITY_PRESETS = ["HD", "SD", "Proxy", "Audio Only"] as const;

export interface CaptureOptions {
  title: string;
  maxMinutes: number;
  quality?: string;
  subs?: boolean;
}

export interface IngestBarProps {
  quality: string;
  onQualityChange: (quality: string) => void;
  onGrab: (url: string, isLive: boolean, options: CaptureOptions) => void;
}

export function IngestBar({ quality, onQualityChange, onGrab }: IngestBarProps) {
  const [url, setUrl] = useState("");
  const [subs, setSubs] = useState(false);
  const [isLiveDetected, setIsLiveDetected] = useState(false);
  const [forceLive, setForceLive] = useState(false);
  const [titleOverride, setTitleOverwrite] = useState("");
  const [maxMinutes, setMaxMinutes] = useState<number>(0);
  const [isBusy, setIsBusy] = useState(false);
  const [uploading, setUploading] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const probeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isLiveMode = isLiveDetected || forceLive;

  // Auto-probe URL for live stream status
  useEffect(() => {
    if (probeTimer.current) clearTimeout(probeTimer.current);
    const trimmed = url.trim();

    if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
      setIsLiveDetected(false);
      return;
    }

    probeTimer.current = setTimeout(async () => {
      try {
        const res = await agentProbeLive(trimmed);
        setIsLiveDetected(Boolean(res.is_live || res.isLive));
        if (res.title && !titleOverride) {
          setTitleOverwrite(res.title);
        }
      } catch {
        setIsLiveDetected(false);
      }
    }, 400);

    return () => {
      if (probeTimer.current) clearTimeout(probeTimer.current);
    };
  }, [url]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || isBusy) return;

    setIsBusy(true);
    try {
      const opts: CaptureOptions = {
        title: titleOverride.trim(),
        maxMinutes: Number(maxMinutes) || 0,
        quality,
        subs,
      };
      await onGrab(url.trim(), isLiveMode, opts);
      setUrl("");
      setTitleOverwrite("");
      setIsLiveDetected(false);
      setForceLive(false);
    } catch (err: any) {
      alert(`Ingest failed: ${err.message}`);
    } finally {
      setIsBusy(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || isBusy) return;

    setIsBusy(true);
    setUploading(true);

    try {
      const formData = new FormData();
      formData.append("file", file);

      await startTranscription(formData);
      alert(`Upload complete! Transcribing ${file.name}...`);
    } catch (err: any) {
      alert(`File upload failed: ${err.message}`);
    } finally {
      setIsBusy(false);
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="flex flex-col gap-2 w-full bg-neutral-900 p-3 rounded-lg border border-neutral-800 select-none">
      <form onSubmit={handleSubmit} className="flex items-center gap-3 w-full">
        {/* URL Input */}
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste C-SPAN, YouTube, X, or direct media URL..."
          className="flex-1 bg-neutral-950 border border-neutral-800 rounded px-3 py-2 text-sm text-neutral-200 placeholder-neutral-500 focus:outline-none focus:border-yellow-500/60"
        />

        {/* Manual Live Override Checkbox */}
        <label className="flex items-center gap-1.5 text-xs font-mono text-neutral-400 cursor-pointer hover:text-white">
          <input
            type="checkbox"
            checked={forceLive}
            onChange={(e) => setForceLive(e.target.checked)}
            className="accent-yellow-500 rounded"
          />
          <span className={forceLive ? "text-yellow-500 font-bold" : ""}>LIVE</span>
        </label>

        {/* Quality Presets */}
        {!isLiveMode && (
          <select
            value={quality}
            onChange={(e) => onQualityChange(e.target.value)}
            className="bg-neutral-950 border border-neutral-800 text-xs font-mono text-neutral-300 rounded px-2 py-2 focus:outline-none"
          >
            {QUALITY_PRESETS.map((q) => (
              <option key={q} value={q}>
                {q}
              </option>
            ))}
          </select>
        )}

        {/* Submit Button */}
        <button
          type="submit"
          disabled={!url.trim() || isBusy}
          className={`px-4 py-2 text-xs font-bold font-mono rounded transition-colors ${
            isLiveMode
              ? "bg-red-600 hover:bg-red-500 text-white"
              : "bg-yellow-500 hover:bg-yellow-400 text-black"
          } disabled:opacity-40`}
        >
          {isBusy ? "WORKING..." : isLiveMode ? "CAPTURE" : "GRAB"}
        </button>

        {/* Local File Upload Section */}
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileUpload}
          accept="video/*,audio/*"
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isBusy}
          className="px-3 py-2 text-xs font-mono bg-neutral-800 hover:bg-neutral-700 text-neutral-200 rounded border border-neutral-700 transition-colors disabled:opacity-40"
        >
          {uploading ? "UPLOADING..." : "UPLOAD FILE"}
        </button>
      </form>

      {/* Expanded Live Settings Bar */}
      {isLiveMode && (
        <div className="flex items-center gap-3 pt-2 border-t border-neutral-800/80">
          <span className="text-[10px] font-mono text-red-500 font-bold tracking-wider">
            LIVE CAPTURE MODE
          </span>
          <input
            type="text"
            value={titleOverride}
            onChange={(e) => setTitleOverwrite(e.target.value)}
            placeholder="Title Overwrite (optional)..."
            className="flex-1 bg-neutral-950 border border-neutral-800 rounded px-2 py-1 text-xs text-neutral-200 focus:outline-none"
          />
          <div className="flex items-center gap-1.5 text-xs font-mono text-neutral-400">
            <span>MAX MINS:</span>
            <input
              type="number"
              min={0}
              value={maxMinutes || ""}
              onChange={(e) => setMaxMinutes(Number(e.target.value))}
              placeholder="0 (no cap)"
              className="w-20 bg-neutral-950 border border-neutral-800 rounded px-2 py-1 text-xs text-neutral-200 focus:outline-none"
            />
          </div>
        </div>
      )}
    </div>
  );
}