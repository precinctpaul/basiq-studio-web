"use client";

import { useCallback, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase-browser";

type Phase = "idle" | "creating" | "uploading" | "probing" | "ready" | "error";

interface Props {
  onReady?: (videoId: string) => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n;
  let i = -1;
  do {
    value /= 1024;
    i++;
  } while (value >= 1024 && i < units.length - 1);
  return `${value.toFixed(1)} ${units[i]}`;
}

/**
 * No byte-level progress bar: supabase-js's uploadToSignedUrl resolves once,
 * with no upload-progress event to hook. A fabricated percentage that isn't
 * tied to real bytes reads worse than an honest phase label, so this shows
 * what phase we're in (uploading vs. probing) plus the file size instead of
 * guessing at a number.
 */
export function VideoUploader({ onReady }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [fileLabel, setFileLabel] = useState("");
  const [message, setMessage] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = useCallback(
    async (file: File) => {
      setPhase("creating");
      setFileLabel(`${file.name} (${formatBytes(file.size)})`);
      setMessage("");

      try {
        const createRes = await fetch("/api/videos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: file.name.replace(/\.[^.]+$/, ""),
            filename: file.name,
            mimeType: file.type || "application/octet-stream",
            sizeBytes: file.size,
          }),
        });
        const created = await createRes.json();
        if (!createRes.ok) throw new Error(created.error ?? "could not start upload");

        setPhase("uploading");
        const { error: uploadError } = await supabaseBrowser.storage
          .from("videos")
          .uploadToSignedUrl(created.path, created.token, file, {
            contentType: file.type || "application/octet-stream",
          });
        if (uploadError) throw new Error(uploadError.message);

        setPhase("probing");
        const finalizeRes = await fetch(`/api/videos/${created.videoId}/finalize`, {
          method: "POST",
        });
        const finalized = await finalizeRes.json();
        if (!finalizeRes.ok) throw new Error(finalized.error ?? "could not read video info");

        setPhase("ready");
        onReady?.(created.videoId);
      } catch (err) {
        setPhase("error");
        setMessage(err instanceof Error ? err.message : String(err));
      }
    },
    [onReady],
  );

  const busy = phase === "creating" || phase === "uploading" || phase === "probing";

  const statusText: Record<Phase, string> = {
    idle: "Drop a video here, or click to browse",
    creating: "Starting upload…",
    uploading: `Uploading ${fileLabel}… this can take a while for a long recording`,
    probing: "Reading video info…",
    ready: `Ready: ${fileLabel}`,
    error: `Upload failed: ${message}`,
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => !busy && inputRef.current?.click()}
      onKeyDown={(e) => {
        if (!busy && (e.key === "Enter" || e.key === " ")) inputRef.current?.click();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file && !busy) void upload(file);
      }}
      className={[
        "flex min-h-48 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center transition-colors",
        dragOver ? "border-blue-400 bg-blue-950/20" : "border-neutral-700",
        busy ? "cursor-wait opacity-80" : "",
        phase === "error" ? "border-red-500" : "",
      ].join(" ")}
    >
      <input
        ref={inputRef}
        type="file"
        accept="video/*,audio/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <p className={phase === "error" ? "text-red-400" : "text-neutral-300"}>
        {statusText[phase]}
      </p>
    </div>
  );
}
