/**
 * subtitle-edits.ts — hand fixes to burned-in subtitle text, saved per video
 * in public.subtitle_edits (migration 0015).
 *
 * Never touches the transcript. Edits are overlaid on a COPY of the segment
 * rows at the moment subtitles are built (preview and export); transcripts /
 * transcript_segments stay exactly as they are for search, graphics and the
 * member command center.
 *
 * An edit only applies while the segment still says what it said when the
 * edit was made (original_text) on the same transcript version -- after a
 * re-transcription the old fix would be pinned to the wrong words.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface IndexedSegment {
  idx: number;
  text: string;
}

/** idx -> edited text, for the edits that still apply to these segments. */
export async function loadSubtitleEdits(
  db: SupabaseClient,
  transcriptId: string,
  segments: IndexedSegment[],
): Promise<Map<number, string>> {
  const { data, error } = await db
    .from("subtitle_edits")
    .select("segment_idx, text, original_text")
    .eq("transcript_id", transcriptId);
  // Table not created yet (migration 0015 not run) = no edits, not a broken
  // export. Postgres 42P01 / PostgREST PGRST205 are "relation not found".
  if (error && (error.code === "42P01" || error.code === "PGRST205")) return new Map();
  if (error) throw new Error(error.message);
  const current = new Map(segments.map((s) => [s.idx, s.text]));
  const edits = new Map<number, string>();
  for (const e of data ?? []) {
    if (current.get(e.segment_idx) === e.original_text) edits.set(e.segment_idx, e.text);
  }
  return edits;
}

/** The segments with any applicable edits swapped in -- a new array; inputs untouched. */
export function applySubtitleEdits<T extends IndexedSegment>(segments: T[], edits: Map<number, string>): T[] {
  return segments.map((s) => (edits.has(s.idx) ? { ...s, text: edits.get(s.idx)! } : s));
}
