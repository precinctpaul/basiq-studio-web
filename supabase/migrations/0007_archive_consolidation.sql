/* =========================================================================
   Basiq Studio Hub - archive consolidation

   Moves tools/archive_consolidation's enriched_index.sqlite3 (9,032
   canonical items resolved from the 44,878-file, 4-location legacy
   archive) into real, relational, foreign-keyed tables instead of a local
   SQLite file nobody but that tool can query. This is also the schema the
   "move to knowledge graphs / natural-language search" goal actually
   depends on: a graph layer (Neo4j, TypeDB, Apache AGE, whatever gets
   picked later) is a re-projection of explicit nodes and edges, and edges
   are exactly what archive_item_people / archive_item_legislation are.
   Bolting that on top of loose text fields later would mean re-deriving
   every relationship from scratch; having it as real FKs now means the
   later graph export is a straight read.

   people           - one row per person, Congress member or not. Congress
                      members carry a real bioguide_id; a notable figure
                      with no BioGuideID (Trump, a state legislator like
                      Mallory McMorrow, a mayor like Paige Cognetti) carries
                      a name_slug instead. external_ids is a jsonb grab-bag
                      (openstates id, congress.gov id, ...) on purpose --
                      new source IDs show up faster than migrations should.
   archive_items    - one row per canonical item (id IS the canonical_id:
                      an 11-char YouTube ID, a C-SPAN numeric program ID,
                      or a Basiq UUID -- a real natural key, not a
                      surrogate one, since every source already guarantees
                      it's unique and it's what every join in this project
                      has used from day one).
   archive_item_files       - physical files (master/proxy/caption/...),
                              many per item; duplicates across the legacy
                              archive's 4 locations are ALL kept here, not
                              deduplicated -- picking "the" copy is a
                              downstream decision, not a data-loss one.
   archive_item_people      - the graph edge between items and people.
                              Deliberately separate from a single
                              "primary_person_id" column on archive_items:
                              a floor session can have one row per speaker
                              with role='speaker' and no single subject,
                              while a hearing clip has exactly one row with
                              role='primary_subject'.
   legislation / archive_item_legislation - bills referenced by a program,
                              from cspan_discovery's own legislation table.
   archive_item_transcripts / _segments - same shape as the existing
                              transcripts/transcript_segments tables
                              (full_text + generated tsvector, timed
                              segments), kept as its own pair rather than
                              reusing those because archive_items uses a
                              text natural key, not the videos table's uuid.

   Safe to run on an existing database; nothing here touches other tables.
   Same security posture as everywhere else in this file: RLS enabled, no
   policy, so anon/authenticated can do nothing -- only the service-role
   key (server-side only) can touch these tables.
   ========================================================================= */


/* -------------------------------------------------------------------------
   people
   ------------------------------------------------------------------------- */
create table if not exists public.people (
    id              uuid primary key default gen_random_uuid(),

    identifier_type text not null check (identifier_type in ('bioguide', 'name_slug')),
    bioguide_id     text unique,
    name_slug       text unique,

    first_name      text not null default '',
    last_name       text not null default '',
    full_name       text not null default '',
    chamber         text,
    state           text,
    party           text,
    is_current      boolean not null default false,

    /* External cross-references as they accumulate -- openstates_id,
       congress_gov_id, fec_candidate_id, etc. -- without a migration per
       new source. Keys are free-form on purpose; nothing queries into
       this beyond "does this person have an X" lookups. */
    external_ids    jsonb not null default '{}'::jsonb,

    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),

    constraint people_identifier_matches_type check (
        (identifier_type = 'bioguide'  and bioguide_id is not null and name_slug is null)
        or
        (identifier_type = 'name_slug' and name_slug is not null and bioguide_id is null)
    )
);

create index if not exists people_last_name_idx on public.people (lower(last_name));


/* -------------------------------------------------------------------------
   archive_items
   ------------------------------------------------------------------------- */
create table if not exists public.archive_items (
    id                       text primary key,
    source_platform          text not null check (source_platform in ('youtube', 'cspan', 'basiq')),

    title                    text,
    description              text,
    publish_date             date,
    date_source              text check (date_source in ('published', 'file_modified', 'basiq_ingested_at')),
    duration_seconds         double precision,
    source_url               text,

    is_institutional         boolean not null default false,
    video_completeness       text check (video_completeness in ('both', 'master_only', 'proxy_only', 'no_video')),

    primary_person_id        uuid references public.people (id),
    person_match_source      text,
    person_match_confidence  double precision,

    transcript_status        text not null default 'unresolved'
                              check (transcript_status in ('unresolved', 'available', 'missing', 'failed')),
    transcript_source        text,
    transcript_segment_count integer,

    notes                    text,

    created_at               timestamptz not null default now(),
    updated_at               timestamptz not null default now(),

    /* Search everywhere the local-agent library already promises, applied
       to the archive: title + description, generated so it can never
       silently drift from the columns it's derived from. */
    search_tsv               tsvector generated always as (
                                  to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))
                              ) stored
);

create index if not exists archive_items_search_idx on public.archive_items using gin (search_tsv);
create index if not exists archive_items_person_idx on public.archive_items (primary_person_id);
create index if not exists archive_items_publish_date_idx on public.archive_items (publish_date desc);


/* -------------------------------------------------------------------------
   archive_item_files
   ------------------------------------------------------------------------- */
create table if not exists public.archive_item_files (
    id              bigint generated always as identity primary key,
    archive_item_id text not null references public.archive_items (id) on delete cascade,

    full_path       text not null,
    role            text not null,
    extension       text,
    size_mb         double precision,
    project         text,
    quality_guess   text,
    last_write_time text,

    unique (archive_item_id, full_path)
);

create index if not exists archive_item_files_item_idx on public.archive_item_files (archive_item_id);


/* -------------------------------------------------------------------------
   archive_item_people - the item<->person graph edge
   ------------------------------------------------------------------------- */
create table if not exists public.archive_item_people (
    id                bigint generated always as identity primary key,
    archive_item_id   text not null references public.archive_items (id) on delete cascade,
    person_id         uuid not null references public.people (id) on delete cascade,

    role              text not null default 'primary_subject'
                      check (role in ('primary_subject', 'speaker', 'mentioned')),
    match_source      text,
    match_confidence  double precision,

    unique (archive_item_id, person_id, role)
);

create index if not exists archive_item_people_item_idx on public.archive_item_people (archive_item_id);
create index if not exists archive_item_people_person_idx on public.archive_item_people (person_id);


/* -------------------------------------------------------------------------
   legislation
   ------------------------------------------------------------------------- */
create table if not exists public.legislation (
    id          bigint generated always as identity primary key,
    congress    integer,
    bill_type   text,
    bill_number integer,
    title       text,
    display     text,

    unique (congress, bill_type, bill_number)
);

create table if not exists public.archive_item_legislation (
    archive_item_id text not null references public.archive_items (id) on delete cascade,
    legislation_id  bigint not null references public.legislation (id) on delete cascade,

    primary key (archive_item_id, legislation_id)
);


/* -------------------------------------------------------------------------
   archive_item_transcripts / archive_item_transcript_segments

   Same shape as public.transcripts / public.transcript_segments (see
   0001_initial_schema.sql) -- kept as its own pair rather than reusing
   those directly because archive_items has a text natural-key id, not the
   videos table's uuid, and a shared table would need a nullable
   video_id/archive_item_id pair on every row either way.
   ------------------------------------------------------------------------- */
create table if not exists public.archive_item_transcripts (
    id              uuid primary key default gen_random_uuid(),
    archive_item_id text not null unique references public.archive_items (id) on delete cascade,

    source          text not null,
    full_text       text not null default '',
    search_tsv      tsvector generated always as (to_tsvector('english', full_text)) stored,
    segment_count   integer not null default 0,

    created_at      timestamptz not null default now()
);

create index if not exists archive_item_transcripts_search_idx
    on public.archive_item_transcripts using gin (search_tsv);

create table if not exists public.archive_item_transcript_segments (
    id            bigint generated always as identity primary key,
    transcript_id uuid not null references public.archive_item_transcripts (id) on delete cascade,

    idx           integer not null,
    start_seconds double precision not null,
    end_seconds   double precision not null,
    text          text not null,

    unique (transcript_id, idx)
);

create index if not exists archive_item_transcript_segments_range_idx
    on public.archive_item_transcript_segments (transcript_id, start_seconds, end_seconds);


/* -------------------------------------------------------------------------
   updated_at maintenance (reuses public.touch_updated_at from 0001)
   ------------------------------------------------------------------------- */
drop trigger if exists trg_people_updated on public.people;
create trigger trg_people_updated before update on public.people
    for each row execute function public.touch_updated_at();

drop trigger if exists trg_archive_items_updated on public.archive_items;
create trigger trg_archive_items_updated before update on public.archive_items
    for each row execute function public.touch_updated_at();


/* -------------------------------------------------------------------------
   Lock everything down. See the SECURITY MODEL note in 0001_initial_schema.sql.
   ------------------------------------------------------------------------- */
alter table public.people                             enable row level security;
alter table public.archive_items                       enable row level security;
alter table public.archive_item_files                  enable row level security;
alter table public.archive_item_people                 enable row level security;
alter table public.legislation                         enable row level security;
alter table public.archive_item_legislation             enable row level security;
alter table public.archive_item_transcripts             enable row level security;
alter table public.archive_item_transcript_segments      enable row level security;

revoke all on public.people,
                public.archive_items,
                public.archive_item_files,
                public.archive_item_people,
                public.legislation,
                public.archive_item_legislation,
                public.archive_item_transcripts,
                public.archive_item_transcript_segments
    from anon, authenticated;
