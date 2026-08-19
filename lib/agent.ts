export interface JobResult {
  status: 'pending' | 'completed' | 'failed';
  transcript?: string;
  error?: string;
  tags?: string[];
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
  return { jobId: data.jobId };
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

        if (data.status === 'completed') {
          return data;
        }

        if (data.status === 'failed') {
          throw new Error(data.error || 'Transcription job failed on worker server.');
        }
      } else if (response.status >= 500) {
        throw new Error(`Server agent error status: ${response.status}`);
      }
    } catch (err: any) {
      if (err.message.includes('failed on worker server')) {
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