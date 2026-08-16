/* =========================================================================
   Basiq Studio Hub - publish date on videos

   The DETAILS panel has a PUBLISHED row (details_panel._FIELDS) fed by
   yt-dlp's upload_date, which arrives as a bare "YYYYMMDD" string rather
   than a real date - kept as text here for exactly that reason: it is
   whatever the extractor reported, sometimes partial, and coercing it to a
   date type would reject rows the desktop app displays perfectly happily.

   Safe to run at any time; the column is nullable with an empty default, so
   existing rows are unaffected and nothing needs backfilling.

   After running this, add `upload_date: z.string().max(20).optional()` back
   to PatchBody in app/api/videos/[id]/route.ts - the local agent already
   returns the value and is just waiting for somewhere to put it.
   ========================================================================= */
alter table public.videos
    add column if not exists upload_date text not null default '';
