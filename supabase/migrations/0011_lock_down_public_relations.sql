/* =========================================================================
   Basiq Studio Hub - lock down relations that skipped the SECURITY MODEL

   0001_initial_schema.sql's SECURITY MODEL note says every table gets RLS
   enabled with no policy, so anon/authenticated can read and write nothing,
   ever - only the service-role key (server-side only) can touch data. That
   note's own "revoke all on all tables in schema public" only ever applied
   to the relations that existed in the public schema at the moment it ran.
   Eight relations were added straight in the Supabase SQL editor afterward,
   without a migration ever being committed for them, and so were never
   swept into that lockdown - Supabase's own security advisor flagged this
   2026-08-31 as "Table publicly accessible" (rls_disabled_in_public).

   Confirmed against the live database via the REST API on 2026-09-01,
   comparing the anon key's access against the service-role key's on every
   relation PostgREST exposes: legislators, terms, uncategorized_videos,
   and uncategorized_clips returned full CRUD (get/post/patch/delete) to
   the anon key; videos_by_bucket, videos_by_person, clips_by_bucket, and
   clips_by_person returned full read access (get only). All eight
   returned complete, unfiltered data to the same credential a browser
   bundle is safe to ship publicly - world-readable today, and for
   whichever of the first four are real tables, world-writable too.

   PostgREST offering write verbs does not reliably mean "real table",
   though - running this the first time hit
   "ALTER action ENABLE ROW SECURITY cannot be performed on relation
   uncategorized_videos ... not supported for views", because a simple
   auto-updatable view gets the same verbs PostgREST would give a table.
   Rather than guess which of the four are genuine tables from outside the
   database, this uses REVOKE alone throughout: it takes the exact same
   syntax on a table or a view, and removing anon/authenticated's grant
   entirely closes the hole completely on its own - RLS only matters for a
   role that still holds some grant and needs row-filtering on top of it,
   which is not the goal here. Whichever of the four turn out to be real
   tables can still get RLS enabled later as pure defense-in-depth, to
   read the same way as every other table in this schema; it isn't needed
   for this to already be fully closed.

   Confirmed safe against the running app before writing this: nothing in
   this codebase ever constructs a Supabase client with the anon key (only
   lib/supabase-admin.ts, service-role, server-only) - grep for
   NEXT_PUBLIC_SUPABASE_ANON_KEY finds it declared and nowhere else read.
   service_role bypasses RLS and every grant below, so nothing the app
   actually does changes.

   Paste into: Supabase Dashboard -> SQL Editor -> New query -> Run.
   Safe to re-run; every statement is idempotent.
   ========================================================================= */

revoke all on public.legislators           from anon, authenticated;
revoke all on public.terms                 from anon, authenticated;
revoke all on public.uncategorized_videos  from anon, authenticated;
revoke all on public.uncategorized_clips   from anon, authenticated;

revoke all on public.videos_by_bucket  from anon, authenticated;
revoke all on public.videos_by_person  from anon, authenticated;
revoke all on public.clips_by_bucket   from anon, authenticated;
revoke all on public.clips_by_person   from anon, authenticated;
