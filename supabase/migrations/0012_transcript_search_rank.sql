/* =========================================================================
   Basiq Studio Hub - real relevance ranking for transcript search

   The library's search box already finds every video whose transcript
   contains a search term (public.transcripts.search_tsv, GIN-indexed,
   'english' config, set up in 0001_initial_schema.sql) but only as a
   yes/no match via .textSearch() -- it never asks Postgres HOW WELL a
   video matches, so a video that says the term once and a video that's
   actually about it come back in the same undifferentiated pile. This
   exposes Postgres's own full-text rank (ts_rank) through a function
   PostgREST can call via .rpc(), so the app can offer a real "Relevance"
   sort instead of a made-up heuristic.

   Kept as a SQL function (not inlined into a bare .select()) because
   ts_rank needs the same tsquery used for the match test passed in twice,
   which PostgREST's query-string filters can't express -- a function is
   the standard way to run a parameterized query like this through
   PostgREST.

   Same 200-id cap reasoning as app/api/library/route.ts's existing
   transcriptVideoIds cap: a common word can match thousands of
   transcripts, and folding that many ids into a follow-up .in.(...)
   filter can build a URL long enough for PostgREST to reject outright
   (confirmed 2026-09-09). This returns the same shape ranked instead of
   unranked, so the app can drop its own cap down to this function's
   output rather than keeping two separate limits.

   Deny-all like every other object here (see 0004_tags.sql, 0011's
   SECURITY MODEL note) -- the app only ever calls this via the
   service-role key (lib/supabase-admin.ts), which bypasses grants
   entirely, so revoking PUBLIC's default EXECUTE grant changes nothing
   the app actually does.

   Paste into: Supabase Dashboard -> SQL Editor -> New query -> Run.
   Safe to re-run; CREATE OR REPLACE and REVOKE are both idempotent.
   ========================================================================= */

create or replace function public.search_transcripts_ranked(search_query text)
returns table (video_id uuid, rank real)
language sql
stable
as $$
  select
    t.video_id,
    ts_rank(t.search_tsv, websearch_to_tsquery('english', search_query)) as rank
  from public.transcripts t
  where t.search_tsv @@ websearch_to_tsquery('english', search_query)
  order by rank desc
  limit 200;
$$;

revoke all on function public.search_transcripts_ranked(text) from public, anon, authenticated;
