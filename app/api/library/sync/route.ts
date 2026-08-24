import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const count = Array.isArray(body?.files) ? body.files.length : 0;
    
    // Ingestion writes directly to Supabase at job time.
    // This handler serves as a safe no-op for the UI RESCAN button.
    return NextResponse.json({ success: true, synced: count });
  } catch {
    return NextResponse.json({ success: true, synced: 0 });
  }
}