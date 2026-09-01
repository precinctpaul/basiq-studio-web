import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { GoogleGenAI, Type } from "@google/genai";
import { Parser } from "node-sql-parser";

export const runtime = "nodejs";

// A rolling alias (always Google's current recommended flash model) rather
// than a pinned version number -- gemini-2.0-flash, this route's original
// choice, was already retired by the time this shipped. Pinning a version
// just means repeating that dead-key-shaped surprise every time Google
// rotates the lineup.
const MODEL = "gemini-flash-latest";

const RequestBody = z.object({
  mode: z.enum(["sql", "html"]),
  prompt: z.string().trim().min(1).max(2000),
});

/** Hand-written from supabase/migrations/000{1,4,5,6,7,8,9}*.sql so Gemini
 *  generates against real tables/columns instead of guessing a schema. Keep
 *  this in sync when a migration changes a table shape this tool cares about
 *  -- it is not introspected live, to keep this route from needing its own
 *  DB round trip just to build a prompt. */
const SCHEMA_CONTEXT = `
public.videos (id uuid pk, title text, source_kind text, source_url text, uploader text,
  channel text, local_path text, storage_path text, size_bytes bigint, duration_seconds double,
  width int, height int, fps double, has_video bool, has_audio bool, vcodec text, acodec text,
  status text check in ('uploading','probing','ready','failed','recording'), error text,
  upload_date text, created_at timestamptz, updated_at timestamptz)

public.transcripts (id uuid pk, video_id uuid fk->videos.id, source text check in
  ('whisper-local','imported-srt','imported-vtt'), model text, language text, full_text text,
  status text check in ('pending','running','ready','failed'), error text, created_at, updated_at)

public.transcript_segments (id bigint pk, transcript_id uuid fk->transcripts.id, idx int,
  start_seconds double, end_seconds double, text text)

public.key_moments (id uuid pk, video_id uuid fk->videos.id, idx int, start_seconds double,
  end_seconds double, label text, summary text, created_at)

public.tags (id uuid pk, video_id uuid fk->videos.id, label text, source text check in
  ('auto','manual'), kind text, created_at)

public.clips (id uuid pk, video_id uuid fk->videos.id, title text, in_point double, out_point double,
  duration_seconds double, aspect_mode text check in ('native','vertical_crop','vertical_blur'),
  storage_path text, size_bytes bigint, status text check in ('queued','rendering','ready','failed'),
  error text, created_at, completed_at)

public.share_tokens (token text pk, clip_id uuid fk->clips.id, label text, download_count int,
  last_access_at timestamptz, revoked_at timestamptz, created_at)

public.people (id uuid pk, identifier_type text check in ('bioguide','name_slug'),
  bioguide_id text, name_slug text, first_name text, last_name text, full_name text,
  chamber text, state text, party text, is_current bool, external_ids jsonb)

public.archive_items (id text pk, source_platform text check in ('youtube','cspan','basiq'),
  title text, description text, publish_date date, duration_seconds double, source_url text,
  is_institutional bool, video_completeness text check in ('both','master_only','proxy_only','no_video'),
  primary_person_id uuid fk->people.id, transcript_status text check in
  ('unresolved','available','missing','failed'), transcript_source text, transcript_segment_count int)

public.archive_item_people (archive_item_id text fk->archive_items.id, person_id uuid fk->people.id,
  role text check in ('primary_subject','speaker','mentioned'), match_source text, match_confidence double)

public.legislation (id bigint pk, congress int, bill_type text, bill_number int, title text, display text)

public.archive_item_legislation (archive_item_id text fk->archive_items.id, legislation_id bigint fk->legislation.id)

public.archive_item_transcripts (id uuid pk, archive_item_id text fk->archive_items.id unique,
  source text, full_text text, segment_count int, created_at)
`.trim();

const SQL_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    query: {
      type: Type.STRING,
      description: "A single read-only PostgreSQL SELECT statement. Empty string if the request cannot be answered with a read-only query.",
    },
    explanation: { type: Type.STRING, description: "One sentence: what the query does, or why it couldn't be written." },
    tables_used: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["query", "explanation", "tables_used"],
};

const HTML_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    subject: { type: Type.STRING, description: "Email subject line." },
    html_body: {
      type: Type.STRING,
      description: "A single, complete, self-contained HTML document: inline CSS only, table-based layout for email-client compatibility, no external stylesheets, fonts, or scripts.",
    },
  },
  required: ["subject", "html_body"],
};

function client(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured in .env.local");
  return new GoogleGenAI({ apiKey });
}

const WRITE_STATEMENT = /\b(insert|update|delete|drop|alter|truncate|grant|revoke|create)\b/i;

export async function POST(req: NextRequest) {
  const parsed = RequestBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { mode, prompt } = parsed.data;

  let ai: GoogleGenAI;
  try {
    ai = client();
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  if (mode === "sql") {
    const contents = [
      "You write a single READ-ONLY PostgreSQL SELECT query against the schema below.",
      "Never write INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/CREATE/GRANT -- if the",
      "request would require one, leave \"query\" empty and explain why instead.",
      "",
      "Schema:",
      SCHEMA_CONTEXT,
      "",
      `Request: ${prompt}`,
    ].join("\n");

    let text: string | undefined;
    try {
      const response = await ai.models.generateContent({
        model: MODEL,
        contents,
        config: { responseMimeType: "application/json", responseSchema: SQL_SCHEMA },
      });
      text = response.text;
    } catch (err) {
      return NextResponse.json({ error: `Gemini request failed: ${(err as Error).message}` }, { status: 502 });
    }

    let data: { query: string; explanation: string; tables_used: string[] };
    try {
      data = JSON.parse(text ?? "");
    } catch {
      return NextResponse.json({ error: "Gemini returned output that wasn't valid JSON." }, { status: 502 });
    }

    const query = (data.query || "").trim();
    if (query && WRITE_STATEMENT.test(query)) {
      return NextResponse.json(
        { error: "The generated statement looked like a write/DDL operation and was blocked. Try rephrasing as a question about existing data." },
        { status: 422 },
      );
    }

    let sqlValid = true;
    let sqlParseError = "";
    if (query) {
      try {
        new Parser().astify(query, { database: "postgresql" });
      } catch (err) {
        sqlValid = false;
        sqlParseError = (err as Error).message;
      }
    }

    return NextResponse.json({ mode, query, explanation: data.explanation, tablesUsed: data.tables_used ?? [], sqlValid, sqlParseError });
  }

  // mode === "html"
  const contents = [
    "Write a single, complete, self-contained HTML email body: inline CSS only,",
    "table-based layout for broad email-client compatibility, no external",
    "stylesheets/fonts/scripts, no <html>/<head>/<body> wrapper needed.",
    "",
    `Request: ${prompt}`,
  ].join("\n");

  let text: string | undefined;
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: { responseMimeType: "application/json", responseSchema: HTML_SCHEMA },
    });
    text = response.text;
  } catch (err) {
    return NextResponse.json({ error: `Gemini request failed: ${(err as Error).message}` }, { status: 502 });
  }

  let data: { subject: string; html_body: string };
  try {
    data = JSON.parse(text ?? "");
  } catch {
    return NextResponse.json({ error: "Gemini returned output that wasn't valid JSON." }, { status: 502 });
  }

  if (!data.html_body?.trim()) {
    return NextResponse.json({ error: "Gemini returned an empty document." }, { status: 502 });
  }

  return NextResponse.json({ mode, subject: data.subject, htmlBody: data.html_body });
}
