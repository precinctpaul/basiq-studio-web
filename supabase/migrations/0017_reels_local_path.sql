/* =========================================================================
   Basiq Studio Hub - reels land on the shared drive, like clips do today

   0016_reels.sql gave `reels` a `storage_path`/`size_bytes` pair, mirroring
   0001's ORIGINAL clips shape -- but that's stale. 0006_drive_only.sql moved
   clips off Supabase Storage entirely: "New clips always set [local_path] -
   storage_path only exists for clips rendered before this migration." A
   rendered reel is produced by the exact same local agent doing the exact
   same kind of ffmpeg write to the shared drive (see REELS_DESIGN.md's
   export job shape) - it should never have been storage_path-first to
   begin with.

   Not dropping the storage_path/size_bytes columns 0016 already added and
   the user already ran against their live database - same reasoning as
   0006 itself gave for leaving clips.storage_path in place: dropping a
   column someone already applied is not something to bundle into a
   feature migration. size_bytes stays meaningful either way; storage_path
   simply goes unused for reels going forward, same as it now is for clips.

   completed_at added for parity with clips (see /api/clips/[id]/complete) -
   0016 had progress/status but missed this one.

   Paste into: Supabase Dashboard -> SQL Editor -> New query -> Run.
   Safe to re-run; every statement is idempotent.
   ========================================================================= */

alter table public.reels
    add column if not exists local_path text;

create unique index if not exists reels_local_path_key
    on public.reels (local_path)
    where local_path is not null;

comment on column public.reels.local_path is
    'Path relative to the agent MEDIA_ROOT for the rendered reel on the '
    'shared drive. This is the field new reels use; storage_path is legacy '
    'shape only, unused going forward (same relationship as clips.local_path '
    'vs clips.storage_path since 0006_drive_only.sql).';

alter table public.reels
    add column if not exists completed_at timestamptz;
