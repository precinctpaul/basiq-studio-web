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

/** The desktop's 20/55/25 splitter proportions, and its queue dock height. */
const DEFAULT_COLS = { left: 20, center: 55, right: 25 };
const DEFAULT_QUEUE_HEIGHT = 190;
const LAYOUT_KEY = "basiq.layout";
/** Below this a column stops being usable rather than merely narrow. */
const MIN_COL_PCT = 12;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

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

  const [tasks, setTasks] = useState<QueueTask[]>([]);
  const [pinned, setPinned] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [statusLeft, setStatusLeft] = useState("");
  /** Share link for whatever is selected (a clip) or was just exported. */
  const [share, setShare] = useState<{ url: string; downloadCount: number } | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [retagging, setRetagging] = useState(false);
  const [captionsOn, setCaptionsOn] = useState(false);
  const [agentNote, setAgentNote] = useState("Checking agent…");
  /** Bumped by a library double-click so the player starts playing. */
  const [playToken, setPlayToken] = useState(0);

  // Layout. Percentages rather than pixels so a resized window keeps the
  // operator's proportions instead of stranding a column at a fixed width.
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(DEFAULT_COLS);
  const [queueHeight, setQueueHeight] = useState(DEFAULT_QUEUE_HEIGHT);

  // Restored after mount, never during render: reading localStorage while
  // rendering makes the server and client markup disagree.
  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(LAYOUT_KEY) || "null");
      if (!saved) return;
      // Restoring persisted layout is the "synchronise with an external
      // system" case effects exist for, and it cannot happen during render:
      // reading localStorage there makes server and client markup disagree.
      // Fires once, on mount.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCols((c) => (saved.cols ? saved.cols : c));
      setQueueHeight((h) => (typeof saved.queueHeight === "number" ? saved.queueHeight : h));
    } catch {
      /* corrupt or absent — the defaults are fine */
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify({ cols, queueHeight }));
  }, [cols, queueHeight]);

  /**
   * Move one divider. The dragged pair absorbs the whole delta between them,
   * leaving the third column untouched — dragging the left divider must not
   * reflow the right-hand panel out from under the operator.
   */
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

  /** The desktop's SAVE FOLDER chooses where downloads land. There is no such
   *  folder here — media goes straight to storage — so that slot reports the
   *  thing that genuinely can be misconfigured: the local agent. */
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
      // Purely informational here — onGrab/runLiveCapture each check the
      // drive fresh at the moment they need it, rather than trusting this
      // snapshot from whenever the agent was last checked.
      let root = "";
      try {
        const lib = await agentLibrary();
        root = lib.exists ? ` · ${lib.root}` : " · no shared drive";
      } catch {
        // Health already answered; a failed /library call just means no
        // drive info to append.
      }
      setAgentNote(`Agent ready · ${parts.join(" · ")}${root}`);
      setStatusLeft(`Local agent connected (${getAgentUrl()})`);
    } catch (err) {
      setAgentNote("Agent not running");
      setStatusLeft(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // One check at startup so the footer states the truth without being asked.
  useEffect(() => {
    // Reaching out to the agent on mount is a fetch, not derived state — the
    // rule fires because checkAgent sets a "Checking…" note before awaiting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void checkAgent();
  }, [checkAgent]);

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

  /**
   * RESCAN reads the shared drive through the local agent and reconciles it
   * with the library — this is what makes one library out of several
   * machines pointed at the same mounted folder.
   *
   * Falls back to a plain refresh when no agent is running, so the button
   * still does something useful on a browser with nothing installed.
   */
  const rescan = useCallback(async () => {
    setStatusLeft("Scanning the shared drive…");
    try {
      const lib = await agentLibrary();
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
      // Deleted, not just reported — but only ever when the scan actually
      // saw files at all; see /api/library/sync for why that guard matters.
      if (body.removed) bits.push(`${body.removed} removed (no longer on the drive)`);
      setStatusLeft(bits.join(" · "));
    } catch {
      await refreshLibrary();
      setStatusLeft("Local agent not running — showing the stored library only");
    }
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
        // A master on the shared drive streams from this machine's agent; a
        // stored one from a signed URL. Only the client can build the former,
        // since the agent's address is a per-machine setting.
        const playback = body.localPath ? agentMediaUrl(body.localPath) : body.playbackUrl;
        if (playback) {
          setMedia({
            id: body.video.id,
            title: body.video.title,
            playbackUrl: playback,
            width: body.video.width,
            height: body.video.height,
            duration_seconds: body.video.duration_seconds,
          });
        } else if (body.playbackError) {
          setStatusLeft(body.playbackError);
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

  // Declared above doExport, which calls it: a const referenced before its
  // own declaration is a temporal-dead-zone error at render.
  const patchTask = useCallback((taskId: string, fields: Partial<QueueTask>) => {
    setTasks((t) => t.map((x) => (x.id === taskId ? { ...x, ...fields } : x)));
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
      let body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "export failed");

      // The master is encoded by this machine's agent — the API hands back
      // the argv rather than a finished clip, because a serverless function
      // cannot reach a mounted volume. The agent files the result onto the
      // drive itself and reports where.
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
  }, [media, inPoint, outPoint, aspectMode, refreshLibrary, patchTask]);

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
        // A shared-drive master has no signed URL — the agent opens it directly.
        const result = await agentTranscribe(
          started.localPath
            ? { path: started.localPath as string }
            : { url: started.sourceUrl as string },
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
   * Transcribe, then derive tags from the result.
   *
   * Both grab paths end this way — shared drive and Supabase storage alike —
   * so the sequence lives in one place. It used to exist only on the storage
   * tail, below an early `return` in the shared-drive branch, which meant a
   * shared-drive grab silently produced no transcript, and therefore no key
   * moments, no auto-tags and no captions.
   */
  const transcribeAndTag = useCallback(
    async (videoId: string, title: string, uploader?: string) => {
      if (!videoId) return;
      const segs = await runTranscription(videoId, title);
      if (!segs) return;
      setSegments(segs);
      setTranscriptLoaded(true);
      // Tags come straight off the fresh transcript — this is the moment the
      // material is understood, so it's the moment to describe it.
      await runTagging(videoId, title, segs.map((s) => s.text).join(" "), uploader);
    },
    [runTranscription, runTagging],
  );

  /** How often a live capture's transcript catches up while it's still recording. */
  const LIVE_TRANSCRIBE_EVERY_SECONDS = 20;

  const requireSharedDrive = useCallback(async () => {
    const lib = await agentLibrary().catch(() => ({ exists: false, root: "" }));
    if (!lib.exists) {
      throw new Error(
        `Shared drive not mounted${lib.root ? ` at ${lib.root}` : ""} — check LucidLink, then press CHECK AGENT.`,
      );
    }
  }, []);

  /**
   * A finished download: the agent files it straight to the shared drive,
   * and the library SCAN is what creates its row (and probes it) — see
   * /api/library/sync. This only overlays what ffprobe can't know.
   */
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

      // When GRAB is delegated to a worker (tools/basiq_worker.py), the file
      // is written by the WORKER's LucidLink client, on a different machine
      // than the one this scan/transcribe/stream all run against. LucidLink
      // has to sync the finished file across before the cloud agent's mount
      // shows a complete copy — racing straight into rescan()/transcribe()
      // the instant the job says "Complete" is what produced "library row
      // could not be found", 416s on playback, and 500s from the
      // transcriber, all from reading a still-syncing file. Wait for the
      // cloud's own view of the file to report a stable, non-zero size
      // across two consecutive checks (Fibonacci-ish backoff, ~52s worst
      // case) before doing anything else with it.
      if (meta?.localPath) {
        patchTask(taskId, { status: "Waiting for the shared drive to sync…", pct: 99 });
        const SYNC_WAIT_DELAYS_MS = [2000, 3000, 5000, 8000, 13000, 21000];
        let lastSize = -1;
        for (const delay of SYNC_WAIT_DELAYS_MS) {
          const lib = await agentLibrary().catch(() => null);
          const found = lib?.files.find((f) => f.path === meta.localPath);
          if (found && found.sizeBytes > 0 && found.sizeBytes === lastSize) break;
          if (found) lastSize = found.sizeBytes;
          await new Promise((r) => setTimeout(r, delay));
        }
      }

      patchTask(taskId, { status: "Indexing…", pct: 99 });
      await rescan();
      setStatusLeft(`Filed to the shared drive — ${options.title || meta?.title || url}`);

      // Match on local_path, not title: store_in_media_root sanitises the
      // title into a filename and de-duplicates with a " (2)" suffix, so the
      // row's title and yt-dlp's title routinely differ.
      const listRes = await fetch("/api/library");
      const listBody = await listRes.json();
      const match = (listBody.rows ?? []).find(
        (r: LibraryRow & { local_path?: string }) =>
          r.kind === "video" && Boolean(meta?.localPath) && r.local_path === meta?.localPath,
      );
      if (!match) {
        patchTask(taskId, { status: "Error", pct: null });
        setStatusLeft(
          "Filed to the drive, but its library row still isn't visible — the shared drive may still be syncing it across. Press RESCAN in a moment.",
        );
        return;
      }

      // The drive scan only knows what ffprobe can see. Everything yt-dlp
      // resolved — real title, uploader, source page — has to be written
      // here or the DETAILS pane stays empty.
      if (meta) {
        await fetch(`/api/videos/${match.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: options.title || meta.title || match.title,
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
      await selectMedia(match.id, "video");
      await transcribeAndTag(match.id, options.title || meta?.title || match.title, meta?.uploader);
    },
    [quality, requireSharedDrive, patchTask, refreshLibrary, rescan, selectMedia, transcribeAndTag],
  );

  /**
   * A live capture. Unlike a grab, the row is created the moment the agent
   * reserves a destination on the drive — well before the recording ends —
   * so the operator can watch its transcript grow and clip from it live.
   * See tools/basiq_agent.py's run_live_capture and /transcribe's
   * startSeconds for the two halves of this on the agent side.
   */
  const runLiveCapture = useCallback(
    async (taskId: string, url: string, options: CaptureOptions) => {
      await requireSharedDrive();
      const { jobId } = await agentCapture({ url, title: options.title, maxMinutes: options.maxMinutes });

      let liveVideoId = "";
      let liveTranscriptId = "";
      let liveSegments: Segment[] = [];
      let transcribedThrough = 0;
      let finalJob: Awaited<ReturnType<typeof agentJob>> | null = null;

      const saveSegments = async () => {
        if (!liveTranscriptId || !liveSegments.length) return;
        await fetch(`/api/transcripts/${liveTranscriptId}/segments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ segments: liveSegments }),
        });
        setSegments(liveSegments);
        setTranscriptLoaded(true);
      };

      for (;;) {
        const job = await agentJob(jobId);
        patchTask(taskId, {
          status: job.status, pct: job.pct, target: job.detail || options.title || url, jobId,
          // Only offer STOP while it is actually recording — not while
          // resolving or remuxing, where stopping means nothing.
          stoppable: job.status.startsWith("Recording"),
        });

        // The destination is reserved (and reported) well before the first
        // second records — that is what lets the row, and its transcript,
        // exist while the stream is still going.
        if (!liveVideoId && job.local_path) {
          try {
            const createRes = await fetch("/api/videos", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
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
          } catch {
            // Try again next tick — a transient failure here shouldn't end
            // a recording that is otherwise proceeding fine.
          }
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
              await saveSegments();
            }
          } catch {
            // A missed poll just means fewer words on screen for a moment —
            // the next tick re-covers the same range and tries again.
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

      // One last pass over whatever the ~20s cadence hadn't swept up yet,
      // reading from wherever the recording ended up — a successful remux
      // renames it from .ts to .mp4, and the .ts is gone by this point.
      try {
        const result = await agentTranscribe({ path: meta.localPath }, transcribedThrough);
        if (result.segments.length) liveSegments = [...liveSegments, ...result.segments];
      } catch {
        // Best-effort — a live transcript a few seconds short of the true
        // end is still a live transcript.
      }
      await saveSegments();

      // Probe fields come from the SAME agent scan the client already has
      // access to, not from a library rescan: sync()'s update path resets
      // title to the sanitised filename whenever size/duration changed,
      // which is exactly what just happened to a file that finished
      // recording. Setting everything in one PATCH sidesteps that clobber.
      let probed: Awaited<ReturnType<typeof agentLibrary>>["files"][number] | undefined;
      try {
        probed = (await agentLibrary()).files.find((f) => f.path === meta.localPath);
      } catch {
        // No probe data available this tick — the PATCH below still moves
        // the row out of 'recording'; a later rescan fills duration/width in.
      }

      await fetch(`/api/videos/${liveVideoId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: options.title || meta.title || url,
          source_url: meta.sourceUrl || url,
          size_bytes: meta.sizeBytes || 0,
          local_path: meta.localPath,
          status: "ready",
          ...(probed && {
            duration_seconds: probed.duration,
            width: probed.width,
            height: probed.height,
            fps: probed.fps,
            has_video: probed.hasVideo,
            has_audio: probed.hasAudio,
            vcodec: probed.vcodec,
            acodec: probed.acodec,
          }),
        }),
      });
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
          onGrab={(url, live, options) => void onGrab(url, live, options)}
        />
      </header>

      {/* ---------- Workspace: 20 / 55 / 25, draggable ---------- */}
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
              onExport={() => void doExport()}
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
          {/* All three stay MOUNTED and are hidden with CSS rather than
              unmounted on tab change. Unmounting threw away Key Moments'
              loaded state, so every return to the tab replayed the whole
              build; it also lost transcript scroll position and any search
              term. Hiding costs nothing — none of them poll. */}
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

      {/* ---------- Queue drawer ---------- */}
      <Splitter
        orientation="horizontal"
        onDrag={(dy) => setQueueHeight((h) => clamp(h - dy, 90, 520))}
        onDoubleClick={() => setQueueHeight(DEFAULT_QUEUE_HEIGHT)}
      />
      <QueuePanel
        height={queueHeight}
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
