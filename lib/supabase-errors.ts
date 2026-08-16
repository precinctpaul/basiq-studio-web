/**
 * Recognising "that table doesn't exist yet".
 *
 * Two different shapes reach us for the same condition, which is why this is
 * a shared helper rather than an inline code check:
 *
 *   - Postgres itself raises `42P01` (undefined_table).
 *   - PostgREST usually answers first, from its schema cache, with `PGRST205`
 *     and the message "Could not find the table 'public.x' in the schema
 *     cache" — and never surfaces the Postgres code at all.
 *
 * Checking only for 42P01 silently misses the common case, which is exactly
 * how an unrun migration turned into a 500 on the library route.
 */
export function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  const message = (error.message ?? "").toLowerCase();
  return message.includes("could not find the table") || message.includes("does not exist");
}
