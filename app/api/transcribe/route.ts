import { NextRequest, NextResponse } from 'next/server';
import { createWriteStream } from 'fs';
import { Readable } from 'stream';
import path from 'path';
import crypto from 'crypto';
import { writeFile } from 'fs/promises';

export async function POST(request: NextRequest) {
  try {
    const whisperUrl = process.env.WHISPER_URL || 'http://127.0.0.1:8000';
    const contentType = request.headers.get('content-type') || '';

    // 1. Handle memory-safe raw binary stream uploads
    if (contentType.includes('application/octet-stream')) {
      const originalName = request.nextUrl.searchParams.get('filename') || 'upload.mp4';
      const ext = path.extname(originalName) || '.mp4';
      
      // Generate clean ID for the physical file
      const fileId = crypto.randomUUID().replace(/-/g, '');
      const fileName = `${fileId}${ext}`;
      
      const mediaRoot = process.env.MEDIA_ROOT || '/mnt/lucidlink/Archive/Basiq-Studio-Hub';
      const filePath = path.join(mediaRoot, fileName);
      const metaPath = path.join(mediaRoot, `${fileId}.meta.json`);

      if (!request.body) {
        return NextResponse.json({ error: 'No request body' }, { status: 400 });
      }

      // Stream directly to disk using explicit pipe to prevent Next.js hang
      const nodeStream = Readable.fromWeb(request.body as any);
      const writeStream = createWriteStream(filePath);

      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', () => resolve());
        writeStream.on('error', reject);
        nodeStream.on('error', reject);
        nodeStream.pipe(writeStream);
      });

      // Write metadata sidecar so the UI shows the friendly display name
      await writeFile(metaPath, JSON.stringify({ title: originalName }, null, 2));

      return NextResponse.json({ success: true, path: fileName, jobId: fileId }, { status: 200 });
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