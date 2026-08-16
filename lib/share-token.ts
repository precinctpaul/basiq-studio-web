import { randomBytes } from "node:crypto";

/**
 * Matches supabase/migrations/0001_initial_schema.sql's own comment: tokens
 * are generated here, not in Postgres — encode() has no base64url, and
 * hand-rolling one via translate() is how '+' and '/' quietly end up in a
 * URL path. 24 bytes -> 32 base64url characters, comfortably past the
 * share_token_len >= 22 check in that migration.
 */
export function generateShareToken(): string {
  return randomBytes(24).toString("base64url");
}
