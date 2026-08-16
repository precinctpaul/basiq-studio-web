/* =========================================================================
   Basiq Studio Hub - smart tags

   Mirrors the desktop app's tag model (app/config.py TAG_AUTO / TAG_MANUAL):

     auto   - derived from the media by the local agent (named entities and
              semantic keyphrases from the transcript, plus metadata like the
              uploader). DISPOSABLE by design: re-tagging deletes and
              re-derives the whole auto set, exactly as a rescan does on the
              desktop.
     manual - typed by an operator. Must survive re-tagging, which is the
              entire reason `source` exists as a column rather than a flag
              inferred from where a tag came from.

   The pair (video_id, label) is unique regardless of source, so a tag can't
   exist twice on one video. When an operator types a tag the agent also
   derived, the manual row wins - see the API route, which upgrades rather
   than duplicates.

   Safe to run on an existing database; nothing here touches other tables.
   ========================================================================= */

create table if not exists public.tags (
    id         uuid primary key default gen_random_uuid(),
    video_id   uuid not null references public.videos (id) on delete cascade,

    label      text not null check (char_length(trim(label)) between 1 and 60),
    source     text not null default 'auto' check (source in ('auto', 'manual')),
    /* What produced an auto tag: entity | topic | meta. Null for manual tags.
       Kept for display and for tuning the extractor later without a
       re-derivation being needed to tell the kinds apart. */
    kind       text,

    created_at timestamptz not null default now(),

    constraint tags_unique_per_video unique (video_id, label)
);

/* The library list joins every video to its tags on every load, and search
   filters on label. Both want an index. */
create index if not exists tags_video_id_idx on public.tags (video_id);
create index if not exists tags_label_idx on public.tags (lower(label));

/* Deny-all, service-role bypasses - same posture as every other table here.
   Nothing in this app talks to Supabase from the browser with the anon key. */
alter table public.tags enable row level security;
