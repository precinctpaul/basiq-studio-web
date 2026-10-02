/* -------------------------------------------------------------------------
   0015 - subtitle_edits

   Hand fixes to burned-in SUBTITLE text (the SUBTITLES tab, shown while
   SUBS is ON) -- a missing period, a misheard word, an added >> speaker
   marker. Saved per video so re-clipping it later keeps the fixes.

   This is deliberately NOT the transcript. transcripts / transcript_segments
   are never modified by subtitle editing; search, graphics and the member
   command center read those and must never see these edits. The only reader
   of this table is lib/subtitle-edits.ts (subtitle preview + export).

   Keyed to the exact transcript version (transcript_id) and segment (idx)
   the edit was made against, with that segment's text at the time
   (original_text). If the video is re-transcribed (new transcript_id) or a
   segment's text changes, the edit simply stops applying rather than
   landing on the wrong words.

   Same security model as every other table (0001): RLS on, no policies,
   no anon/authenticated access -- server-side service role only.
   ------------------------------------------------------------------------- */
create table if not exists public.subtitle_edits (
    id             bigint generated always as identity primary key,
    video_id       uuid not null references public.videos (id) on delete cascade,
    transcript_id  uuid not null references public.transcripts (id) on delete cascade,
    segment_idx    integer not null,

    text           text not null check (char_length(text) <= 2000),
    original_text  text not null,

    updated_at     timestamptz not null default now(),

    constraint subtitle_edits_one_per_segment unique (transcript_id, segment_idx)
);

create index if not exists subtitle_edits_video_idx on public.subtitle_edits (video_id);

alter table public.subtitle_edits enable row level security;
revoke all on public.subtitle_edits from anon, authenticated;
