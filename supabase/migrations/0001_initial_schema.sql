/* =========================================================================
   Basiq Studio Hub - web schema, v1

   Ported from the desktop app's SQLite index (app/database.py) and the
   dataclasses that drive export (app/ffmpeg_ops.py ClipPlan / MediaInfo,
   app/transcript.py Segment, app/highlights.py TopicSection).

   SECURITY MODEL - read this before adding a policy.
   There is no login. RLS is enabled on every table and NO policy is created,
   which means anon and authenticated can read and write NOTHING, ever. All
   access goes through Vercel Functions using the service-role key, which
   bypasses RLS. Share links are unguessable tokens resolved server-side.
   If you ever add a policy granting anon direct table access, you have made
   the entire library world-readable and world-writable. Don't.

   Block comments throughout, never "--". A "--" comment needs its line break
   to end; paste this through anything that collapses whitespace and every
   "--" swallows the statement that followed it on the same line. Block
   comments close explicitly and survive that.

   Paste into: Supabase Dashboard -> SQL Editor -> New query -> Run.
   Safe to re-run; every statement is idempotent.
   ========================================================================= */


/* -------------------------------------------------------------------------
   Storage buckets

   Both PRIVATE. The browser never touches these directly with the anon key:
   it asks a Function for a signed upload URL (createSignedUploadUrl) to put
   a video in, and a signed download URL to get a clip out. That keeps the
   bucket closed while still letting a 500 MB upload go browser -> Supabase
   without passing through a Function (which caps request bodies ~4.5 MB).

   file_size_limit here is intent, not enforcement: your plan's own ceiling
   applies first and is lower on Free.
   ------------------------------------------------------------------------- */
insert into storage.buckets (id, name, public, file_size_limit)
values ('videos', 'videos', false, 21474836480)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit)
values ('clips', 'clips', false, 2147483648)
on conflict (id) do nothing;


/* -------------------------------------------------------------------------
   videos - one row per source file. Mirrors database.MediaRow + MediaInfo.

   storage_path is a path, not a URL: signed URLs expire, so a persisted one
   would rot. Nullable until the upload actually lands.

   The probe block caches ffprobe output (ffmpeg_ops.MediaInfo) so the crop
   preview can compute geometry without re-probing, and so buildVideoChain's
   dimensions are known before export.
   ------------------------------------------------------------------------- */
create table if not exists public.videos (
    id               uuid primary key default gen_random_uuid(),
    title            text not null default 'Untitled',

    source_kind      text not null default 'upload'
                     check (source_kind in ('upload', 'url')),
    source_url       text not null default '',
    uploader         text not null default '',
    channel          text not null default '',

    storage_path     text,
    mime_type        text not null default '',
    size_bytes       bigint not null default 0,

    duration_seconds double precision not null default 0,
    width            integer not null default 0,
    height           integer not null default 0,
    fps              double precision not null default 0,
    has_video        boolean not null default true,
    has_audio        boolean not null default true,
    vcodec           text not null default '',
    acodec           text not null default '',

    status           text not null default 'uploading'
                     check (status in ('uploading', 'probing', 'ready', 'failed')),
    error            text not null default '',

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

create index if not exists idx_videos_created on public.videos (created_at desc);
create index if not exists idx_videos_title   on public.videos (lower(title));


/* -------------------------------------------------------------------------
   transcripts - one per video. Mirrors the _AI_Transcript.txt sidecar.

   full_text is the flattened prose, same role as media.transcript_text in
   SQLite: it is what search matches against, so segment timestamps never
   pollute a query.

   search_tsv replaces the desktop app's LIKE '%needle%'. An 11-hour
   transcript is ~1 MB of prose and a scan per keystroke would crawl. It is a
   generated column so it cannot drift from full_text the way a hand-updated
   index column would.
   ------------------------------------------------------------------------- */
create table if not exists public.transcripts (
    id         uuid primary key default gen_random_uuid(),
    video_id   uuid not null unique
               references public.videos (id) on delete cascade,

    source     text not null default 'whisper-local'
               check (source in ('whisper-local', 'imported-srt', 'imported-vtt')),
    model      text not null default 'base',
    language   text not null default 'en',

    full_text  text not null default '',
    search_tsv tsvector generated always as (to_tsvector('english', full_text)) stored,

    status     text not null default 'pending'
               check (status in ('pending', 'running', 'ready', 'failed')),
    error      text not null default '',

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists idx_transcripts_search
    on public.transcripts using gin (search_tsv);


/* -------------------------------------------------------------------------
   transcript_segments - transcript.Segment, one row per Whisper cue.

   These are the click targets: highlighting transcript text to set IN/OUT
   resolves the selection back to segment start/end, which is what
   transcript_panel.py does against parse_transcript() output today.

   The range index serves transcript.segments_in_range ("which segments
   overlap this IN/OUT window"), which runs on every scrub of the player.
   ------------------------------------------------------------------------- */
create table if not exists public.transcript_segments (
    id            bigint generated always as identity primary key,
    transcript_id uuid not null
                  references public.transcripts (id) on delete cascade,

    idx           integer not null,
    start_seconds double precision not null,
    end_seconds   double precision not null,
    text          text not null,

    unique (transcript_id, idx)
);

create index if not exists idx_segments_range
    on public.transcript_segments (transcript_id, start_seconds, end_seconds);


/* -------------------------------------------------------------------------
   key_moments - highlights.TopicSection.

   label is the TF-IDF term string ("healthcare - funding - appropriations").
   summary is summarize.py's written sentence, and is NULLABLE on purpose:
   summarize() returning None is a normal outcome (too little input, model
   absent) and the UI falls back to the label. A missing summary is never an
   error to surface.
   ------------------------------------------------------------------------- */
create table if not exists public.key_moments (
    id            uuid primary key default gen_random_uuid(),
    video_id      uuid not null references public.videos (id) on delete cascade,

    idx           integer not null,
    start_seconds double precision not null,
    end_seconds   double precision not null,
    label         text not null,
    summary       text,

    created_at    timestamptz not null default now(),
    unique (video_id, idx)
);


/* -------------------------------------------------------------------------
   clips - one row per export. ffmpeg_ops.ClipPlan persisted, plus the subset
   of Settings actually baked into this render.

   Those settings columns are not redundant. Settings are per-user and
   mutable; a clip is immutable output. Storing crf/preset/width/sigma per
   clip is what makes a re-render reproduce the same file a year later after
   the defaults have moved on - which is what a share link promises when it
   says "forever".

   aspect_mode holds stable slugs, NOT display strings. The desktop app
   stores "Native (16:9)" and friends, which means renaming a menu label
   silently orphans every stored row. Map at the edge:
     native        -> "Native (16:9)"      -> filename tag 16x9
     vertical_crop -> "9:16 (Center Crop)" -> filename tag 9x16crop
     vertical_blur -> "9:16 (Blur BG)"     -> filename tag 9x16blur

   crop_offset_x/y are crop_geometry() offsets, -1..1, 0 centred. Only
   meaningful for vertical_crop, and only on whichever axis has slack.
   ------------------------------------------------------------------------- */
create table if not exists public.clips (
    id               uuid primary key default gen_random_uuid(),
    video_id         uuid not null references public.videos (id) on delete cascade,
    title            text not null default '',

    in_point         double precision not null,
    out_point        double precision not null,

    padded_in        double precision not null,
    padded_out       double precision not null,
    duration_seconds double precision not null,
    fade_in          double precision not null default 2.0,
    fade_out         double precision not null default 2.0,
    video_fade       boolean not null default false,

    aspect_mode      text not null default 'native'
                     check (aspect_mode in ('native', 'vertical_crop', 'vertical_blur')),

    crop_offset_x    double precision not null default 0
                     check (crop_offset_x between -1 and 1),
    crop_offset_y    double precision not null default 0
                     check (crop_offset_y between -1 and 1),

    export_crf       integer not null default 18,
    export_preset    text    not null default 'veryfast',
    vertical_width   integer not null default 1080,
    blur_sigma       integer not null default 40,

    storage_path     text,
    size_bytes       bigint not null default 0,

    status           text not null default 'queued'
                     check (status in ('queued', 'rendering', 'ready', 'failed')),
    progress         double precision not null default 0,
    error            text not null default '',

    created_at       timestamptz not null default now(),
    completed_at     timestamptz,

    constraint clips_out_after_in check (out_point > in_point)
);

create index if not exists idx_clips_video   on public.clips (video_id, created_at desc);
create index if not exists idx_clips_created on public.clips (created_at desc);
create index if not exists idx_clips_status  on public.clips (status)
    where status in ('queued', 'rendering');


/* -------------------------------------------------------------------------
   share_tokens - /share/{token}, no auth, forever.

   token is generated in the app with
   crypto.randomBytes(24).toString('base64url'), not here: Postgres's encode()
   has no base64url, and hand-rolling one with translate() is how you quietly
   get '+' and '/' into a URL path.

   One clip can carry several tokens (share with two people, revoke one),
   which is why this is its own table rather than a column on clips.

   revoked_at is a soft revoke. A hard delete would make a revoked link
   indistinguishable from a typo'd one, and "this link was turned off" is a
   far better 404.
   ------------------------------------------------------------------------- */
create table if not exists public.share_tokens (
    token          text primary key,
    clip_id        uuid not null references public.clips (id) on delete cascade,

    label          text not null default '',
    download_count integer not null default 0,
    last_access_at timestamptz,
    revoked_at     timestamptz,

    created_at     timestamptz not null default now(),

    constraint share_token_len check (char_length(token) >= 22)
);

create index if not exists idx_share_tokens_clip on public.share_tokens (clip_id);


/* -------------------------------------------------------------------------
   updated_at maintenance
   ------------------------------------------------------------------------- */
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $touch$
begin
    new.updated_at = now();
    return new;
end;
$touch$;

drop trigger if exists trg_videos_updated on public.videos;
create trigger trg_videos_updated before update on public.videos
    for each row execute function public.touch_updated_at();

drop trigger if exists trg_transcripts_updated on public.transcripts;
create trigger trg_transcripts_updated before update on public.transcripts
    for each row execute function public.touch_updated_at();


/* -------------------------------------------------------------------------
   Lock everything down. See the SECURITY MODEL note at the top.
   Enabled with no policies = deny-all for anon and authenticated.
   service_role (server-side only, never shipped to the browser) bypasses RLS.
   ------------------------------------------------------------------------- */
alter table public.videos              enable row level security;
alter table public.transcripts         enable row level security;
alter table public.transcript_segments enable row level security;
alter table public.key_moments         enable row level security;
alter table public.clips               enable row level security;
alter table public.share_tokens        enable row level security;

revoke all on all tables in schema public from anon, authenticated;
