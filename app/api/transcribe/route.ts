import { NextRequest, NextResponse } from 'next/server';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import path from 'path';

export async function POST(request: NextRequest) {
  try {
    const whisperUrl = process.env.WHISPER_URL || 'http://127.0.0.1:8000';
    const contentType = request.headers.get('content-type') || '';

    // 1. Handle memory-safe raw binary stream uploads
    if (contentType.includes('application/octet-stream')) {
      const fileName = request.nextUrl.searchParams.get('filename') || 'upload.mp4';
      const mediaRoot = process.env.MEDIA_ROOT || '/mnt/lucidlink/Archive/Basiq-Studio-Hub';
      const filePath = path.join(mediaRoot, fileName);

      if (!request.body) {
        return NextResponse.json({ error: 'No request body' }, { status: 400 });
      }

      // Stream directly to disk (Uses ~10MB RAM instead of caching the whole video)
      const nodeStream = Readable.fromWeb(request.body as any);
      const writeStream = createWriteStream(filePath);
      await pipeline(nodeStream, writeStream);

      return NextResponse.json({ success: true, path: fileName }, { status: 200 });
    }

    // 2. Handle standard JSON requests (forwarding to basiq_agent.py /transcribe)
    const bodyText = await request.text();
    const response = await fetch(`${whisperUrl}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyText,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { error: 'Failed to dispatch transcription job', details: errorText },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data, { status: 202 });

  } catch (error: any) {
    return NextResponse.json(
      { error: 'Internal proxy server error during transcription dispatch', message: error.message },
      { status: 500 }
    );
  }
}