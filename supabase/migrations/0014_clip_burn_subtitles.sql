/* -------------------------------------------------------------------------
   0014 - clips.burn_subtitles

   Records whether an export had transcript subtitles burned into the video
   (the SUBTITLES toggle next to EXPORT CLIP). Touches the clips table only;
   transcripts and transcript_segments are not altered.

   Safe to run any time: exports with subtitles OFF never write this column,
   so they keep working before and after it exists.
   ------------------------------------------------------------------------- */
alter table public.clips
    add column if not exists burn_subtitles boolean not null default false;
