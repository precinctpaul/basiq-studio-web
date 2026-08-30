const STORAGE_KEY = "basiq.agentUrl";

import { fetchWithRetry } from "./fetchWithRetry";

export function defaultAgentUrl(): string {
  return process.env.NEXT_PUBLIC_WHISPER_URL || "https://basiq.51st.media/agent";
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
  probed?: boolean;
}

export interface AgentHealth {
  status: string;
  model: string;
  whisper: boolean;
  ytdlp: boolean;
  summarizer: boolean;
  tagger: boolean;
}

export interface AgentJob {
  status: string;
  pct: number | null;
  detail: string;
  error: string;
  seconds?: number;
  bytes_written?: number;
  local_path?: string;
  result: {
    title: string;
    sizeBytes: number;
    ext: string;
    uploader: string;
    channel: string;
    uploadDate: string;
    sourceUrl: string;
    durationSeconds?: number;
    isLive?: boolean;
    localPath?: string;
  } | null;
}

export interface AgentTag {
  label: string;
  kind: string;
}

export interface AgentTagResult {
  tags: AgentTag[];
}

export interface AgentSummaryResult {
  summaries: Array<string | null>;
}

export interface JobResult {
  status: 'pending' | 'completed' | 'failed' | 'done' | string;
  transcript?: string;
  segments?: Array<{ start: number; end: number; text: string }>;
  language?: string;
  error?: string;
  tags?: AgentTag[];
  job_id?: string;
  jobId?: string;
  [key: string]: any;
}

export class AgentUnreachable extends Error {
  constructor(url: string) {
    super(`Can't reach the local agent at ${url}. Start it with: python tools/basiq_agent.py`);
    this.name = "AgentUnreachable";
  }
}

// Canonical decision (2026-08-30): MEDIA_ROOT is the hub folder itself
// (C:\Volumes\md-pac\media\Archive\Basiq-Studio-Hub, or the equivalent
// mount path on a given machine) everywhere -- the agent, the worker, and
// production's /etc/basiq-agent.env all need to agree on this. Older rows
// written before that decision (from bulk_ingest.py / cspan_video_ingest.py)
// still carry this folder name baked directly into local_path, back when
// MEDIA_ROOT pointed one level higher at the wider shared drive -- this
// constant exists only to detect and strip that now-redundant prefix, not
// to add it. A bare filename (the live GRAB pipeline's convention, and the
// only one that makes sense once MEDIA_ROOT is the hub itself) passes
// through unchanged.
const LIBRARY_MEDIA_SUBDIR = "Archive/Basiq-Studio-Hub";

/**
 * Turns a videos/clips.local_path -- bare (current convention) or still
 * carrying the old baked-in "Archive/Basiq-Studio-Hub/" prefix (rows written
 * before MEDIA_ROOT became the hub folder itself) -- into the path the
 * agent's MEDIA_ROOT actually needs today: the prefix stripped, since
 * MEDIA_ROOT already points there. Used for both playback (agentMediaUrl
 * below) AND for any request that hands a path straight to the agent itself
 * (e.g. /transcribe's `path` field) -- the agent's own run_transcribe()
 * resolves `path` against MEDIA_ROOT the same way the media server does, so
 * both need the same normalization.
 */
export function libraryMediaPath(localPath: string): string {
  if (!localPath) return "";
  return localPath.startsWith(`${LIBRARY_MEDIA_SUBDIR}/`)
    ? localPath.slice(LIBRARY_MEDIA_SUBDIR.length + 1)
    : localPath;
}

export function agentMediaUrl(localPath: string, opts?: { download?: boolean } | string): string {
  if (!localPath) return "";
  if (localPath.startsWith("http://") || localPath.startsWith("https://")) return localPath;

  const downloadOption = typeof opts === "object" ? opts?.download : false;
  const customBase = typeof opts === "string" ? opts : getAgentUrl();

  const fullPath = libraryMediaPath(localPath);
  const path = fullPath.split("/").map(encodeURIComponent).join("/");
  const params = new URLSearchParams();
  if (downloadOption) params.set("download", "1");
  const token = process.env.NEXT_PUBLIC_WHISPER_AUTH_TOKEN;
  if (token) params.set("token", token);
  const qs = params.toString();
  return `${customBase}/media/${path}${qs ? `?${qs}` : ""}`;
}

async function call<T>(path: string, init?: RequestInit, timeoutMs: number = 8000): Promise<T> {
  const base = getAgentUrl();
  const token = process.env.NEXT_PUBLIC_WHISPER_AUTH_TOKEN;
  const headers = new Headers(init?.headers ?? {});
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  let res: Response;
  try {
    res = await fetchWithRetry(`${base}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) }, 3, 500);
  } catch (err: any) {
    if (err.message === "Shared drive not mounted") {
      throw err;
    }
    throw new AgentUnreachable(base);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `agent returned ${res.status}`);
  return body as T;
}

/**
 * DB-FIRST LIBRARY LISTING: Backward compatible wrapper providing both 'rows'
 * and legacy 'files', 'root', 'exists' properties.
 */
export async function agentLibrary(
  pageOrForce?: boolean | number,
  limit = 50,
  search = ""
): Promise<{
  root: string;
  exists: boolean;
  files: any[];
  rows: any[];
  pagination: { page: number; pageSize: number; totalCombined: number; hasMore: boolean };
}> {
  const page = typeof pageOrForce === "number" ? pageOrForce : 0;
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  });
  if (search) params.set("search", search);

  const res = await fetch(`/api/library?${params.toString()}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to fetch library (${res.status})`);
  }
  const data = await res.json();
  const mapped = (data.rows || []).map((r: any) => ({
    ...r,
    path: r.local_path || r.id,
    name: r.title || "Untitled",
    duration: r.duration_seconds || 0,
    sizeBytes: r.size_bytes || 0,
  }));

  return {
    root: "",
    exists: true,
    files: mapped,
    rows: mapped,
    pagination: data.pagination || {
      page,
      pageSize: limit,
      totalCombined: mapped.length,
      hasMore: false,
    },
  };
}

/**
 * LAZY VERIFICATION: Verifies physical file accessibility on the shared drive
 * ONLY when selected for playback/export.
 */
export async function agentVerifyMedia(localPath: string): Promise<boolean> {
  if (!localPath) return false;
  const url = agentMediaUrl(localPath);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(3000),
    });
    return res.ok || res.status === 206;
  } catch {
    return false;
  }
}

export function agentHealth(): Promise<AgentHealth> {
  return call<AgentHealth>("/health");
}

export async function agentProbeLive(
  url: string | { url: string }
): Promise<{ is_live: boolean; isLive: boolean; title?: string; [key: string]: any }> {
  const targetUrl = typeof url === "string" ? url : url.url;
  const urlLooksLive = Boolean(targetUrl && targetUrl.toLowerCase().includes("/live"));
  try {
    const res = await call<any>("/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: targetUrl }),
    });
    const isLive = Boolean(res?.is_live ?? res?.isLive) || urlLooksLive;
    return {
      ...res,
      is_live: isLive,
      isLive: isLive,
      title: res?.title || "",
    };
  } catch {
    return {
      is_live: urlLooksLive,
      isLive: urlLooksLive,
      title: "",
    };
  }
}

export function agentGrab(args: { url: string; quality: string; subs: boolean }): Promise<{ jobId: string }> {
  return call("/grab", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
}

export function agentCapture(args: { url: string; title: string; maxMinutes: number }): Promise<{ jobId: string }> {
  return call("/capture", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
}

export function agentStopJob(jobId: string): Promise<{ stopping: boolean }> {
  return call(`/jobs/${jobId}/stop`, { method: "POST" });
}

export function agentExport(args: { args: string[]; localPath: string; title: string }): Promise<{ jobId: string }> {
  return call("/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
}

export function agentTag(args: { text: string; extra?: string[] }): Promise<{ jobId: string }> {
  return call("/tag", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
}

export function agentSummarize(texts: string[] | { texts: string[] }): Promise<{ jobId: string }> {
  const payload = Array.isArray(texts) ? { texts } : texts;
  return call("/summarize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function agentJob(jobId: string): Promise<AgentJob> {
  return call<AgentJob>(`/jobs/${jobId}`);
}

export async function startTranscription(
  data: FormData | Record<string, any>
): Promise<{ jobId: string }> {
  if (typeof window !== "undefined") {
    let options: RequestInit = {};
    if (data instanceof FormData) {
      options = { method: "POST", body: data };
    } else {
      options = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      };
    }
    const res = await fetch("/api/transcribe", options);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Transcription dispatch failed (${res.status})`);
    }
    const resData = await res.json();
    return { jobId: resData.jobId || resData.job_id };
  } else {
    const payload = data instanceof FormData ? data : JSON.stringify(data);
    const headers: Record<string, string> = {};
    if (!(data instanceof FormData)) {
      headers["Content-Type"] = "application/json";
    }
    return call<{ jobId: string }>("/transcribe", {
      method: "POST",
      headers,
      body: payload as any,
    });
  }
}

export async function agentTranscribe(
  source: { url?: string; path?: string } | FormData | any,
  startSeconds = 0,
  onTick?: (status: string, pct: number | null) => void
): Promise<{ segments: Array<{ start: number; end: number; text: string }>; language: string }> {
  let bodyData: any;
  if (source instanceof FormData) {
    bodyData = source;
  } else {
    bodyData = { ...source, startSeconds };
  }

  const { jobId } = await startTranscription(bodyData);

  return waitForJobResult<{ segments: Array<{ start: number; end: number; text: string }>; language: string }>(
    jobId,
    onTick,
    1500,
    400
  );
}

export async function waitForJobResult<T = any>(
  jobId: string,
  onTick?: ((status: string, pct: number | null) => void) | number,
  intervalMs = 1200,
  maxAttempts = 400
): Promise<T> {
  const pollInterval = typeof onTick === "number" ? onTick : intervalMs;
  const callback = typeof onTick === "function" ? onTick : undefined;

  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts++;
    try {
      const job = await agentJob(jobId);
      callback?.(job.status, job.pct);
      if (job.status === "Complete" || job.status === "completed" || job.status === "done") {
        return (job.result || job) as unknown as T;
      }
      if (job.status === "Error" || job.status === "failed") {
        throw new Error(job.error || "agent job failed");
      }
    } catch (err: any) {
      if (err.message?.includes("agent job failed")) throw err;
      if (attempts >= maxAttempts) throw new Error("Job polling timed out.");
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }
  throw new Error(`Job polling timed out after ${maxAttempts} attempts.`);
}

export async function waitForJob(
  jobId: string,
  onTick?: (job: AgentJob) => void,
  intervalMs = 1000,
  maxAttempts = 400
): Promise<AgentJob> {
  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts++;
    const job = await agentJob(jobId);
    onTick?.(job);
    if (job.status === "Complete" || job.status === "completed" || job.status === "done") return job;
    if (job.status === "Error" || job.status === "failed") throw new Error(job.error || "grab failed");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Job polling timed out after ${maxAttempts} attempts.`);
}