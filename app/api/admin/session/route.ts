import { NextRequest, NextResponse } from "next/server";
import {
  ADMIN_COOKIE,
  adminConfigured,
  newSessionValue,
  passwordMatches,
  sessionValid,
} from "@/lib/admin-auth";

export const runtime = "nodejs";

/** GET: is this browser signed in to the admin console? */
export async function GET(req: NextRequest) {
  return NextResponse.json({
    configured: adminConfigured(),
    signedIn: sessionValid(req.cookies.get(ADMIN_COOKIE)?.value),
  });
}

/** POST {password}: sign in. */
export async function POST(req: NextRequest) {
  if (!adminConfigured()) {
    return NextResponse.json(
      { error: "Admin console isn't set up on this server (ADMIN_PASSWORD / AGENT_ADMIN_TOKEN missing)." },
      { status: 503 },
    );
  }
  const { password } = (await req.json().catch(() => ({}))) as { password?: string };
  if (!passwordMatches(String(password || ""))) {
    // A little friction against guessing; this is the only door.
    await new Promise((r) => setTimeout(r, 800));
    return NextResponse.json({ error: "Wrong password." }, { status: 401 });
  }
  const { value, maxAge } = newSessionValue();
  const res = NextResponse.json({ signedIn: true });
  res.cookies.set(ADMIN_COOKIE, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge,
  });
  return res;
}

/** DELETE: sign out. */
export async function DELETE() {
  const res = NextResponse.json({ signedIn: false });
  res.cookies.set(ADMIN_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
