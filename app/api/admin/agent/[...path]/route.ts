import { NextRequest, NextResponse } from "next/server";
import { ADMIN_COOKIE, sessionValid } from "@/lib/admin-auth";

export const runtime = "nodejs";

/**
 * The admin console's only way to the agent's /admin/* API (worker mesh:
 * tools/mesh.py). Checks the admin session cookie, then forwards with the
 * agent's admin key, which stays on this server. The web app runs on the
 * same droplet as the agent, so this goes straight to 127.0.0.1.
 */
const AGENT = process.env.AGENT_INTERNAL_URL || "http://127.0.0.1:8000";

async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }, method: "GET" | "POST") {
  if (!sessionValid(req.cookies.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const { path } = await ctx.params;
  if (!path.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) {
    return NextResponse.json({ error: "Bad path." }, { status: 400 });
  }
  try {
    const res = await fetch(`${AGENT}/admin/${path.join("/")}`, {
      method,
      headers: {
        Authorization: `Bearer ${process.env.AGENT_ADMIN_TOKEN || ""}`,
        "Content-Type": "application/json",
      },
      body: method === "POST" ? await req.text() : undefined,
      cache: "no-store",
    });
    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { error: `Agent unreachable: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, ctx, "GET");
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, ctx, "POST");
}
