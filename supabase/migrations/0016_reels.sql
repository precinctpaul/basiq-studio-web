/* =========================================================================
   Basiq Studio Hub - reels (multi-clip timeline -> single exported reel)

   See REELS_DESIGN.md for the full design conversation this schema comes
   from. Generalizes the existing `clips` table (one segment, one export) to
   N ordered segments feeding one render job -- a reel is metadata only
   until exported: an ordered list of (video_id, in, out, aspect settings)
   pointers into videos already in the library, no duplicated storage.

   canvas_width/canvas_height, not an aspect_mode enum like clips has: the
   reel's OUTPUT shape has to be one concrete size regardless of what shape
   any individual segment's source is. Each segment still carries its own
   aspect_mode/crop_offset_* (same meaning as the identical columns on
   clips) to say how THAT segment gets fit into the reel's fixed canvas.

   Rendered reels land in the existing 'clips' storage bucket (see
   0001_initial_schema.sql) -- a reel's output is a video file like any
   clip's is; it doesn't need its own bucket.

   Paste into: Supabase Dashboard -> SQL Editor -> New query -> Run.
   Safe to re-run; every statement is idempotent.
   ========================================================================= */

create table if not exists public.reels (
    id            uuid primary key default gen_random_uuid(),
    title         text not null default 'Untitled Reel',

    canvas_width  integer not null default 1080,
    canvas_height integer not null default 1920,

    storage_path  text,
    size_bytes    bigint not null default 0,

    status        text not null default 'draft'
                  check (status in ('draft', 'queued', 'rendering', 'ready', 'failed')),
    progress      double precision not null default 0,
    error         text not null default '',

    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

create index if not exists idx_reels_created on public.reels (created_at desc);


/* -------------------------------------------------------------------------
   reel_segments - one ordered pick per row. video_id points at the raw
   source (public.videos), NOT at public.clips -- a segment is cut directly
   from the source at render time; routing every timeline entry through a
   full standalone clip export first would mean extra renders and storage
   for no benefit (see REELS_DESIGN.md).

   on delete restrict: deleting a source video used in a saved reel must
   fail loudly, never silently shrink the reel. Whatever "delete a video"
   feature eventually gets built has to look up and surface the blocking
   reels/positions before attempting the delete -- see REELS_DESIGN.md's
   "Delete-blocked UX requirement".
   ------------------------------------------------------------------------- */
create table if not exists public.reel_segments (
    id            bigint generated always as identity primary key,
    reel_id       uuid not null references public.reels (id) on delete cascade,
    video_id      uuid not null references public.videos (id) on delete restrict,

    position      integer not null,

    in_point      double precision not null,
    out_point     double precision not null,

    aspect_mode   text not null default 'native'
                  check (aspect_mode in ('native', 'vertical_crop', 'vertical_blur')),
    crop_offset_x double precision not null default 0
                  check (crop_offset_x between -1 and 1),
    crop_offset_y double precision not null default 0
                  check (crop_offset_y between -1 and 1),

    created_at    timestamptz not null default now(),

    unique (reel_id, position),
    constraint reel_segments_out_after_in check (out_point > in_point)
);

create index if not exists idx_reel_segments_reel  on public.reel_segments (reel_id, position);
create index if not exists idx_reel_segments_video on public.reel_segments (video_id);


/* -------------------------------------------------------------------------
   share_tokens widening - a rendered reel is shareable exactly like a clip
   is, so it reuses the same token/download-count/revoke table instead of a
   parallel reel_share_tokens clone. clip_id becomes nullable, reel_id is
   added nullable, and exactly one of the two must be set.

   The old NOT NULL has to come off before the new CHECK is meaningful, same
   two-step constraint swap as 0013_live_capture_source_kind.sql.
   ------------------------------------------------------------------------- */
alter table public.share_tokens
    alter column clip_id drop not null;

alter table public.share_tokens
    add column if not exists reel_id uuid references public.reels (id) on delete cascade;

alter table public.share_tokens
    drop constraint if exists share_tokens_one_target;

alter table public.share_tokens
    add constraint share_tokens_one_target
    check ((clip_id is not null) <> (reel_id is not null));

create index if not exists idx_share_tokens_reel on public.share_tokens (reel_id);


/* -------------------------------------------------------------------------
   updated_at maintenance - reuses public.touch_updated_at() from
   0001_initial_schema.sql.
   ------------------------------------------------------------------------- */
drop trigger if exists trg_reels_updated on public.reels;
create trigger trg_reels_updated before update on public.reels
    for each row execute function public.touch_updated_at();


/* -------------------------------------------------------------------------
   Lock down. See 0001_initial_schema.sql's SECURITY MODEL note -- RLS
   enabled, no policies, deny-all for anon/authenticated, service_role
   (server-side only) bypasses RLS.
   ------------------------------------------------------------------------- */
alter table public.reels         enable row level security;
alter table public.reel_segments enable row level security;

revoke all on public.reels         from anon, authenticated;
revoke all on public.reel_segments from anon, authenticated;
