/* =========================================================================
   Basiq Studio Hub - document the live transcripts.source constraint

   Schema-documentation catch-up, no data changes. 0001_initial_schema.sql
   defined transcripts.source with an inline, unnamed CHECK allowing only
   ('whisper-local', 'imported-srt', 'imported-vtt') - Postgres auto-named
   it transcripts_source_check (same convention as videos_status_check in
   0006_drive_only.sql). At some point the live database's constraint was
   ALTERed directly in the Supabase SQL editor to also allow
   'imported-cspan' (written by tools/cspan_import_transcripts.py), without
   a migration file ever being committed for it.

   Confirmed against the live database via the REST API (service-role key,
   Prefer: count=exact) on 2026-09-01: every one of the table's 10,311 rows
   falls into exactly one of the four values below, with none left over -
       whisper-local:  3395
       imported-srt:   6691
       imported-vtt:     13
       imported-cspan:  212
   so the live constraint's allowed set is exactly this one plus
   'imported-cspan'; there is no fifth value in use.

   Paste into: Supabase Dashboard -> SQL Editor -> New query -> Run.
   Safe to re-run; every statement is idempotent. Already a no-op against
   the live database (its constraint already allows 'imported-cspan') -
   this migration exists purely so the committed schema matches it.
   ========================================================================= */

alter table public.transcripts
    drop constraint if exists transcripts_source_check;

alter table public.transcripts
    add constraint transcripts_source_check
    check (source in ('whisper-local', 'imported-srt', 'imported-vtt', 'imported-cspan'));
