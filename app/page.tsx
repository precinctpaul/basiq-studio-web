"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { IngestBar, type CaptureOptions } from "@/components/studio/IngestBar";
import { LibraryPanel, type LibraryRow } from "@/components/studio/LibraryPanel";
import { PlayerPanel, type PlayerMedia } from "@/components/studio/PlayerPanel";
import { TranscriptPanel } from "@/components/studio/TranscriptPanel";
import { KeyMomentsPanel } from "@/components/studio/KeyMomentsPanel";
import { DetailsPanel, type DetailsRow, type Tag } from "@/components/studio/DetailsPanel";
import { QueuePanel, type QueueTask } from "@/components/studio/QueuePanel";
import { ShareBar } from "@/components/studio/ShareBar";
import { Splitter } from "@/components/studio/Splitter";
import {
  agentCapture,
  agentExport,
  agentGrab,
  agentHealth,
  agentJob,
  agentLibrary,
  agentMediaUrl,
  agentStopJob,
  agentTag,
  agentTranscribe,
  getAgentUrl,
  waitForJob,
  waitForJobResult,
} from "@/lib/agent";
import type { Segment } from "@/lib/paragraphs";

const TABS = ["TRANSCRIPT", "KEY MOMENTS", "DETAILS"] as const;
type Tab = (typeof TABS)[number];
// Key Moments is hidden from the tab bar for now (2026-08-27) -- distracting
// for users while the feature settles. TABS/Tab and the panel below are left
// untouched, so re-enabling this later is just deleting this one filter.
const VISIBLE_TABS = TABS.filter((t) => t !== "KEY MOMENTS");

const DEFAULT_COLS = { left: 20, center: 55, right: 25 };
const DEFAULT_QUEUE_HEIGHT = 190;
const LAYOUT_KEY = "basiq.layout";
const MIN_COL_PCT = 12;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const NO_TRANSCRIPT = "No transcript for this file yet.\n\nTranscription starts automatically after GRAB or UPLOAD FILE.";

export default function Studio() {
  const [rows, setRows] = useState<LibraryRow[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");

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

  const [tasks, setTasks] = useState<QueueTask[]>([]);
  const [exporting, setExporting] = useState(false);
  const [statusLeft, setStatusLeft] = useState("");
  const [share, setShare] = useState<{ url: string; downloadCount: number } | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [retagging, setRetagging] = useState(false);
  const [captionsOn, setCaptionsOn] = useState(false);
  const [agentNote, setAgentNote] = useState("Checking agent…");
  const [playToken, setPlayToken] = useState(0);

  useEffect(() => {
    const handleQueueEvent = (e: Event) => {
      const { detail } = e as CustomEvent;
      setTasks((t) => {
        const existing = t.find((x) => x.id === detail.id);
        if (existing) {
          return t.map((x) => (x.id === detail.id ? { ...x, ...detail } : x));
        }
        return [
          { id: detail.id, kind: detail.kind, target: detail.target, status: detail.status, pct: detail.pct },
          ...t,
        ];
      });
    };

    window.addEventListener("basiq:queue", handleQueueEvent);
    return () => window.removeEventListener("basiq:queue", handleQueueEvent);
  }, []);

  const workspaceRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(DEFAULT_COLS);
  const [queueHeight, setQueueHeight] = useState(DEFAULT_QUEUE_HEIGHT);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(LAYOUT_KEY) || "null");
      if (!saved) return;
      setCols((c) => (saved.cols ? saved.cols : c));
      setQueueHeight((h) => (typeof saved.queueHeight === "number" ? saved.queueHeight : h));
    } catch {}
  }, []);

  useEffect(() => {
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify({ cols, queueHeight }));
  }, [cols, queueHeight]);

  const resizeColumns = useCallback((which: "left" | "right", deltaPx: number) => {
    const width = workspaceRef.current?.clientWidth ?? 0;
    if (width <= 0) return;
    const deltaPct = (deltaPx / width) * 100;
    setCols((c) => {
      if (which === "left") {
        const left = clamp(c.left + deltaPct, MIN_COL_PCT, 100 - MIN_COL_PCT * 2);
        const center = c.center + (c.left - left);
        if (center < MIN_COL_PCT) return c;
        return { ...c, left, center };
      }
      const right = clamp(c.right - deltaPct, MIN_COL_PCT, 100 - MIN_COL_PCT * 2);
      const center = c.center + (c.right - right);
      if (center < MIN_COL_PCT) return c;
      return { ...c, center, right };
    });
  }, []);

  const resetColumns = useCallback(() => setCols(DEFAULT_COLS), []);

  const checkAgent = useCallback(async () => {
    setAgentNote("Checking agent…");
    try {
      const health = await agentHealth();
      const parts = [
        health.whisper ? "whisper" : null,
        health.ytdlp ? "yt-dlp" : null,
        health.summarizer ? "summaries" : null,
        health.tagger ? "tags" : null,
      ].filter(Boolean);
      let root = "";
      try {
        const lib = await agentLibrary();
        root = lib.exists ? ` · ${lib.root}` : " · no shared drive";
      } catch {}
      setAgentNote(`Agent ready · ${parts.join(" · ")}${root}`);
      setStatusLeft(`Local agent connected (${getAgentUrl()})`);
    } catch (err) {
      setAgentNote("Agent not running");
      setStatusLeft(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void checkAgent();
  }, [checkAgent]);

  /** Guards against a burst of overlapping /api/library calls. With a
   *  multi-thousand-video library, `hasMore` almost never turns itself off,
   *  so if anything (a scroll listener, a re-render, an eager loader) asks
   *  for the next page before the previous one has finished, the requests
   *  pile up and can take the whole database connection pool down with
   *  them at once. Only one fetch is ever allowed in flight; anything else
   *  asking for a page while that's happening is simply ignored. */
  const isFetchingRef = useRef(false);

  const refreshLibrary = useCallback(async (pageNum = 0, query = searchTerm) => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    try {
      const res = await fetch(`/api/library?page=${pageNum}&limit=100&search=${encodeURIComponent(query)}`);
      const body = await res.json();
      if (res.ok) {
        const list: LibraryRow[] = body.rows ?? [];
        if (list.length < 100) setHasMore(false);
        else setHasMore(true);

        setRows((prev) => {
          const nextRows = pageNum === 0 ? list : [...prev, ...list];
          setStatusLeft(`Library indexed — ${nextRows.length} file(s)`);
          return nextRows;
        });
      } else {
        setStatusLeft(body.error ? `Library error: ${body.error}` : "Library request failed");
      }
    } catch (err: any) {
      setStatusLeft(`Library request failed: ${err?.message || err}`);
    } finally {
      isFetchingRef.current = false;
    }
  }, [searchTerm]);

  const searchTimerRef = useRef<NodeJS.Timeout | null>(null);

  const handleSearch = useCallback((term: string) => {
    setSearchTerm(term);
    setPage(0);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      void refreshLibrary(0, term);
    }, 300);
  }, [refreshLibrary]);

  const loadMore = () => {
    if (isFetchingRef.current || !hasMore) return;
    const next = page + 1;
    setPage(next);
    void refreshLibrary(next, searchTerm);
  };

  useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary]);

  const rescan = useCallback(async () => {
    setStatusLeft("Scanning the shared drive…");
    try {
      const lib = await agentLibrary(true);
      if (!lib.exists) {
        setStatusLeft(`Shared drive not found at ${lib.root} — set MEDIA_ROOT for the agent`);
        await refreshLibrary();
        return;
      }
      const res = await fetch("/api/library/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: lib.files }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "sync failed");
      await refreshLibrary();
      const bits = [`${body.total} file(s) on the drive`];
      if (body.added) bits.push(`${body.added} new`);
      if (body.updated) bits.push(`${body.updated} updated`);
      if (body.removed) bits.push(`${body.removed} removed (no longer on the drive)`);
      setStatusLeft(bits.join(" · "));
    } catch {
      await refreshLibrary();
      setStatusLeft("Local agent not running — showing the stored library only");
    }
  }, [refreshLibrary]);

  const loadTags = useCallback(async (videoId: string) => {
    const res = await fetch(`/api/videos/${videoId}/tags`);
    const body = await res.json().catch(() => ({}));
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
            local_path: body.clip.local_path,
            is_clip: true,
          });
          if (body.localPath) {
            setMedia({
              id: body.clip.id,
              title: body.clip.title || "Untitled clip",
              playbackUrl: agentMediaUrl(body.localPath),
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
        const playback = body.localPath ? agentMediaUrl(body.localPath) : body.playbackUrl;
        if (playback) {
          const isRecordingTs = body.video.status === "recording" || body.localPath?.endsWith(".ts");
          setMedia({
            id: body.video.id,
            title: body.video.title,
            playbackUrl: isRecordingTs ? "" : playback,
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

  const patchTask = useCallback((taskId: string, fields: Partial<QueueTask>) => {
    setTasks((t) => t.map((x) => (x.id === taskId ? { ...x, ...fields } : x)));
  }, []);

  const doExport = useCallback(async (cropOffsetX: number = 0, cropOffsetY: number = 0) => {
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
        body: JSON.stringify({ videoId: media.id, inPoint, outPoint, aspectMode, cropOffsetX, cropOffsetY }),
      });
      let body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "export failed");

      patchTask(taskId, { status: "Encoding locally…", pct: 10 });
      const { jobId } = await agentExport({
        args: body.args,
        localPath: body.localPath,
        title: body.title,
      });
      const done = await waitForJobResult<{ sizeBytes: number; localPath: string }>(
        jobId,
        (status, pct) => patchTask(taskId, { status, pct }),
      );
      const completed = await fetch(`/api/clips/${body.clipId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          localPath: done?.localPath ?? "",
          sizeBytes: done?.sizeBytes ?? 0,
        }),
      });
      const completedBody = await completed.json();
      if (!completed.ok) throw new Error(completedBody.error ?? "could not finish the clip");
      body = completedBody;

      setTasks((t) =>
        t.map((x) => (x.id === taskId ? { ...x, status: "Exported", pct: 100 } : x)),
      );
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
  }, [media, inPoint, outPoint, aspectMode, refreshLibrary, patchTask]);

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
        const result = await agentTranscribe(
          started.localPath
            ? { path: started.localPath as string }
            : { url: started.sourceUrl as string },
          0,
          (status, pct) => patchTask(taskId, { status, pct })
        );

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

  const transcribeAndTag = useCallback(
    async (videoId: string, title: string, uploader?: string) => {
      if (!videoId) return;
      const segs = await runTranscription(videoId, title);
      if (!segs) return;
      setSegments(segs);
      setTranscriptLoaded(true);
      await runTagging(videoId, title, segs.map((s) => s.text).join(" "), uploader);
    },
    [runTranscription, runTagging],
  );

  const LIVE_TRANSCRIBE_EVERY_SECONDS = 20;

  const requireSharedDrive = useCallback(async () => {
    const lib = await agentLibrary().catch(() => ({ exists: false, root: "" }));
    if (!lib.exists) {
      throw new Error(
        `Shared drive not mounted${lib.root ? ` at ${lib.root}` : ""} — check LucidLink, then press CHECK AGENT.`,
      );
    }
  }, []);

  const runGrab = useCallback(
    async (taskId: string, url: string, options: CaptureOptions) => {
      await requireSharedDrive();
      const { jobId } = await agentGrab({ url, quality, subs: true });
      const done = await waitForJob(jobId, (job) => {
        patchTask(taskId, {
          status: job.status, pct: job.pct, target: job.detail || options.title || url, jobId,
        });
      });
      patchTask(taskId, { stoppable: false });
      const meta = done.result;

      // The "wait for the shared drive to sync" loop that used to live here
      // (up to 52s of fixed delays, plus up to 6 more agentLibrary() round
      // trips on top -- measured at ~78s real-world in a HAR/log capture on
      // 2026-08-27) was re-verifying something basiq_agent.py's run_grab
      // already guarantees before it ever reports "Complete": the file is
      // fully written, already probed (real size/duration/width/height/
      // codecs), and the DB row already holds those real values -- see
      // _grab_once's probe_media() call and _db_request write. There's
      // nothing left here to wait for.

      patchTask(taskId, { status: "Indexing…", pct: 99 });
      await rescan();
      setStatusLeft(`Filed to the shared drive — ${options.title || meta?.title || url}`);

      // jobId IS the video's DB row id -- basiq_agent.py's _grab_once
      // writes {"id": job_id, ...} directly (see video_payload), so there
      // was never a need to fetch the whole library and search for a
      // local_path match, the way this used to work. That bare
      // fetch("/api/library") (no page/limit params) was the single
      // biggest cost in the entire grab pipeline -- measured at 24s in a
      // HAR capture on 2026-08-27, because the route's default limit
      // (500, not the usual paginated 50) blew up the tags .in() lookup
      // that follows it in app/api/library/route.ts. A direct-by-id fetch
      // is a primary-key lookup, not a library-wide scan.
      const videoRes = await fetch(`/api/videos/${jobId}`);
      if (!videoRes.ok) {
        patchTask(taskId, { status: "Error", pct: null });
        setStatusLeft(
          "Filed to the drive, but its library row isn't visible yet — press RESCAN in a moment.",
        );
        return;
      }
      const { video: match } = await videoRes.json();

      if (meta) {
        await fetch(`/api/videos/${jobId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: options.title || meta.title || match?.title,
            uploader: meta.uploader || "",
            channel: meta.channel || "",
            upload_date: meta.uploadDate || "",
            source_url: meta.sourceUrl || url,
            size_bytes: meta.sizeBytes || 0,
          }),
        });
        await refreshLibrary();
      }

      patchTask(taskId, { status: "Complete", pct: 100 });
      await selectMedia(jobId, "video");
      await transcribeAndTag(jobId, options.title || meta?.title || match?.title, meta?.uploader);
    },
    [quality, requireSharedDrive, patchTask, refreshLibrary, rescan, selectMedia, transcribeAndTag],
  );

  const runLiveCapture = useCallback(
    async (taskId: string, url: string, options: CaptureOptions) => {
      await requireSharedDrive();
      const { jobId } = await agentCapture({ url, title: options.title, maxMinutes: options.maxMinutes });

      let liveVideoId = "";
      let liveTranscriptId = "";
      let liveSegments: Segment[] = [];
      let transcribedThrough = 0;
      let finalJob: Awaited<ReturnType<typeof agentJob>> | null = null;

      const saveSegments = async (newSegs: Segment[]) => {
        if (!liveTranscriptId || !newSegs.length) return;
        await fetch(`/api/transcripts/${liveTranscriptId}/segments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ segments: newSegs }),
        });
        setSegments((prev) => [...prev, ...newSegs]);
        setTranscriptLoaded(true);
      };

      for (;;) {
        const job = await agentJob(jobId);
        patchTask(taskId, {
          status: job.status, pct: job.pct, target: job.detail || options.title || url, jobId,
          stoppable: job.status.startsWith("Recording"),
        });

        if (!liveVideoId && job.local_path) {
          try {
            const createRes = await fetch("/api/videos", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                id: jobId,
                title: (options.title || job.detail || url).slice(0, 300),
                sourceUrl: url,
                localPath: job.local_path,
              }),
            });
            const createBody = await createRes.json();
            if (createRes.ok) {
              liveVideoId = createBody.videoId;
              await refreshLibrary();
              await selectMedia(liveVideoId, "video");
              const tRes = await fetch(`/api/videos/${liveVideoId}/transcripts`, { method: "POST" });
              const tBody = await tRes.json();
              if (tRes.ok) liveTranscriptId = tBody.transcriptId;
            }
          } catch {}
        }

        if (
          liveTranscriptId && job.local_path && job.status.startsWith("Recording") &&
          (job.seconds ?? 0) - transcribedThrough >= LIVE_TRANSCRIBE_EVERY_SECONDS
        ) {
          const from = transcribedThrough;
          transcribedThrough = job.seconds ?? transcribedThrough;
          try {
            const result = await agentTranscribe({ path: job.local_path }, from);
            if (result.segments.length) {
              liveSegments = [...liveSegments, ...result.segments];
              await saveSegments(result.segments as Segment[]);
            }
          } catch {
            transcribedThrough = from;
          }
        }

        if (job.status === "Complete") { finalJob = job; break; }
        if (job.status === "Error") throw new Error(job.error || "capture failed");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      patchTask(taskId, { stoppable: false });
      const meta = finalJob?.result;
      if (!liveVideoId || !meta?.localPath) {
        throw new Error("capture ended before a recording ever started");
      }

      try {
        const result = await agentTranscribe({ path: meta.localPath }, transcribedThrough);
        if (result.segments.length) {
          liveSegments = [...liveSegments, ...result.segments];
          await saveSegments(result.segments as Segment[]);
        }
      } catch {}

      // duration_seconds/width/height/fps/vcodec/acodec are no longer set
      // here. They used to come from agentLibrary(), but that function is
      // DB-first (see lib/agent.ts) -- it reads /api/library, which at this
      // exact moment is the SAME row this PATCH is about to update, so the
      // lookup always found the row with its probe fields still at their
      // just-created zero defaults and dutifully wrote those zeros right
      // back. basiq_agent.py's run_live_capture now probes the real final
      // file and writes these fields directly to the DB the moment the
      // capture finishes, before this code even starts polling for
      // "Complete" -- so by the time this PATCH fires, they're already
      // correct, and re-sending stale zeros here would only overwrite them.
      const finalizeRes = await fetch(`/api/videos/${liveVideoId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: options.title || meta.title || url,
          source_url: meta.sourceUrl || url,
          size_bytes: meta.sizeBytes || 0,
          local_path: meta.localPath,
          status: "ready",
        }),
      });
      if (!finalizeRes.ok) {
        // Previously swallowed silently -- a collision (or any other
        // failure) here left the row stuck at status "recording" forever
        // with no visible error. Surface it instead of pressing on.
        const finalizeBody = await finalizeRes.json().catch(() => ({}));
        throw new Error(
          finalizeBody.error || `could not finalize the capture (status ${finalizeRes.status})`,
        );
      }
      await rescan();
      await refreshLibrary();
      await selectMedia(liveVideoId, "video");

      patchTask(taskId, { status: "Captured", pct: 100 });
      setStatusLeft(`Captured — ${options.title || meta.title || url}`);
      await transcribeAndTag(liveVideoId, options.title || meta.title || url, meta.uploader);
    },
    [
      requireSharedDrive, patchTask, refreshLibrary, rescan, selectMedia,
      transcribeAndTag, LIVE_TRANSCRIBE_EVERY_SECONDS,
    ],
  );

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
        if (live) await runLiveCapture(taskId, url, options);
        else await runGrab(taskId, url, options);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        patchTask(taskId, { status: "Error", pct: null, stoppable: false });
        setStatusLeft(message);
      }
    },
    [runGrab, runLiveCapture, patchTask],
  );

  const onUploadFinished = useCallback(
    async (path: string, filename: string) => {
      setStatusLeft("Indexing…");
      await rescan();

      const listRes = await fetch("/api/library");
      const listBody = await listRes.json();
      const match = (listBody.rows ?? []).find(
        (r: LibraryRow & { local_path?: string }) => r.kind === "video" && r.local_path === path,
      );
      if (!match) {
        setStatusLeft(
          "Uploaded, but its library row still isn't visible — the shared drive may still be syncing it. Press RESCAN in a moment.",
        );
        return;
      }

      setStatusLeft(`Uploaded — ${filename}`);
      await selectMedia(match.id, "video");
      await transcribeAndTag(match.id, filename);
    },
    [rescan, selectMedia, transcribeAndTag],
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
        patchTask(task.id, { status: "Stopping…", stoppable: false });
      } catch (err) {
        setStatusLeft(err instanceof Error ? err.message : String(err));
      }
    },
    [patchTask],
  );

  return (
    <div className="flex h-full flex-col">
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
          onGrab={(url, live, options) => void onGrab(url, live, options)}
          onUploadComplete={(path, filename) => void onUploadFinished(path, filename)}
        />
      </header>

      <div ref={workspaceRef} className="flex min-h-0 flex-1">
        <div style={{ width: `${cols.left}%` }} className="min-w-0">
          <LibraryPanel
            rows={rows}
            selectedId={selectedId}
            onSelect={(id) => {
              const row = rows.find((r) => r.id === id);
              void selectMedia(id, row?.kind ?? "video");
            }}
            onActivate={(id) => {
              const row = rows.find((r) => r.id === id);
              void selectMedia(id, row?.kind ?? "video").then(() =>
                setPlayToken((n) => n + 1),
              );
            }}
            onRescan={() => void rescan()}
            onAgentCheck={() => void checkAgent()}
            mediaRoot={agentNote}
            onLoadMore={loadMore}
            hasMore={hasMore}
            onSearch={handleSearch}
          />
        </div>

        <Splitter
          orientation="vertical"
          onDrag={(dx) => resizeColumns("left", dx)}
          onDoubleClick={resetColumns}
        />

        <div className="flex min-h-0 flex-col" style={{ width: `${cols.center}%`, gap: 6 }}>
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
              onExport={(x, y) => void doExport(x, y)}
              exporting={exporting}
              seekTo={seekTo}
              playToken={playToken}
              captionsUrl={
                transcriptLoaded && selectedId ? `/api/videos/${selectedId}/captions` : null
              }
              captionsOn={captionsOn}
              onToggleCaptions={() => setCaptionsOn((v) => !v)}
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

        <Splitter
          orientation="vertical"
          onDrag={(dx) => resizeColumns("right", dx)}
          onDoubleClick={resetColumns}
        />

        <div className="panel flex min-h-0 flex-col" style={{ width: `${cols.right}%` }}>
          <div className="flex" style={{ background: "var(--bg-main)" }}>
            {VISIBLE_TABS.map((t) => (
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
          <div className="relative min-h-0 flex-1">
            <div className="absolute inset-0" hidden={tab !== "TRANSCRIPT"}>
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
            </div>
            <div className="absolute inset-0" hidden={tab !== "KEY MOMENTS"}>
              <KeyMomentsPanel
                key={selectedId ?? "none"}
                videoId={selectedId}
                hasTranscript={transcriptLoaded}
                emptyMessage={selectedId ? NO_TRANSCRIPT : "No transcript loaded yet."}
                onSeek={seek}
              />
            </div>
            <div className="absolute inset-0" hidden={tab !== "DETAILS"}>
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
            </div>
          </div>
        </div>
      </div>

      <Splitter
        orientation="horizontal"
        onDrag={(dy) => setQueueHeight((h) => clamp(h - dy, 90, 520))}
        onDoubleClick={() => setQueueHeight(DEFAULT_QUEUE_HEIGHT)}
      />
      <QueuePanel
        height={queueHeight}
        tasks={tasks}
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

      <footer className="status-bar flex items-center" style={{ padding: "6px 14px" }}>
        <span className="status-ready">{statusLeft}</span>
        <span className="flex-1" />
        <span className="status-muted">all engines ready</span>
      </footer>
    </div>
  );
}