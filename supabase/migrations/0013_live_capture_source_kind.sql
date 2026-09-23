/* =========================================================================
   'live' joins 'upload', 'url', 'local' as a provenance.

   Every droplet-processed video -- both a plain URL grab and a real-time
   live capture -- has been writing source_kind: 'local' (see
   tools/basiq_agent.py's run_grab and run_live_capture payloads), so the
   library UI's KIND column could never actually tell them apart. It reached
   for a videos.is_live column that was never added by any migration, so
   that read silently always came back falsy and every finished video showed
   "Download" regardless of how it was really captured (confirmed
   2026-09-23: a genuine 90-minute LIVE CAPTURE-mode recording still showed
   "KIND: Download").

   The old constraint has to go first - Postgres has no "replace check
   constraint" (same pattern as 0005_local_media.sql).
   ========================================================================= */

alter table public.videos
    drop constraint if exists videos_source_kind_check;

alter table public.videos
    add constraint videos_source_kind_check
    check (source_kind in ('upload', 'url', 'local', 'live'));
