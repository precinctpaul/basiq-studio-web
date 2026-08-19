import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get('jobId');

    if (!jobId) {
      return NextResponse.json({ error: 'Missing required jobId parameter' }, { status: 400 });
    }

    const whisperUrl = process.env.WHISPER_URL || 'https://basiq.51st.media/agent';
    const response = await fetch(`${whisperUrl}/status/${jobId}`);

    if (!response.ok) {
      return NextResponse.json(
        { error: 'Upstream agent status query failed' },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data, { status: 200 });
  } catch (error: any) {
    return NextResponse.json(
      { error: 'Internal proxy server error during status poll', message: error.message },
      { status: 500 }
    );
  }
}