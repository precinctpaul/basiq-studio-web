/* =========================================================================
   Fix archive_item_transcripts.search_tsv: 'english' config stems words,
   which was actively wrong for this use case -- "helene" and "helen" both
   stem to the same lexeme, so a search for Hurricane Helene silently
   returned every transcript that merely mentions someone named Helen.
   'simple' tokenizes and lowercases without stemming, so a search term
   only matches that term. Also fixes an unrelated correctness issue: a
   plain ILIKE scan of full_text (tried as a stopgap before this) took
   6-9+ seconds per search and occasionally timed out outright (500) on
   an unindexed ~8k-row table where some rows run past 250KB of text --
   this generated, GIN-indexed column is what actually makes search fast.

   Generated columns can't have their expression altered in place; drop
   and recreate (Postgres recomputes it from existing full_text values,
   so no data loss).
   ========================================================================= */

drop index if exists public.archive_item_transcripts_search_idx;
alter table public.archive_item_transcripts drop column if exists search_tsv;
alter table public.archive_item_transcripts
    add column search_tsv tsvector generated always as (to_tsvector('simple', full_text)) stored;

create index if not exists archive_item_transcripts_search_idx
    on public.archive_item_transcripts using gin (search_tsv);
