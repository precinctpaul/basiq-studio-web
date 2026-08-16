"use client";

/**
 * agent.ts — client for the local companion agent (tools/basiq_agent.py).
 *
 * The browser talks to the agent DIRECTLY, never through a Vercel function:
 * the agent lives on the operator's machine and a serverless function has no
 * route to it. That is also why the media bytes never pass through here — the
 * agent PUTs the finished file straight to storage using a signed URL this
 * app mints for it.
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
export function agentMediaUrl(localPath: string): string {
  return `${getAgentUrl()}/media/${localPath.split("/").map(encodeURIComponent).join("/")}`;
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
  result: {
    title: string;
    sizeBytes: number;
    ext: string;
    uploader: string;
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
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, init);
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
  signedUrl: string;
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
  signedUrl: string;
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

/** Render a clip from a master on the shared drive and upload the result. */
export function agentExport(args: {
  args: string[];
  localPath: string;
  signedUrl: string;
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
 * Transcribe either a signed URL (a master in Supabase storage) or a path on
 * the shared drive. The agent reads a `path` straight off disk rather than
 * fetching it over HTTP from itself, so a multi-GB hearing costs one read
 * instead of a full copy into a temp file.
 */
export function agentTranscribe(
  source: { url: string; path?: string } | { url?: string; path: string },
): Promise<{ segments: Array<{ start: number; end: number; text: string }>; language: string }> {
  return call("/transcribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(source),
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
