import { NextRequest, NextResponse } from 'next/server';
import { writeFile } from 'fs/promises';
import path from 'path';

export async function POST(request: NextRequest) {
  try {
    const whisperUrl = process.env.WHISPER_URL || 'http://127.0.0.1:8000';
    const contentType = request.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const file = formData.get('file') as File | null;

      if (!file) {
        return NextResponse.json({ error: 'No file provided in form data' }, { status: 400 });
      }

      const fileName = file.name;
      const mediaRoot = process.env.MEDIA_ROOT || '/mnt/lucidlink/Archive/Basiq-Studio-Hub';
      const filePath = path.join(mediaRoot, fileName);

      // Write uploaded binary video/audio directly into LucidLink MEDIA_ROOT
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      await writeFile(filePath, buffer);

      // Dispatch clean JSON payload to basiq_agent.py
      const response = await fetch(`${whisperUrl}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, title: fileName }),
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
    } else {
      // Handles standard JSON requests
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
    }
  } catch (error: any) {
    return NextResponse.json(
      { error: 'Internal proxy server error during transcription dispatch', message: error.message },
      { status: 500 }
    );
  }
}