"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { IngestBar, type CaptureOptions } from "@/components/studio/IngestBar";
import { LibraryPanel, type LibraryRow } from "@/components/studio/LibraryPanel";
import { PlayerPanel, type PlayerMedia } from "@/components/studio/PlayerPanel";
import { TranscriptPanel } from "@/components/studio/TranscriptPanel";
import { KeyMomentsPanel } from "@/components/studio/KeyMomentsPanel";
import { DetailsPanel, type DetailsRow, type Tag } from "@/components/studio/DetailsPanel";
import { QueuePanel, type QueueTask } from "@/components/studio/QueuePanel";
import { ShareBar } from "@/components/studio/ShareBar";
import {
  agentCapture,
  agentGrab,
  agentStopJob,
  agentTag,
  agentTranscribe,
  waitForJob,
  waitForJobResult,
} from "@/lib/agent";
import type { Segment } from "@/lib/paragraphs";

const TABS = ["TRANSCRIPT", "KEY MOMENTS", "DETAILS"] as const;
type Tab = (typeof TABS)[number];

/** Shown in the transcript/details/key-moments panes when a file has no transcript yet. */
const NO_TRANSCRIPT = "No transcript for this file yet.\n\nClick GRAB with AI Transcribe on, or transcribe from the library.";

export default function Studio() {
  const [rows, setRows] = useState<LibraryRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [media, setMedia] = useState<PlayerMedia | null>(null);
  const [detail, setDetail] = useState<DetailsRow | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [transcriptLoaded, setTranscriptLoaded] = useState(false);

  const [inPoint, setInPoint] = useState(0);
  const [outPoint, setOutPoint] = useState(0);
  const [aspectMode, setAspectMode] = useState("native");
  const [seekTo, setSeekTo] = useState<{ seconds: number; token: number } | null>(null);
  const [position] = useState(0);

  const [tab, setTab] = useState<Tab>("TRANSCRIPT");
  const [quality, setQuality] = useState("HD");
  const [subs, setSubs] = useState(false);
  const [aiTranscribe, setAiTranscribe] = useState(true);

  const [tasks, setTasks] = useState<QueueTask[]>([]);
  const [pinned, setPinned] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [statusLeft, setStatusLeft] = useState("");
  /** Share link for whatever is selected (a clip) or was just exported. */
  const [share, setShare] = useState<{ url: string; downloadCount: number } | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [retagging, setRetagging] = useState(false);

  const refreshLibrary = useCallback(async () => {
    const res = await fetch("/api/library");
    const body = await res.json();
    if (res.ok) {
      const list: LibraryRow[] = body.rows ?? [];
      setRows(list);
      setStatusLeft(`Library indexed — ${list.length} file(s)`);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshLibrary();
  }, [refreshLibrary]);

  // Defined before selectMedia, which depends on it — a const referenced from
  // a dependency array before its own declaration is a TDZ error at render.
  const loadTags = useCallback(async (videoId: string) => {
    const res = await fetch(`/api/videos/${videoId}/tags`);
    const body = await res.json().catch(() => ({}));
    // A 503 here means migration 0004 hasn't been run; the rest of the app is
    // unaffected, so this degrades to "no tags" rather than surfacing an error.
    setTags(res.ok ? (body.tags ?? []) : []);
  }, []);

  const selectMedia = useCallback(
    async (id: string, kind: "video" | "clip" = "video") => {
      setSelectedId(id);
      setInPoint(0);
      setOutPoint(0);
      setSegments([]);
      setTranscriptLoaded(false);
      setShare(null);
      setTags([]);

      // A clip is a finished artifact: it plays and it shares, but it has no
      // transcript of its own and nothing to re-export from.
      if (kind === "clip") {
        const res = await fetch(`/api/clips/${id}`);
        const body = await res.json();
        if (res.ok && body.clip) {
          setDetail({
            id: body.clip.id,
            title: body.clip.title || "Untitled clip",
            duration_seconds: body.clip.duration_seconds,
            size_bytes: body.clip.size_bytes,
            width: 0,
            height: 0,
            vcodec: "",
            acodec: "",
            fps: 0,
            created_at: body.clip.created_at,
            storage_path: body.clip.storage_path,
            is_clip: true,
          });
          if (body.playbackUrl) {
            setMedia({
              id: body.clip.id,
              title: body.clip.title || "Untitled clip",
              playbackUrl: body.playbackUrl,
              width: 0,
              height: 0,
              duration_seconds: body.clip.duration_seconds,
            });
          }
          if (body.shareUrl) {
            setShare({
              url: new URL(body.shareUrl, window.location.origin).toString(),
              downloadCount: body.downloadCount ?? 0,
            });
          }
        }
        return;
      }

      const res = await fetch(`/api/videos/${id}`);
      const body = await res.json();
      if (res.ok && body.video) {
        setDetail(body.video as DetailsRow);
        if (body.playbackUrl) {
          setMedia({
            id: body.video.id,
            title: body.video.title,
            playbackUrl: body.playbackUrl,
            width: body.video.width,
            height: body.video.height,
            duration_seconds: body.video.duration_seconds,
          });
        }
      }

      void loadTags(id);

      const tRes = await fetch(`/api/videos/${id}/transcript`);
      const tBody = await tRes.json();
      if (tRes.ok && tBody.transcript?.status === "ready") {
        setSegments(tBody.segments as Segment[]);
        setTranscriptLoaded(true);
      }
    },
    [loadTags],
  );

  const seek = useCallback((seconds: number) => {
    setSeekTo({ seconds, token: Date.now() });
  }, []);

  const doExport = useCallback(async () => {
    if (!media || outPoint <= inPoint) return;
    const taskId = crypto.randomUUID();
    setTasks((t) => [
      { id: taskId, kind: "Export", target: media.title, status: "Encoding…", pct: 0 },
      ...t,
    ]);
    setExporting(true);
    try {
      const res = await fetch("/api/clips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: media.id, inPoint, outPoint, aspectMode }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "export failed");
      setTasks((t) =>
        t.map((x) => (x.id === taskId ? { ...x, status: "Exported", pct: 100 } : x)),
      );
      // Surface the share link immediately — an export whose link you have to
      // go hunting for may as well not have produced one.
      setShare({
        url: new URL(body.shareUrl, window.location.origin).toString(),
        downloadCount: 0,
      });
      setStatusLeft(`Clip ready — ${(body.durationSeconds ?? 0).toFixed(1)}s`);
      void refreshLibrary();
    } catch (err) {
      setTasks((t) =>
        t.map((x) =>
          x.id === taskId
            ? { ...x, status: "Error", pct: null }
            : x,
        ),
      );
      setStatusLeft(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }, [media, inPoint, outPoint, aspectMode, refreshLibrary]);

  const patchTask = useCallback((taskId: string, fields: Partial<QueueTask>) => {
    setTasks((t) => t.map((x) => (x.id === taskId ? { ...x, ...fields } : x)));
  }, []);

  /**
   * Transcribe through the local agent and persist the result. Split out
   * because it runs both as the tail of a grab (when AI Transcribe is on) and
   * on its own for a file already in the library.
   */
  const runTranscription = useCallback(
    async (videoId: string, title: string) => {
      const taskId = crypto.randomUUID();
      setTasks((t) => [
        { id: taskId, kind: "Transcribe", target: title, status: "Loading model…", pct: null },
        ...t,
      ]);
      try {
        const startRes = await fetch(`/api/videos/${videoId}/transcripts`, { method: "POST" });
        const started = await startRes.json();
        if (!startRes.ok) throw new Error(started.error ?? "could not start transcript");

        patchTask(taskId, { status: "Transcribing…" });
        const result = await agentTranscribe(started.sourceUrl);

        patchTask(taskId, { status: `${result.segments.length} segments` });
        const segRes = await fetch(`/api/transcripts/${started.transcriptId}/segments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ segments: result.segments, language: result.language }),
        });
        if (!segRes.ok) throw new Error((await segRes.json()).error ?? "could not save transcript");

        patchTask(taskId, { status: "Complete", pct: 100 });
        return result.segments as Segment[];
      } catch (err) {
        patchTask(taskId, { status: "Error", pct: null });
        setStatusLeft(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [patchTask],
  );

  /**
   * Derive tags from a transcript via the local agent and store them as the
   * video's auto set. Manual tags are untouched — the API replaces only the
   * auto rows, which is what makes re-tagging safe to run whenever.
   *
   * Declared above onGrab, which calls it: a const referenced before its own
   * declaration is a temporal-dead-zone error, not a hoisted function.
   */
  const runTagging = useCallback(
    async (videoId: string, title: string, transcriptText: string, uploader?: string) => {
      const taskId = crypto.randomUUID();
      setTasks((t) => [
        { id: taskId, kind: "Tag", target: title, status: "Reading transcript…", pct: null },
        ...t,
      ]);
      try {
        const extra = [uploader].filter((x): x is string => Boolean(x && x.trim()));
        const { jobId } = await agentTag({ text: transcriptText, extra });
        const result = await waitForJobResult<{ tags: Array<{ label: string; kind: string }> }>(
          jobId,
          (status, pct) => patchTask(taskId, { status, pct }),
        );
        const res = await fetch(`/api/videos/${videoId}/tags`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ auto: result.tags }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "could not save tags");
        setTags(body.tags ?? []);
        patchTask(taskId, { status: "Complete", pct: 100 });
        void refreshLibrary();
      } catch (err) {
        patchTask(taskId, { status: "Error", pct: null });
        setStatusLeft(err instanceof Error ? err.message : String(err));
      }
    },
    [patchTask, refreshLibrary],
  );

  /**
   * GRAB and GO LIVE share everything except how the bytes are produced: both
   * need a library row first (that is what mints the signed upload URL the
   * agent PUTs to), and both finish the same way — patch the real metadata,
   * probe, refresh, optionally transcribe.
   */
  const onGrab = useCallback(
    async (url: string, live: boolean, options: CaptureOptions) => {
      const taskId = crypto.randomUUID();
      setTasks((t) => [
        {
          id: taskId,
          kind: live ? "Capture" : "Download",
          target: options.title || url,
          status: "Queued",
          pct: live ? null : 0,
        },
        ...t,
      ]);

      try {
        const createRes = await fetch("/api/videos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            // Placeholder; the real title arrives via PATCH once yt-dlp has
            // resolved the page (or the operator's override wins).
            title: (options.title || url).slice(0, 300),
            filename: live ? "capture.mp4" : "grab.mp4",
            mimeType: "video/mp4",
            sizeBytes: 0,
            sourceKind: "url",
            sourceUrl: url,
          }),
        });
        const created = await createRes.json();
        if (!createRes.ok) throw new Error(created.error ?? "could not create library row");

        const { jobId } = live
          ? await agentCapture({
              url,
              title: options.title,
              maxMinutes: options.maxMinutes,
              signedUrl: created.signedUrl,
            })
          : await agentGrab({ url, quality, subs, signedUrl: created.signedUrl });

        const done = await waitForJob(jobId, (job) => {
          patchTask(taskId, {
            status: job.status,
            pct: job.pct,
            target: job.detail || options.title || url,
            jobId,
            // Only offer STOP while it is actually recording — not while
            // resolving, remuxing, or uploading, where stopping means nothing.
            stoppable: live && job.status.startsWith("Recording"),
          });
        });

        patchTask(taskId, { stoppable: false });
        const meta = done.result;
        if (meta) {
          await fetch(`/api/videos/${created.videoId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: options.title || meta.title || url,
              uploader: meta.uploader || "",
              source_url: meta.sourceUrl || url,
              size_bytes: meta.sizeBytes || 0,
            }),
          });
        }

        patchTask(taskId, { status: "Probing…", pct: 99 });
        const finalizeRes = await fetch(`/api/videos/${created.videoId}/finalize`, { method: "POST" });
        if (!finalizeRes.ok) {
          throw new Error((await finalizeRes.json()).error ?? "probe failed");
        }

        patchTask(taskId, { status: live ? "Captured" : "Complete", pct: 100 });
        setStatusLeft(`${live ? "Captured" : "Downloaded"} — ${options.title || meta?.title || url}`);
        await refreshLibrary();
        await selectMedia(created.videoId);

        if (aiTranscribe) {
          const title = options.title || meta?.title || url;
          const segs = await runTranscription(created.videoId, title);
          if (segs) {
            setSegments(segs);
            setTranscriptLoaded(true);
            // Tags come straight off the fresh transcript — this is the moment
            // the material is understood, so it's the moment to describe it.
            await runTagging(
              created.videoId,
              title,
              segs.map((s) => s.text).join(" "),
              meta?.uploader,
            );
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        patchTask(taskId, { status: "Error", pct: null, stoppable: false });
        setStatusLeft(message);
      }
    },
    [quality, subs, aiTranscribe, patchTask, refreshLibrary, selectMedia, runTranscription, runTagging],
  );

  const addTag = useCallback(
    async (label: string) => {
      if (!selectedId) return;
      const res = await fetch(`/api/videos/${selectedId}/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatusLeft(body.error ?? "could not add tag");
        return;
      }
      setTags(body.tags ?? []);
      void refreshLibrary();
    },
    [selectedId, refreshLibrary],
  );

  const removeTag = useCallback(
    async (label: string) => {
      if (!selectedId) return;
      const res = await fetch(
        `/api/videos/${selectedId}/tags?label=${encodeURIComponent(label)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        setStatusLeft((await res.json().catch(() => ({}))).error ?? "could not remove tag");
        return;
      }
      setTags((t) => t.filter((x) => x.label !== label));
      void refreshLibrary();
    },
    [selectedId, refreshLibrary],
  );

  const retagCurrent = useCallback(async () => {
    if (!selectedId || segments.length === 0) return;
    setRetagging(true);
    try {
      await runTagging(
        selectedId,
        detail?.title ?? "",
        segments.map((s) => s.text).join(" "),
        detail?.uploader ?? undefined,
      );
    } finally {
      setRetagging(false);
    }
  }, [selectedId, segments, detail, runTagging]);

  const onStopTask = useCallback(
    async (task: QueueTask) => {
      if (!task.jobId) return;
      try {
        await agentStopJob(task.jobId);
        // Don't mark it finished here — the polling loop owns the status, and
        // the capture still has to remux and upload before it is really done.
        patchTask(task.id, { status: "Stopping…", stoppable: false });
      } catch (err) {
        setStatusLeft(err instanceof Error ? err.message : String(err));
      }
    },
    [patchTask],
  );

  return (
    <div className="flex h-full flex-col">
      {/* ---------- Header: wordmark · BASIQ STUDIO HUB · IngestBar ---------- */}
      <header className="header-bar flex items-center" style={{ padding: "14px 22px", gap: 14 }}>
        <Image
          src="/brand/wordmark.png"
          alt="Majority Democrats"
          height={46}
          width={150}
          priority
          style={{ height: 46, width: "auto" }}
        />
        <span className="section-label whitespace-nowrap">BASIQ STUDIO HUB</span>
        <span style={{ width: 18 }} />
        <IngestBar
          quality={quality}
          onQualityChange={setQuality}
          subs={subs}
          onSubsChange={setSubs}
          aiTranscribe={aiTranscribe}
          onAiTranscribeChange={setAiTranscribe}
          onGrab={(url, live, options) => void onGrab(url, live, options)}
        />
      </header>

      {/* ---------- Workspace: 20 / 55 / 25 ---------- */}
      <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: "20fr 55fr 25fr", gap: 6 }}>
        <LibraryPanel
          rows={rows}
          selectedId={selectedId}
          onSelect={(id) => {
            const row = rows.find((r) => r.id === id);
            void selectMedia(id, row?.kind ?? "video");
          }}
          onRescan={() => void refreshLibrary()}
          mediaRoot="Supabase · videos bucket"
        />

        <div className="flex min-h-0 flex-col" style={{ gap: 6 }}>
          <div className="min-h-0 flex-1">
            <PlayerPanel
              media={media}
              inPoint={inPoint}
              outPoint={outPoint}
              onMarkIn={setInPoint}
              onMarkOut={setOutPoint}
              onClearMarks={() => {
                setInPoint(0);
                setOutPoint(0);
              }}
              aspectMode={aspectMode}
              onAspectChange={setAspectMode}
              onExport={() => void doExport()}
              exporting={exporting}
              seekTo={seekTo}
            />
          </div>
          {share && (
            <ShareBar
              key={share.url}
              url={share.url}
              downloadCount={share.downloadCount}
              onDismiss={() => setShare(null)}
            />
          )}
        </div>

        <div className="panel flex min-h-0 flex-col">
          <div className="flex" style={{ background: "var(--bg-main)" }}>
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                className="tab"
                data-selected={tab === t ? "true" : undefined}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1">
            {tab === "TRANSCRIPT" && (
              <TranscriptPanel
                segments={segments}
                loaded={transcriptLoaded}
                emptyMessage={selectedId ? NO_TRANSCRIPT : "No transcript loaded."}
                position={position}
                onSeek={seek}
                onRangeSelected={(s, e) => {
                  setInPoint(s);
                  setOutPoint(e);
                  seek(s);
                  setStatusLeft(`Range set — ${(e - s).toFixed(1)}s selected`);
                }}
              />
            )}
            {tab === "KEY MOMENTS" && (
              <KeyMomentsPanel
                segments={segments}
                loaded={transcriptLoaded}
                emptyMessage={selectedId ? NO_TRANSCRIPT : "No transcript loaded yet."}
                onSeek={seek}
              />
            )}
            {tab === "DETAILS" && (
              <DetailsPanel
                row={detail}
                emptyMessage={selectedId ? "" : "No media loaded."}
                share={share}
                tags={tags}
                retagging={retagging}
                onAddTag={(label) => void addTag(label)}
                onRemoveTag={(label) => void removeTag(label)}
                onRetag={segments.length > 0 ? () => void retagCurrent() : undefined}
              />
            )}
          </div>
        </div>
      </div>

      {/* ---------- Queue drawer ---------- */}
      <QueuePanel
        tasks={tasks}
        pinned={pinned}
        onTogglePin={() => setPinned((p) => !p)}
        onStop={(task) => void onStopTask(task)}
        onClearFinished={() =>
          setTasks((t) =>
            t.filter(
              (x) =>
                !["Exported", "Complete", "Captured", "Error"].includes(x.status),
            ),
          )
        }
      />

      {/* ---------- Status bar ---------- */}
      <footer className="status-bar flex items-center" style={{ padding: "6px 14px" }}>
        <span className="status-ready">{statusLeft}</span>
        <span className="flex-1" />
        <span className="status-muted">all engines ready</span>
      </footer>
    </div>
  );
}
