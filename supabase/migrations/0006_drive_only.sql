/* =========================================================================
   Basiq Studio Hub - drive-only storage

   THE POINT: nothing but LucidLink holds video bytes, ever again.

   0005 made local_path an OPTION alongside Supabase storage_path. This
   migration doesn't remove storage_path (existing code and any leftover rows
   still reference it, and dropping a column is not something to bundle into
   a feature migration) - it just makes the schema ready for two things new
   code needs:

     1. A video row that exists WHILE a live capture is still recording, so
        the operator can watch its transcript grow and clip from it before
        the stream ends. That is a new status, not a new column - 'recording'
        joins 'uploading'/'probing'/'ready'/'failed'.

     2. A clip that lives on the shared drive instead of the clips bucket -
        clips.local_path, mirroring videos.local_path from 0005 exactly,
        including the same "one shared drive, so the same file can't produce
        two rows" partial unique index.

   Paste into: Supabase Dashboard -> SQL Editor -> New query -> Run.
   Safe to re-run; every statement is idempotent.
   ========================================================================= */

alter table public.videos
    drop constraint if exists videos_status_check;

alter table public.videos
    add constraint videos_status_check
    check (status in ('uploading', 'probing', 'recording', 'ready', 'failed'));

comment on column public.videos.status is
    'recording: a live capture in progress - local_path points at the '
    'still-growing file on the shared drive, duration/probe fields are not '
    'final yet. Transitions to ready when the capture finishes.';


alter table public.clips
    add column if not exists local_path text;

create unique index if not exists clips_local_path_key
    on public.clips (local_path)
    where local_path is not null;

comment on column public.clips.local_path is
    'Path relative to the agent MEDIA_ROOT for a clip filed to the shared '
    'drive. Mutually exclusive with storage_path. New clips always set this '
    '- storage_path only exists for clips rendered before this migration.';
