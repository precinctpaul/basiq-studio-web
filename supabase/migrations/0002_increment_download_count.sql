/* =========================================================================
   Basiq Studio Hub - atomic download counter

   The download route needs to bump share_tokens.download_count and stamp
   last_access_at on every /api/share/{token}/download hit. A read-then-write
   from application code (SELECT count, add one, UPDATE) loses increments
   under concurrent downloads of the same link - two requests reading the
   same starting value both write count+1, and one increment vanishes. An
   atomic UPDATE ... SET count = count + 1 has no such window.

   SECURITY DEFINER is required, not incidental: callers reach this through
   the service-role key (see SECURITY MODEL in 0001), and this function does
   nothing a service-role UPDATE couldn't already do directly - it exists
   purely to make that UPDATE atomic and reusable, not to grant new privilege.
   ========================================================================= */
create or replace function public.increment_download_count(p_token text)
returns void
language sql
security definer
set search_path = public
as $fn$
    update public.share_tokens
    set download_count = download_count + 1,
        last_access_at = now()
    where token = p_token;
$fn$;

revoke all on function public.increment_download_count(text) from public, anon, authenticated;
