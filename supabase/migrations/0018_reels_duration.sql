/* =========================================================================
   Basiq Studio Hub - reels.duration_seconds

   Parity with clips.duration_seconds (0001_initial_schema.sql) -- the
   share page (app/share/[token]/page.tsx) displays a clip's duration
   straight from that column, and a rendered reel deserves the same
   display rather than a permanent blank. Computed client-side (sum of
   each segment's out_point - in_point, no per-segment fades to account
   for -- REELS_DESIGN.md: hard cuts only) and passed to
   /api/reels/[id]/complete alongside localPath/sizeBytes once the agent
   finishes rendering, same moment clips.duration_seconds would already be
   known some other way for a clip.

   Paste into: Supabase Dashboard -> SQL Editor -> New query -> Run.
   Safe to re-run; every statement is idempotent.
   ========================================================================= */

alter table public.reels
    add column if not exists duration_seconds double precision not null default 0;
