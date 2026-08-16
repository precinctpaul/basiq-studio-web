/* =========================================================================
   Basiq Studio Hub - shared media on LucidLink (or any shared drive)

   THE POINT: masters stop living in Supabase.

   A hearing is hours long and hundreds of megabytes; a shared team drive is
   already where this team keeps footage, and the free storage tier is 1GB.
   So the BYTES live on the shared drive and Supabase keeps only the row that
   describes them. Everything already built - transcripts, segments, tags,
   key moments, search - is keyed on videos.id and therefore keeps working
   untouched, because the row still exists. Only the source of the pixels
   changes.

   storage_path  -> object in the Supabase bucket   (uploads, exported clips)
   local_path    -> path relative to the agent's MEDIA_ROOT (shared drive)

   Exactly one is set. A local row is played and exported by the local agent;
   a stored row is played from a signed URL exactly as before.

   Exported clips deliberately still go to Supabase: they are small, and a
   share link has to work for someone with no agent and no drive access.

   Safe to run at any time. Existing rows are untouched and keep storage_path.
   ========================================================================= */

alter table public.videos
    add column if not exists local_path text;

/* 'local' joins 'upload' and 'url' as a provenance. The old constraint has to
   go first - Postgres has no "replace check constraint". */
alter table public.videos
    drop constraint if exists videos_source_kind_check;

alter table public.videos
    add constraint videos_source_kind_check
    check (source_kind in ('upload', 'url', 'local'));

/* A shared drive is the same for everyone, so the same file must not produce
   a second row when another teammate's agent scans it. Partial, because
   local_path is null for everything already in the bucket. */
create unique index if not exists videos_local_path_key
    on public.videos (local_path)
    where local_path is not null;

/* A local row has no bucket object, so 'ready' has to be reachable without
   storage_path being set. Nothing enforced that before; this documents it. */
comment on column public.videos.local_path is
    'Path relative to the agent MEDIA_ROOT for media on the shared drive. '
    'Mutually exclusive with storage_path.';
