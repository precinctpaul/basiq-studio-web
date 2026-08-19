import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const whisperUrl = process.env.WHISPER_URL || 'https://basiq.51st.media/agent';
    const formData = await request.formData();

    const response = await fetch(`${whisperUrl}/transcribe`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { error: 'Failed to dispatch job to transcription backend', details: errorText },
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