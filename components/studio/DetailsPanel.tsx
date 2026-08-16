"use client";

import { formatTc, humanSize } from "@/lib/timecode";
import { ShareBar } from "@/components/studio/ShareBar";

const EMPTY = "—";

export interface DetailsRow {
  id: string;
  title: string;
  duration_seconds: number;
  size_bytes: number;
  width: number;
  height: number;
  vcodec: string;
  acodec: string;
  fps: number;
  created_at: string;
  uploader?: string | null;
  channel?: string | null;
  upload_date?: string | null;
  source_url?: string | null;
  storage_path?: string | null;
  is_clip?: boolean;
  is_live?: boolean;
  has_transcript?: boolean;
  tags?: string[];
  manual_tags?: string[];
}

interface Props {
  row: DetailsRow | null;
  emptyMessage: string;
  /** Present when the selected row is a rendered clip that has a live share token. */
  share?: { url: string; downloadCount: number } | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Port of pretty_upload_date — "20260814" -> "14 Aug 2026". */
function prettyUploadDate(raw?: string | null): string {
  if (!raw) return EMPTY;
  if (!/^\d{8}$/.test(raw)) return raw;
  const y = raw.slice(0, 4);
  const m = Number(raw.slice(4, 6));
  const d = raw.slice(6, 8);
  return `${d} ${MONTHS[m - 1] ?? "?"} ${y}`;
}

function formatModified(iso: string): string {
  if (!iso) return EMPTY;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return EMPTY;
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  // Two spaces between date and time, matching "%d %b %Y  %H:%M".
  return `${day} ${MONTHS[d.getMonth()]} ${d.getFullYear()}  ${hh}:${mm}`;
}

export function DetailsPanel({ row, emptyMessage, share }: Props) {
  // Every field always occupies its row even when empty — deliberate in the
  // original, so the panel never reflows as probe results land.
  const fields: Array<[string, string]> = [
    ["TITLE", row ? row.title || EMPTY : emptyMessage],
    ["KIND", row ? (row.is_clip ? "Clip" : row.is_live ? "Live capture" : "Download") : EMPTY],
    ["DURATION", row?.duration_seconds ? formatTc(row.duration_seconds, 0) : EMPTY],
    ["SIZE", row?.size_bytes ? humanSize(row.size_bytes) : EMPTY],
    ["MODIFIED", row ? formatModified(row.created_at) : EMPTY],
    ["UPLOADER", row?.uploader || EMPTY],
    ["CHANNEL", row?.channel || EMPTY],
    ["PUBLISHED", prettyUploadDate(row?.upload_date)],
    [
      "RESOLUTION",
      row?.width && row?.height
        ? `${row.width}x${row.height}${row.height > row.width ? "  (vertical)" : ""}`
        : EMPTY,
    ],
    ["VIDEO", row?.vcodec ? `${row.vcodec}${row.fps ? `  ·  ${row.fps} fps` : ""}` : EMPTY],
    ["AUDIO", row ? row.acodec || "none" : EMPTY],
    ["TRANSCRIPT", row ? (row.has_transcript ? "AI transcript" : "none yet") : EMPTY],
  ];

  return (
    <div className="panel flex h-full min-h-0 flex-col" style={{ padding: "16px 18px", gap: 12 }}>
      <div className="flex items-center">
        <span className="section-label">MEDIA DETAILS</span>
        <span className="flex-1" />
        <span className="status-muted" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" style={{ paddingRight: 6 }}>
        <div
          className="grid"
          style={{ gridTemplateColumns: "auto 1fr", columnGap: 14, rowGap: 8, alignItems: "start" }}
        >
          {fields.map(([key, value]) => (
            <div key={key} className="contents">
              <span className="detail-key">{key}</span>
              <span className="detail-value" style={{ wordBreak: "break-word" }}>
                {value}
              </span>
            </div>
          ))}
        </div>

        <div className="flex items-start" style={{ gap: 12, marginTop: 10 }}>
          <span className="detail-key">SOURCE</span>
          {row?.source_url ? (
            <a
              className="detail-value"
              href={row.source_url}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--blue)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {row.source_url}
            </a>
          ) : (
            <span className="detail-value">{EMPTY}</span>
          )}
        </div>

        <div className="detail-path" style={{ marginTop: 10 }}>
          {row?.storage_path ?? ""}
        </div>

        <div className="flex" style={{ gap: 8, marginTop: 12 }}>
          <button
            type="button"
            className="btn-path"
            disabled={!row?.storage_path}
            title="Copy the storage path to the clipboard"
            onClick={() => row?.storage_path && void navigator.clipboard.writeText(row.storage_path)}
          >
            COPY PATH
          </button>
          <span className="flex-1" />
        </div>

        {share && (
          <div style={{ marginTop: 16 }}>
            <ShareBar
              key={share.url}
              url={share.url}
              downloadCount={share.downloadCount}
              variant="inline"
            />
          </div>
        )}
      </div>

      <div className="flex flex-col" style={{ gap: 8 }}>
        <span className="section-label">TAGS</span>
        <div className="flex flex-wrap" style={{ gap: 8 }}>
          {(row?.manual_tags ?? []).map((t) => (
            <button key={t} type="button" className="tag-chip-manual" title="Click to remove">
              {t}{"  "}✕
            </button>
          ))}
          {(row?.tags ?? [])
            .filter((t) => !(row?.manual_tags ?? []).includes(t))
            .map((t) => (
              <span key={t} className="tag-chip-auto" title="Derived automatically from the file — updates on rescan.">
                {t}
              </span>
            ))}
        </div>
        <input type="text" className="field" placeholder="Add a tag…" disabled={!row} />
        <span className="hint">
          Your tags survive every rescan{"  ·  "}grey tags are derived from the file and refresh
          themselves
        </span>
      </div>
    </div>
  );
}
