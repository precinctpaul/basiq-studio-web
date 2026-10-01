import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Admin console auth. The app has no user logins at all (see
 * lib/supabase-admin.ts), so the admin console is gated by a single
 * password (ADMIN_PASSWORD) that, once entered, sets a signed httpOnly
 * session cookie. The agent's own admin key (AGENT_ADMIN_TOKEN, the same
 * value as ADMIN_TOKEN in the droplet's /etc/basiq-agent.env) never reaches
 * the browser -- only app/api/admin/agent/[...path] uses it, server-side.
 */
export const ADMIN_COOKIE = "basiq_admin";
const SESSION_DAYS = 14;

function secret(): string {
  return process.env.ADMIN_SESSION_SECRET || process.env.AGENT_ADMIN_TOKEN || "";
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function adminConfigured(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD && secret() && process.env.AGENT_ADMIN_TOKEN);
}

export function passwordMatches(candidate: string): boolean {
  const real = process.env.ADMIN_PASSWORD || "";
  return Boolean(real) && safeEqual(candidate, real);
}

export function newSessionValue(): { value: string; maxAge: number } {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const payload = `admin.${exp}`;
  return { value: `${payload}.${sign(payload)}`, maxAge: SESSION_DAYS * 86400 };
}

export function sessionValid(value: string | undefined): boolean {
  if (!value || !secret()) return false;
  const i = value.lastIndexOf(".");
  if (i < 0) return false;
  const payload = value.slice(0, i);
  const exp = Number(payload.split(".")[1]);
  return safeEqual(value.slice(i + 1), sign(payload)) && Number.isFinite(exp) && exp > Date.now() / 1000;
}
