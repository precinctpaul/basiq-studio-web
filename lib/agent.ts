export class AgentUnreachable extends Error {
  constructor(message: string = "Agent unreachable") {
    super(message);
    this.name = "AgentUnreachable";
  }
}

export interface JobResult {
  status: 'pending' | 'completed' | 'failed' | 'done' | string;
  transcript?: string;
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

export function agentMediaUrl(path: string): string {
  if (!path) return "";
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  const baseUrl = getAgentUrl();
  return `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
}

export async function startTranscription(formData: FormData): Promise<{ jobId: string }> {
  const response = await fetch('/api/transcribe', {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Failed to initiate transcription (${response.status})`);
  }

  const data = await response.json();
  return { jobId: data.jobId || data.job_id };
}

export async function agentTranscribe(formData: FormData) {
  return startTranscription(formData);
}

export async function waitForJobResult(
  jobId: string,
  intervalMs: number = 1500,
  maxAttempts: number = 200
): Promise<JobResult> {
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts++;

    try {
      const response = await fetch(`/api/transcribe/status?jobId=${encodeURIComponent(jobId)}`);

      if (response.ok) {
        const data: JobResult = await response.json();

        if (data.status === 'completed' || data.status === 'done' || data.status === 'finished') {
          return data;
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
        throw new Error(`Transcription timed out after ${Math.round((maxAttempts * intervalMs) / 1000)} seconds.`);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Transcription timed out: reached maximum limit of ${maxAttempts} polling attempts.`);
}

export async function waitForJob(jobId: string, intervalMs?: number, maxAttempts?: number) {
  return waitForJobResult(jobId, intervalMs, maxAttempts);
}

async function fetchAgent(endpoint: string, options: RequestInit = {}) {
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

export async function agentHealth() {
  return fetchAgent("/health");
}

export async function agentJob(jobId: string) {
  return fetchAgent(`/status/${jobId}`);
}

export async function agentStopJob(jobId: string) {
  return fetchAgent(`/jobs/${jobId}/stop`, { method: "POST" });
}

export async function agentGrab(data: any) {
  return fetchAgent("/grab", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function agentCapture(data: any) {
  return fetchAgent("/capture", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function agentExport(data: any) {
  return fetchAgent("/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function agentLibrary() {
  return fetchAgent("/library");
}

export async function agentTag(data: any) {
  return fetchAgent("/tag", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function agentProbeLive(data: any) {
  return fetchAgent("/probe_live", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function agentSummarize(data: any) {
  return fetchAgent("/summarize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}