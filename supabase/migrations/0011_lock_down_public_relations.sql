/* =========================================================================
   Basiq Studio Hub - lock down relations that skipped the SECURITY MODEL

   0001_initial_schema.sql's SECURITY MODEL note says every table gets RLS
   enabled with no policy, so anon/authenticated can read and write nothing,
   ever - only the service-role key (server-side only) can touch data. That
   note's own "revoke all on all tables in schema public" only ever applied
   to the tables that existed in the public schema at the moment it ran.
   Eight relations were added straight in the Supabase SQL editor afterward,
   without a migration ever being committed for them, and so were never
   swept into that lockdown - Supabase's own security advisor flagged this
   2026-08-31 as "Table publicly accessible" (rls_disabled_in_public).

   Confirmed against the live database via the REST API on 2026-09-01,
   comparing the anon key's access against the service-role key's on every
   relation PostgREST exposes:

       legislators           - a real table, full CRUD (get/post/patch/delete)
       terms                 - a real table, full CRUD
       uncategorized_videos  - a real table, full CRUD
       uncategorized_clips   - a real table, full CRUD
       videos_by_bucket      - a view, read-only (get only)
       videos_by_person      - a view, read-only
       clips_by_bucket       - a view, read-only
       clips_by_person       - a view, read-only

   All eight returned complete, unfiltered data to the anon key - the same
   credential a browser bundle is safe to ship publicly, so this counts as
   world-readable today and, for the four tables, world-writable too.

   The four tables get the exact same treatment as every other table in
   0001: enable RLS with no policy, plus the explicit revoke, so this reads
   the same way to anyone auditing the schema later. Views cannot have RLS
   enabled at all in Postgres - ALTER TABLE ... ENABLE ROW LEVEL SECURITY
   errors on one - so the revoke alone is the actual, complete fix for
   those four.

   Confirmed safe against the running app before writing this: nothing in
   this codebase ever constructs a Supabase client with the anon key (only
   lib/supabase-admin.ts, service-role, server-only) - grep for
   NEXT_PUBLIC_SUPABASE_ANON_KEY finds it declared and nowhere else read.
   service_role bypasses RLS and is untouched by every statement below, so
   nothing the app actually does changes.

   Paste into: Supabase Dashboard -> SQL Editor -> New query -> Run.
   Safe to re-run; every statement is idempotent.
   ========================================================================= */

alter table public.legislators           enable row level security;
alter table public.terms                 enable row level security;
alter table public.uncategorized_videos  enable row level security;
alter table public.uncategorized_clips   enable row level security;

revoke all on public.legislators           from anon, authenticated;
revoke all on public.terms                 from anon, authenticated;
revoke all on public.uncategorized_videos  from anon, authenticated;
revoke all on public.uncategorized_clips   from anon, authenticated;

revoke all on public.videos_by_bucket  from anon, authenticated;
revoke all on public.videos_by_person  from anon, authenticated;
revoke all on public.clips_by_bucket   from anon, authenticated;
revoke all on public.clips_by_person   from anon, authenticated;
