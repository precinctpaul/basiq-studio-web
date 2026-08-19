export class AgentUnreachable extends Error {
  constructor(message: string = "Agent unreachable") {
    super(message);
    this.name = "AgentUnreachable";
  }
}

export interface JobResult {
  status: 'pending' | 'completed' | 'failed' | 'done' | string;
  transcript?: string;
  segments?: any[];
  language?: string;
  error?: string;
  tags?: string[];
  job_id?: string;
  jobId?: string;
  [key: string]: any;
}

export function getAgentUrl(): string {
  if (typeof window !== "undefined") {
    return process.env.NEXT_PUBLIC_WHISPER_URL || "https://basiq.51st.media/agent";
  }
  return process.env.WHISPER_URL || "https://basiq.51st.media/agent";
}

export function agentMediaUrl(path: string, overrideAgentUrl?: string): string {
  if (!path) return "";
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  const baseUrl = overrideAgentUrl || getAgentUrl();
  return `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
}

export async function startTranscription(
  data: FormData | Record<string, any>
): Promise<any> {
  let options: RequestInit = {};

  if (data instanceof FormData) {
    options = {
      method: 'POST',
      body: data,
    };
  } else {
    options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  }

  const response = await fetch('/api/transcribe', options);

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Failed to initiate transcription (${response.status})`);
  }

  return await response.json();
}

export async function agentTranscribe(data: FormData | Record<string, any>): Promise<any> {
  return startTranscription(data);
}

export async function waitForJobResult<T = any>(
  jobId: string,
  onProgress?: ((status: any, pct?: any) => void) | number,
  intervalMs: number = 1500,
  maxAttempts: number = 200
): Promise<T> {
  let attempts = 0;
  const pollInterval = typeof onProgress === 'number' ? onProgress : intervalMs;

  while (attempts < maxAttempts) {
    attempts++;

    try {
      const response = await fetch(`/api/transcribe/status?jobId=${encodeURIComponent(jobId)}`);

      if (response.ok) {
        const data = await response.json();

        if (typeof onProgress === 'function') {
          onProgress(data.status || 'processing', data.progress || data.pct || 0);
        }

        if (data.status === 'completed' || data.status === 'done' || data.status === 'finished') {
          return data as T;
        }

        if (data.status === 'failed' || data.status === 'error') {
          throw new Error(data.error || 'Transcription job failed on worker server.');
        }
      } else if (response.status >= 500) {
        throw new Error(`Server agent error status: ${response.status}`);
      }
    } catch (err: any) {
      if (err.message?.includes('failed on worker server')) {
        throw err;
      }
      if (attempts >= maxAttempts) {
        throw new Error(`Transcription timed out after ${Math.round((maxAttempts * pollInterval) / 1000)} seconds.`);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(`Transcription timed out: reached maximum limit of ${maxAttempts} polling attempts.`);
}

export async function waitForJob<T = any>(
  jobId: string,
  onProgress?: ((status: any, pct?: any) => void) | number,
  intervalMs: number = 1500,
  maxAttempts: number = 200
): Promise<T> {
  return waitForJobResult<T>(jobId, onProgress, intervalMs, maxAttempts);
}

async function fetchAgent(endpoint: string, options: RequestInit = {}): Promise<any> {
  const baseUrl = getAgentUrl();
  const url = `${baseUrl}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
  try {
    const res = await fetch(url, options);
    if (!res.ok) {
      throw new Error(`Agent request failed (${res.status})`);
    }
    return await res.json();
  } catch (err: any) {
    throw new AgentUnreachable(err.message);
  }
}

export async function agentHealth(): Promise<any> {
  return fetchAgent("/health");
}

export async function agentJob(jobId: string): Promise<any> {
  return fetchAgent(`/status/${jobId}`);
}

export async function agentStopJob(jobId: string): Promise<any> {
  return fetchAgent(`/jobs/${jobId}/stop`, { method: "POST" });
}

export async function agentGrab(data: any): Promise<any> {
  return fetchAgent("/grab", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function agentCapture(data: any): Promise<any> {
  return fetchAgent("/capture", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function agentExport(data: any): Promise<any> {
  return fetchAgent("/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function agentLibrary(): Promise<any> {
  return fetchAgent("/library");
}

export async function agentTag(data: any): Promise<any> {
  return fetchAgent("/tag", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function agentProbeLive(data: any): Promise<any> {
  return fetchAgent("/probe_live", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function agentSummarize(data: any): Promise<any> {
  return fetchAgent("/summarize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}