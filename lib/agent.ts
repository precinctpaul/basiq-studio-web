"use client";

/**
 * agent.ts — client for the local companion agent (tools/basiq_agent.py).
 *
 * The browser talks to the agent DIRECTLY, never through a Vercel function:
 * the agent lives on the operator's machine and a serverless function has no
 * route to it. That is also why the media bytes never pass through here —
 * every grab, capture and export is filed straight onto the shared drive by
 * the agent itself, which returns a path relative to MEDIA_ROOT rather than
 * a URL. There is no bucket in this app anymore; if the drive isn't mounted,
 * the operation fails loudly instead of falling back to one.
 */

const STORAGE_KEY = "basiq.agentUrl";

export function defaultAgentUrl(): string {
  return process.env.NEXT_PUBLIC_WHISPER_URL || "http://127.0.0.1:8000";
}

export function getAgentUrl(): string {
  if (typeof window === "undefined") return defaultAgentUrl();
  return (window.localStorage.getItem(STORAGE_KEY) || defaultAgentUrl()).replace(/\/$/, "");
}

export function setAgentUrl(url: string): void {
  window.localStorage.setItem(STORAGE_KEY, url.trim().replace(/\/$/, ""));
  window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
}

export interface AgentLibraryFile {
  path: string;
  name: string;
  sizeBytes: number;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
  vcodec: string;
  acodec: string;
}

/** Everything the agent can see on the shared drive. */
export function agentLibrary(): Promise<{
  root: string;
  exists: boolean;
  files: AgentLibraryFile[];
}> {
  return call("/library");
}

/**
 * Playback URL for a master on the shared drive.
 *
 * Built here rather than server-side because the agent's address is a
 * per-machine setting — the app on Vercel has no idea (and no route) to
 * whichever port a given teammate's agent is on.
 */
export function agentMediaUrl(localPath: string, opts?: { download?: boolean }): string {
  const path = localPath.split("/").map(encodeURIComponent).join("/");
  const params = new URLSearchParams();
  if (opts?.download) params.set("download", "1");
  // <video src> and <a download> can't attach an Authorization header, so the
  // token rides along as a query param for this endpoint only.
  const token = process.env.NEXT_PUBLIC_WHISPER_AUTH_TOKEN;
  if (token) params.set("token", token);
  const qs = params.toString();
  return `${getAgentUrl()}/media/${path}${qs ? `?${qs}` : ""}`;
}

export interface AgentHealth {
  status: string;
  model: string;
  whisper: boolean;
  ytdlp: boolean;
  /** Optional intelligence layer — absent means the UI must offer the
   *  documented fallbacks (keyword labels, metadata-only tags) honestly. */
  summarizer: boolean;
  tagger: boolean;
}

export interface AgentJob {
  status: string;
  pct: number | null;
  detail: string;
  error: string;
  /** Live captures only — elapsed seconds and bytes written so far. */
  seconds?: number;
  bytes_written?: number;
  /**
   * A live capture's destination on the shared drive, set the moment the
   * name is reserved — well before "Complete". This is what lets the caller
   * create the video row and start polling for a transcript while the
   * recording is still running, instead of waiting for the whole thing to
   * finish first.
   */
  local_path?: string;
  result: {
    title: string;
    sizeBytes: number;
    ext: string;
    uploader: string;
    /** Distinct from uploader — yt-dlp's `channel`/`channel_id`, when the site has one. */
    channel: string;
    uploadDate: string;
    sourceUrl: string;
    durationSeconds?: number;
    isLive?: boolean;
    /** Set when the master was filed to the shared drive instead of uploaded. */
    localPath?: string;
  } | null;
}

/** Job payloads for the analysis endpoints, which return data rather than media. */
export interface AgentTagResult {
  tags: AgentTag[];
}
export interface AgentSummaryResult {
  summaries: Array<string | null>;
}

/** Distinct from a generic failure so callers can say "start the agent" rather
 *  than surfacing a raw TypeError from fetch. */
export class AgentUnreachable extends Error {
  constructor(url: string) {
    super(
      `Can't reach the local agent at ${url}. Start it with:  python tools/basiq_agent.py`,
    );
    this.name = "AgentUnreachable";
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const base = getAgentUrl();
  const token = process.env.NEXT_PUBLIC_WHISPER_AUTH_TOKEN;
  const headers = new Headers(init?.headers ?? {});
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  let res: Response;
  try {
    // Without a timeout, a fetch to a port nobody is listening on rejects
    // almost instantly (connection refused) — but a machine where the agent
    // process exists yet is wedged (model load hung, deadlocked thread) just
    // leaves the request pending forever, and CHECK AGENT is stuck on
    // "Checking agent…" with nothing to catch. 8s is generous next to /health
    // and /library, which never do real work — long enough that a genuinely
    // slow disk scan still succeeds, short enough that a hang reads as one.
    res = await fetch(`${base}${path}`, { ...init, headers, signal: AbortSignal.timeout(8000) });
  } catch {
    throw new AgentUnreachable(base);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `agent returned ${res.status}`);
  return body as T;
}

export function agentHealth(): Promise<AgentHealth> {
  return call<AgentHealth>("/health");
}

export function agentProbeLive(url: string): Promise<{ is_live: boolean }> {
  return call("/probe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

export function agentGrab(args: {
  url: string;
  quality: string;
  subs: boolean;
}): Promise<{ jobId: string }> {
  return call("/grab", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
}

export function agentCapture(args: {
  url: string;
  title: string;
  maxMinutes: number;
}): Promise<{ jobId: string }> {
  return call("/capture", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
}

/**
 * Stop a running capture. This is the SUCCESS path, not an abort: FFmpeg is
 * asked to close the file properly, and the recording is remuxed and uploaded
 * exactly as if a time cap had expired.
 */
export function agentStopJob(jobId: string): Promise<{ stopping: boolean }> {
  return call(`/jobs/${jobId}/stop`, { method: "POST" });
}

/** Render a clip from a master on the shared drive and file it there too. */
export function agentExport(args: {
  args: string[];
  localPath: string;
  title: string;
}): Promise<{ jobId: string }> {
  return call("/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
}

export interface AgentTag {
  label: string;
  kind: string;
}

/** Named entities + semantic keyphrases from the transcript. */
export function agentTag(args: { text: string; extra?: string[] }): Promise<{ jobId: string }> {
  return call("/tag", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
}

/** One written sentence per Key Moment section. */
export function agentSummarize(texts: string[]): Promise<{ jobId: string }> {
  return call("/summarize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts }),
  });
}

export function agentJob(jobId: string): Promise<AgentJob> {
  return call<AgentJob>(`/jobs/${jobId}`);
}

/**
 * Transcribe a path on the shared drive (or, for the rare non-drive source,
 * a URL). The agent reads a `path` straight off disk rather than fetching it
 * over HTTP from itself, so a multi-GB hearing costs one read instead of a
 * full copy into a temp file.
 *
 * `startSeconds` makes this incremental: pass the end of what was already
 * transcribed and the agent decodes and whispers only the audio after that
 * point, offsetting the returned timestamps back to absolute. This is what
 * lets a live capture's transcript grow every ~20s instead of re-whispering
 * the whole recording — including its still-unwritten tail — on every poll.
 */
export function agentTranscribe(
  source: { url: string; path?: string } | { url?: string; path: string },
  startSeconds = 0,
): Promise<{ segments: Array<{ start: number; end: number; text: string }>; language: string }> {
  return call("/transcribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...source, startSeconds }),
  });
}

/**
 * Poll an ANALYSIS job (tag, summarize) to completion and return its payload.
 *
 * Separate from waitForJob because those jobs return data rather than media,
 * so their result shape has nothing to do with the download/capture one.
 */
export async function waitForJobResult<T>(
  jobId: string,
  onTick?: (status: string, pct: number | null) => void,
  intervalMs = 1200,
): Promise<T> {
  for (;;) {
    const job = await agentJob(jobId);
    onTick?.(job.status, job.pct);
    if (job.status === "Complete") return job.result as unknown as T;
    if (job.status === "Error") throw new Error(job.error || "agent job failed");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Poll a job to completion, reporting every tick. Resolves on Complete, throws on Error. */
export async function waitForJob(
  jobId: string,
  onTick: (job: AgentJob) => void,
  intervalMs = 1000,
): Promise<AgentJob> {
  for (;;) {
    const job = await agentJob(jobId);
    onTick(job);
    if (job.status === "Complete") return job;
    if (job.status === "Error") throw new Error(job.error || "grab failed");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
