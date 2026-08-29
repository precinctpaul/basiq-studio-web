"""SQLite schema for the enriched archive index.

canonical_items mirrors the registry's Registry sheet (one row per
canonical content item) plus nullable enrichment columns filled in by
later resolution passes. files mirrors All Files Detail + Unmatched
(need review) (one row per physical file on disk) plus a proxy/master
guess. Enrichment columns start NULL and are only ever filled by a
resolver that records where the value came from, so a later pass can
tell a resolved fact from a missing one.
"""

import sqlite3

SCHEMA_SQL = """
create table if not exists canonical_items (
    canonical_id                 text primary key,
    id_type                      text not null,
    project_count                integer not null,
    projects                     text not null,
    has_video                    integer not null,
    has_raw_video_only           integer not null,
    has_transcript               integer not null,
    has_metadata                 integer not null,
    has_caption_file             integer not null,
    file_count                   integer not null,
    total_size_mb                real not null,
    is_duplicate_across_projects integer not null,

    title                        text,
    description                  text,
    duration_seconds             real,

    publish_date                 text,
    date_source                  text,

    person_bioguide_id           text,
    person_first_name            text,
    person_last_name             text,
    person_match_source          text,
    person_match_confidence      real,

    -- Folder-routing key, populated for anyone resolved regardless of
    -- whether they have a BioGuideID: the ID itself for Congress members,
    -- a normalized "last_first" slug for notable figures who never served
    -- (Trump, cabinet officials with no Hill history) -- see
    -- enrich_notable_figures.py. The folder builder keys off this column
    -- alone so it never needs to branch on identifier_type itself.
    person_folder_key           text,
    person_identifier_type      text check (person_identifier_type in ('bioguide', 'name_slug')),

    metadata_source              text,
    is_institutional              integer not null default 0,

    transcript_source           text,
    transcript_source_path      text,
    transcript_segment_count    integer,
    transcript_status           text not null default 'unresolved'
                                 check (transcript_status in ('unresolved', 'available', 'missing', 'failed')),

    -- Backfilled from notes (canonical_url=/source_url= entries written by
    -- earlier enrichment passes) rather than captured directly -- see
    -- backfill_source_url.py. A fresh database run starts this NULL for
    -- everyone until that script runs.
    source_url                   text,

    notes                        text
);

/* One row per distinct speaker/participant detected for a canonical item,
   independent of the single "primary subject" columns above. A floor
   session or press briefing can carry dozens of these with no single
   primary person at all; a single-member hearing clip typically has one
   row that duplicates the primary_subject fields. Kept separate so
   maximalist per-item metadata doesn't force a one-person-per-item
   decision that the source data doesn't support. */
create table if not exists item_speakers (
    id                integer primary key autoincrement,
    canonical_id      text not null references canonical_items (canonical_id),
    bioguide_id       text,
    first_name        text,
    last_name         text,
    raw_label         text not null,
    is_primary_subject integer not null default 0,
    match_source      text not null,
    match_confidence  real
);

create index if not exists idx_item_speakers_canonical on item_speakers (canonical_id);

create table if not exists files (
    id               integer primary key autoincrement,
    full_path        text not null unique,
    name             text not null,
    extension        text not null,
    size_mb          real not null,
    last_write_time  text,
    role             text not null,
    youtube_id       text,
    cspan_id         text,
    basiq_uuid       text,
    base_folder      text not null,
    project          text not null,
    canonical_id     text,
    id_type          text,

    quality_guess        text,
    quality_guess_source text,
    notes                text,

    foreign key (canonical_id) references canonical_items (canonical_id)
);

create index if not exists idx_files_canonical on files (canonical_id);
create index if not exists idx_files_role on files (role);

/* The registry's "Unmatched (need review)" sheet is narrower than "every
   file with no canonical_id": it only flags files whose role implies they
   *should* be part of a canonical item (video / metadata_json /
   transcript_csv). Loose scripts, logs, database files, and generic JSON
   swept up by the same filesystem scan also have no canonical_id, but were
   never expected to -- they aren't per-item content at all. This view
   reproduces the sheet's own 133-row definition instead of the file
   table's much broader canonical_id-is-null set, so a later report doesn't
   conflate "not canonical content" with "needs review". */
create view if not exists unmatched_content_files as
    select * from files
    where canonical_id is null
      and role in ('video', 'metadata_json', 'transcript_csv');

/* Mirrors Supabase public.tags (0004_tags.sql) -- same label/kind/source
   shape, generated by the same extract_tags() from basiq_agent.py, just
   run directly against an archive item's existing transcript instead of
   through a fresh upload. */
create table if not exists item_tags (
    id           integer primary key autoincrement,
    canonical_id text not null references canonical_items (canonical_id),
    label        text not null,
    kind         text,
    source       text not null default 'auto',
    unique (canonical_id, label)
);

create index if not exists idx_item_tags_canonical on item_tags (canonical_id);
"""


def connect(db_path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    # timeout: if two of this project's scripts are ever run at the same
    # time (they have been, by mistake), SQLite's default is to fail
    # immediately with "database is locked" rather than wait -- 30s gives
    # a concurrent writer's transaction a real chance to finish first.
    # Running two writers concurrently is still the thing to avoid; this
    # just keeps a brief overlap from being fatal.
    con = sqlite3.connect(db_path, timeout=30)
    con.executescript(SCHEMA_SQL)
    return con
