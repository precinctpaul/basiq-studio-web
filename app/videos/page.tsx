"use client";

import Image from "next/image";
import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Splitter } from "@/components/studio/Splitter";
import type { CachedVideoRow, TranscriptInfo } from "@/app/api/videos/cache-list/route";
import type { SidecarFile } from "@/app/api/videos/sidecars/route";

type TitleMode = "title" | "filename";
type TranscriptStatusFilter = "all" | "ready" | "none" | "attention";
type SortKey = "title" | "uploader" | "channel" | "duration" | "size" | "created";
type SortDir = "asc" | "desc";

type ColKey = "issue" | "transcript" | "title" | "uploader" | "channel" | "duration" | "size" | "created";
const COL_ORDER: ColKey[] = ["issue", "transcript", "title", "uploader", "channel", "duration", "size", "created"];
const DEFAULT_WIDTHS: Record<ColKey, number> = {
  issue: 34,
  transcript: 44,
  title: 380,
  uploader: 150,
  channel: 150,
  duration: 90,
  size: 90,
  created: 170,
};
const MIN_COL_WIDTH = 32;
const MAX_COL_WIDTH = 900;
const COL_WIDTHS_KEY = "basiq.videos.colWidths";
const PAGE_SIZE = 200;

const ARROW_UP = String.fromCharCode(0x25b2);
const ARROW_DOWN = String.fromCharCode(0x25bc);
const DASH_EN = String.fromCharCode(0x2013);
const DOT_FILLED = String.fromCharCode(0x25cf);
const ELLIPSIS = String.fromCharCode(0x2026);
const WARNING = String.fromCharCode(0x26a0);
const ARROW_LEFT = String.fromCharCode(0x2190);
const ARROW_SWAP = String.fromCharCode(0x21c4);
const TRIANGLE_DOWN_SMALL = String.fromCharCode(0x25be);
const TRIANGLE_RIGHT_SMALL = String.fromCharCode(0x25b8);
const MIDDLE_DOT = String.fromCharCode(0x00b7);

function formatBytes(n: number): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n;
  let i = -1;
  do {
    value /= 1024;
    i++;
  } while (value >= 1024 && i < units.length - 1);
  return `${value.toFixed(1)} ${units[i]}`;
}

function formatDuration(seconds: number): string {
  if (!seconds) return "";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function toWindowsPath(mediaRoot: string, relPath: string): string {
  const rel = relPath.replace(/\//g, "\\");
  if (!mediaRoot) return rel;
  return mediaRoot.endsWith("\\") ? `${mediaRoot}${rel}` : `${mediaRoot}\\${rel}`;
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

function displayTitleFor(v: CachedVideoRow, titleMode: TitleMode): string {
  return titleMode === "filename" && v.local_path ? basename(v.local_path) : v.title;
}

const SOURCE_LABELS: Record<string, string> = {
  "whisper-local": "Whisper-generated",
  "imported-srt": "Imported .srt",
  "imported-vtt": "Imported .vtt",
  "imported-cspan": "Imported (C-SPAN)",
};

function transcriptTooltip(t: TranscriptInfo | null): string {
  if (!t) return "No transcript yet";
  const sourceLabel = SOURCE_LABELS[t.source] ?? t.source;
  if (t.status === "ready") return `${sourceLabel} ${MIDDLE_DOT} ${t.language || "en"} ${MIDDLE_DOT} ${t.model}`;
  return `Transcript ${t.status} (${sourceLabel})`;
}

/** Blank uploader/channel values always sort last, in EITHER direction --
 *  otherwise ascending order puts a wall of ~3,400 blanks before the first
 *  real name, which is never what "sort by uploader" means to a person. */
function compareBlankLast(a: string, b: string, dir: SortDir): number {
  const aEmpty = !a,
    bEmpty = !b;
  if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
  const cmp = a.localeCompare(b, undefined, { sensitivity: "base" });
  return dir === "asc" ? cmp : -cmp;
}

function compareRows(a: CachedVideoRow, b: CachedVideoRow, key: SortKey, dir: SortDir, titleMode: TitleMode): number {
  let cmp: number;
  switch (key) {
    case "title":
      cmp = displayTitleFor(a, titleMode).localeCompare(displayTitleFor(b, titleMode), undefined, { sensitivity: "base" });
      break;
    case "uploader":
      return compareBlankLast(a.uploader || "", b.uploader || "", dir);
    case "channel":
      return compareBlankLast(a.channel || "", b.channel || "", dir);
    case "duration":
      cmp = a.duration_seconds - b.duration_seconds;
      break;
    case "size":
      cmp = a.size_bytes - b.size_bytes;
      break;
    default:
      cmp = a.created_at.localeCompare(b.created_at);
  }
  return dir === "asc" ? cmp : -cmp;
}

function csvValue(v: string | number | null | undefined): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_HEADERS = [
  "Title",
  "Filename",
  "Uploader",
  "Channel",
  "Duration (s)",
  "Size (bytes)",
  "Video Status",
  "Video Error",
  "Transcript Status",
  "Transcript Source",
  "Local Path",
  "Created At",
];

function exportCsv(rows: CachedVideoRow[]) {
  const lines = [CSV_HEADERS.map(csvValue).join(",")];
  for (const v of rows) {
    lines.push(
      [
        v.title,
        v.local_path ? basename(v.local_path) : "",
        v.uploader,
        v.channel,
        v.duration_seconds,
        v.size_bytes,
        v.status,
        v.error,
        v.transcript?.status ?? "none",
        v.transcript?.source ?? "",
        v.local_path ?? "",
        v.created_at,
      ]
        .map(csvValue)
        .join(","),
    );
  }
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `basiq-video-archive-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function CopyPathButton({ path }: { path: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      className="btn-path"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(path).then(
          () => setState("copied"),
          () => setState("failed"),
        ).finally(() => {
          setTimeout(() => setState("idle"), 1200);
        });
      }}
      title={path}
    >
      {state === "copied" ? "Copied!" : state === "failed" ? "Copy failed" : "Copy Path"}
    </button>
  );
}

/** Resize grip anchored to a <th>'s trailing edge. Reuses the same Splitter
 *  the studio's own pane layout drags, just vertical + column-scoped here.
 *  Double-click resets this one column back to its default width -- the
 *  Splitter's own default tooltip already advertises that gesture. */
function ColumnResizer({ onDrag, onReset }: { onDrag: (deltaPx: number) => void; onReset: () => void }) {
  return (
    <div
      style={{ position: "absolute", top: 0, right: -4, bottom: 0, width: 8, display: "flex" }}
      onClick={(e) => e.stopPropagation()}
    >
      <Splitter orientation="vertical" onDrag={onDrag} onDoubleClick={onReset} />
    </div>
  );
}

function Th({
  width,
  onResize,
  onResetWidth,
  children,
}: {
  width: number;
  onResize: (deltaPx: number) => void;
  onResetWidth: () => void;
  children: React.ReactNode;
}) {
  return (
    <th className="queue-header" style={{ position: "relative", width, minWidth: width }}>
      {children}
      <ColumnResizer onDrag={onResize} onReset={onResetWidth} />
    </th>
  );
}

/** A header label that doubles as a sort control -- click toggles asc/desc on
 *  this column, or switches to it (with a sensible default direction) if
 *  another column was active. Matches how a spreadsheet or Explorer sorts. */
function SortableHeader({
  label,
  colKey,
  sortKey,
  sortDir,
  onSort,
}: {
  label: string;
  colKey: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  const active = sortKey === colKey;
  return (
    <button
      type="button"
      className="btn-ghost"
      style={{ padding: "2px 6px", width: "100%", textAlign: "left" }}
      onClick={() => onSort(colKey)}
      title={`Sort by ${label}`}
    >
      {label} {active ? (sortDir === "asc" ? ARROW_UP : ARROW_DOWN) : ""}
    </button>
  );
}

function TranscriptIcon({ transcript }: { transcript: TranscriptInfo | null }) {
  if (!transcript) {
    return (
      <span className="transcript-icon-no" title="No transcript yet" aria-label="No transcript yet">
        {DASH_EN}
      </span>
    );
  }
  const tooltip = transcriptTooltip(transcript);
  if (transcript.status === "ready") {
    return (
      <span className="transcript-icon-yes" title={tooltip} aria-label={tooltip}>
        {DOT_FILLED}
      </span>
    );
  }
  return (
    <span className="transcript-icon-partial" title={tooltip} aria-label={tooltip}>
      {ELLIPSIS}
    </span>
  );
}

function IssueIcon({ video }: { video: CachedVideoRow }) {
  const hasIssue = video.status === "failed" || Boolean(video.error);
  if (!hasIssue) return null;
  const detail = video.error || `status: ${video.status}`;
  return (
    <span className="issue-icon" title={detail} aria-label={`Issue: ${detail}`}>
      {WARNING}
    </span>
  );
}

function SidecarRow({ video, mediaRoot, colSpan }: { video: CachedVideoRow; mediaRoot: string; colSpan: number }) {
  const [files, setFiles] = useState<SidecarFile[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!video.local_path) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    fetch(`/api/videos/sidecars?path=${encodeURIComponent(video.local_path)}`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (data.error) setError(data.error);
        else setFiles(data.files ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("failed to reach the server");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [video.local_path]);

  const videoFullPath = video.local_path
    ? toWindowsPath(mediaRoot, video.local_path)
    : video.storage_path
    ? `(Supabase storage) ${video.storage_path}`
    : "(no file on disk)";

  return (
    <tr>
      <td colSpan={colSpan} style={{ padding: "12px 16px", background: "var(--bg-field)" }}>
        <div className="flex items-center gap-2" style={{ marginBottom: 10 }}>
          <span className="detail-path" style={{ flex: 1 }}>
            {videoFullPath}
          </span>
          {video.local_path && <CopyPathButton path={videoFullPath} />}
        </div>

        {video.transcript && (
          <div className="status-muted" style={{ marginBottom: 10 }}>
            Transcript: {transcriptTooltip(video.transcript)}
          </div>
        )}

        {!video.local_path ? (
          <div className="status-muted">No sidecar files -- master isn&apos;t on the shared drive.</div>
        ) : loading ? (
          <div className="status-muted">Reading folder{ELLIPSIS}</div>
        ) : error ? (
          <div className="status-muted" style={{ color: "var(--red)" }}>
            {error}
          </div>
        ) : files && files.length > 0 ? (
          <div className="flex flex-col" style={{ gap: 6 }}>
            {files.map((f) => (
              <div key={f.path} className="flex items-center gap-2">
                <span className="detail-path" style={{ flex: 1 }}>
                  {f.name}
                </span>
                <span className="status-muted" style={{ minWidth: 70, textAlign: "right" }}>
                  {formatBytes(f.size_bytes)}
                </span>
                <CopyPathButton path={f.full_path} />
              </div>
            ))}
          </div>
        ) : (
          <div className="status-muted">No sidecar files found next to this video.</div>
        )}
      </td>
    </tr>
  );
}

export default function VideosPage() {
  const [videos, setVideos] = useState<CachedVideoRow[]>([]);
  const [mediaRoot, setMediaRoot] = useState("");
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");

  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("created");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [titleMode, setTitleMode] = useState<TitleMode>("title");
  const [transcriptStatusFilter, setTranscriptStatusFilter] = useState<TranscriptStatusFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [colWidths, setColWidths] = useState<Record<ColKey, number>>(DEFAULT_WIDTHS);
  // Guards the very first "save" effect run below: on mount, the "load from
  // storage" effect and this "save" effect both fire in the same pass, in
  // declaration order -- so without this guard, save fires FIRST (with
  // colWidths still at its default initial value) and clobbers whatever a
  // previous session had saved, a heartbeat before load's own setState
  // applies. Skipping exactly one save (the mount-time one) breaks that race
  // without needing to read localStorage in the initializer, which would
  // mismatch the server-rendered HTML and trip a hydration warning.
  const skippedFirstSave = useRef(false);

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COL_WIDTHS_KEY) || "null");
      if (saved) setColWidths((w) => ({ ...w, ...saved }));
    } catch {}
  }, []);

  useEffect(() => {
    if (!skippedFirstSave.current) {
      skippedFirstSave.current = true;
      return;
    }
    try {
      localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(colWidths));
    } catch {}
  }, [colWidths]);

  const resizeCol = useCallback(
    (key: ColKey) => (deltaPx: number) => {
      setColWidths((w) => ({ ...w, [key]: Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, w[key] + deltaPx)) }));
    },
    [],
  );

  const resetColWidth = useCallback(
    (key: ColKey) => () => {
      setColWidths((w) => ({ ...w, [key]: DEFAULT_WIDTHS[key] }));
    },
    [],
  );

  const onSort = useCallback((key: SortKey) => {
    setSortKey((prevKey) => {
      if (prevKey === key) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortDir(key === "title" || key === "uploader" || key === "channel" ? "asc" : "desc");
      }
      return key;
    });
  }, []);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const load = useCallback((refresh: boolean) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setLoadError("");
    fetch(`/api/videos/cache-list${refresh ? "?refresh=1" : ""}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          setLoadError(data.error);
          return;
        }
        setVideos(data.videos ?? []);
        setCachedAt(data.cachedAt ?? null);
        setMediaRoot(data.mediaRoot ?? "");
        if (data.refreshError) setLoadError(`Refresh failed, showing last good list: ${data.refreshError}`);
      })
      .catch(() => setLoadError("failed to reach the server"))
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
      });
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  const archiveStats = useMemo(() => {
    let ready = 0,
      none = 0,
      attention = 0,
      hours = 0,
      bytes = 0,
      noUploader = 0,
      noChannel = 0;
    // Counted by source regardless of transcript status -- "source" is which
    // pipeline was used/attempted, not whether it finished, so a pending or
    // failed row still belongs in its source's bucket. Counting ready-only
    // here previously meant a source with no ready rows couldn't even be
    // selected in the filter dropdown below.
    const bySource: Record<string, number> = {};
    for (const v of videos) {
      hours += (v.duration_seconds || 0) / 3600;
      bytes += v.size_bytes || 0;
      if (!v.uploader) noUploader++;
      if (!v.channel) noChannel++;
      if (!v.transcript) {
        none++;
        continue;
      }
      if (v.transcript.status === "ready") ready++;
      else attention++;
      bySource[v.transcript.source] = (bySource[v.transcript.source] || 0) + 1;
    }
    return { ready, none, attention, hours, bytes, bySource, noUploader, noChannel };
  }, [videos]);

  const availableSources = useMemo(() => Object.keys(archiveStats.bySource).sort(), [archiveStats]);

  // Named so a zero-result table says WHY, instead of only ever blaming the
  // search box even when a filter combination (e.g. NEEDS ATTENTION + a
  // source with no non-ready rows) is what actually produced no matches.
  const activeFilterParts = useMemo(() => {
    const parts: string[] = [];
    if (search.trim()) parts.push(`search "${search.trim()}"`);
    if (transcriptStatusFilter !== "all") {
      parts.push(
        transcriptStatusFilter === "ready"
          ? "transcript: READY"
          : transcriptStatusFilter === "none"
          ? "transcript: NONE"
          : "transcript: NEEDS ATTENTION",
      );
    }
    if (sourceFilter !== "all") parts.push(`source: ${SOURCE_LABELS[sourceFilter] ?? sourceFilter}`);
    return parts;
  }, [search, transcriptStatusFilter, sourceFilter]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    let out = videos;
    if (term) {
      out = out.filter(
        (v) =>
          v.title.toLowerCase().includes(term) ||
          (v.uploader || "").toLowerCase().includes(term) ||
          (v.channel || "").toLowerCase().includes(term) ||
          (v.local_path || "").toLowerCase().includes(term),
      );
    }
    if (transcriptStatusFilter === "ready") out = out.filter((v) => v.transcript?.status === "ready");
    else if (transcriptStatusFilter === "none") out = out.filter((v) => !v.transcript);
    else if (transcriptStatusFilter === "attention") out = out.filter((v) => v.transcript && v.transcript.status !== "ready");
    if (sourceFilter !== "all") out = out.filter((v) => v.transcript?.source === sourceFilter);
    return [...out].sort((a, b) => compareRows(a, b, sortKey, sortDir, titleMode));
  }, [videos, search, sortKey, sortDir, titleMode, transcriptStatusFilter, sourceFilter]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [search, sortKey, sortDir, transcriptStatusFilter, sourceFilter]);

  const visible = filtered.slice(0, visibleCount);
  const colSpanAll = COL_ORDER.length;

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 800;
    if (nearBottom && visibleCount < filtered.length) {
      setVisibleCount((n) => Math.min(filtered.length, n + PAGE_SIZE));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="header-bar flex items-center" style={{ padding: "14px 22px", gap: 14 }}>
        <Image
          src="/brand/wordmark.png"
          alt="Majority Democrats"
          height={46}
          width={150}
          priority
          style={{ height: 46, width: "auto" }}
        />
        <span className="section-label whitespace-nowrap">BASIQ STUDIO HUB</span>
        <span style={{ width: 4 }} />
        <span className="section-label whitespace-nowrap" style={{ color: "var(--acid)" }}>
          VIDEO REPOSITORY
        </span>
        <span className="flex-1" />
        <Link href="/" className="btn">
          {ARROW_LEFT} BACK TO STUDIO
        </Link>
      </header>

      <div className="flex items-center gap-2" style={{ padding: "14px 22px 8px", flexWrap: "wrap" }}>
        <input
          type="text"
          className="field"
          style={{ flex: 1, maxWidth: 420 }}
          placeholder="Search title, uploader, channel, or path..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="flex gap-1">
          <button
            type="button"
            className="btn-ghost"
            data-checked={transcriptStatusFilter === "all" ? "true" : undefined}
            onClick={() => setTranscriptStatusFilter("all")}
            title="Show every video"
          >
            ALL
          </button>
          <button
            type="button"
            className="btn-ghost"
            data-checked={transcriptStatusFilter === "ready" ? "true" : undefined}
            onClick={() => setTranscriptStatusFilter("ready")}
            title="Show only videos with a ready transcript"
          >
            READY ({archiveStats.ready.toLocaleString()})
          </button>
          <button
            type="button"
            className="btn-ghost"
            data-checked={transcriptStatusFilter === "none" ? "true" : undefined}
            onClick={() => setTranscriptStatusFilter("none")}
            title="Show only videos with no transcript attempted at all"
          >
            NONE ({archiveStats.none.toLocaleString()})
          </button>
          {archiveStats.attention > 0 && (
            <button
              type="button"
              className="btn-ghost"
              data-checked={transcriptStatusFilter === "attention" ? "true" : undefined}
              onClick={() => setTranscriptStatusFilter("attention")}
              title="Show videos whose transcript is pending, running, or failed"
            >
              NEEDS ATTENTION ({archiveStats.attention.toLocaleString()})
            </button>
          )}
        </div>

        <select className="select" value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} title="Filter by transcript source">
          <option value="all">All transcript sources</option>
          {availableSources.map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABELS[s] ?? s} ({archiveStats.bySource[s].toLocaleString()})
            </option>
          ))}
        </select>

        <span className="flex-1" />
        <span className="status-muted">
          {loading
            ? "Loading..."
            : `${filtered.length.toLocaleString()} of ${videos.length.toLocaleString()} videos`}
        </span>
        <span className="status-muted">{cachedAt ? `Cache refreshed ${formatWhen(cachedAt)}` : ""}</span>
        <button type="button" className="btn-ghost" onClick={() => exportCsv(filtered)} title="Download the currently filtered rows as CSV">
          EXPORT CSV
        </button>
        <button type="button" className="btn" onClick={() => load(true)} disabled={refreshing}>
          {refreshing ? "REFRESHING..." : "REFRESH CACHE NOW"}
        </button>
      </div>

      <div className="flex items-center gap-2 status-muted" style={{ padding: "0 22px 14px", flexWrap: "wrap" }}>
        <span>{videos.length.toLocaleString()} videos</span>
        <span>{MIDDLE_DOT}</span>
        <span>{Math.round(archiveStats.hours).toLocaleString()} hrs</span>
        <span>{MIDDLE_DOT}</span>
        <span>{formatBytes(archiveStats.bytes)}</span>
        <span>{MIDDLE_DOT}</span>
        <span title="Videos with an empty uploader field">{archiveStats.noUploader.toLocaleString()} missing uploader</span>
        <span>{MIDDLE_DOT}</span>
        <span title="Videos with an empty channel field">{archiveStats.noChannel.toLocaleString()} missing channel</span>
        <span style={{ width: 8 }} />
        {Object.entries(archiveStats.bySource)
          .sort((a, b) => b[1] - a[1])
          .map(([src, count]) => (
            <button
              key={src}
              type="button"
              className="tag-chip-auto"
              style={{ cursor: "pointer" }}
              data-checked={sourceFilter === src ? "true" : undefined}
              onClick={() => setSourceFilter((s) => (s === src ? "all" : src))}
              title={`Filter to ${SOURCE_LABELS[src] ?? src}`}
            >
              {SOURCE_LABELS[src] ?? src}: {count.toLocaleString()}
            </button>
          ))}
      </div>

      {loadError && (
        <div
          style={{
            margin: "0 22px 12px",
            padding: "10px 14px",
            background: "rgba(255, 68, 68, 0.1)",
            color: "var(--red)",
            border: "1px solid rgba(255, 68, 68, 0.2)",
          }}
        >
          {loadError}
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="list-surface min-h-0 flex-1 overflow-auto"
        style={{ margin: "0 22px 22px" }}
      >
        <table style={{ width: "100%", tableLayout: "fixed", borderCollapse: "collapse" }}>
          <colgroup>
            {COL_ORDER.map((key) => (
              <col key={key} style={{ width: colWidths[key] }} />
            ))}
          </colgroup>
          <thead style={{ position: "sticky", top: 0, zIndex: 1 }}>
            <tr>
              <Th width={colWidths.issue} onResize={resizeCol("issue")} onResetWidth={resetColWidth("issue")}>
                {" "}
              </Th>
              <Th width={colWidths.transcript} onResize={resizeCol("transcript")} onResetWidth={resetColWidth("transcript")}>
                CC
              </Th>
              <Th width={colWidths.title} onResize={resizeCol("title")} onResetWidth={resetColWidth("title")}>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    className="btn-ghost"
                    style={{ padding: "2px 6px" }}
                    onClick={() => setTitleMode((m) => (m === "title" ? "filename" : "title"))}
                    title="Switch between the human title and the on-disk filename"
                  >
                    {titleMode === "title" ? "TITLE" : "FILENAME"} {ARROW_SWAP}
                  </button>
                  <SortableHeader
                    label={titleMode === "title" ? "Title" : "Filename"}
                    colKey="title"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSort={onSort}
                  />
                </div>
              </Th>
              <Th width={colWidths.uploader} onResize={resizeCol("uploader")} onResetWidth={resetColWidth("uploader")}>
                <SortableHeader label="Uploader" colKey="uploader" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              </Th>
              <Th width={colWidths.channel} onResize={resizeCol("channel")} onResetWidth={resetColWidth("channel")}>
                <SortableHeader label="Channel" colKey="channel" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              </Th>
              <Th width={colWidths.duration} onResize={resizeCol("duration")} onResetWidth={resetColWidth("duration")}>
                <SortableHeader label="Duration" colKey="duration" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              </Th>
              <Th width={colWidths.size} onResize={resizeCol("size")} onResetWidth={resetColWidth("size")}>
                <SortableHeader label="Size" colKey="size" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              </Th>
              <Th width={colWidths.created} onResize={resizeCol("created")} onResetWidth={resetColWidth("created")}>
                <SortableHeader label="Added" colKey="created" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              </Th>
            </tr>
          </thead>
          <tbody>
            {visible.map((v) => {
              const displayTitle = displayTitleFor(v, titleMode);
              const expanded = expandedIds.has(v.id);
              return (
                <Fragment key={v.id}>
                  <tr
                    className="queue-row"
                    style={{ cursor: "pointer" }}
                    tabIndex={0}
                    role="button"
                    aria-expanded={expanded}
                    onClick={() => toggleExpanded(v.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleExpanded(v.id);
                      }
                    }}
                  >
                    <td className="queue-cell icon-cell">
                      <IssueIcon video={v} />
                    </td>
                    <td className="queue-cell icon-cell">
                      <TranscriptIcon transcript={v.transcript} />
                    </td>
                    <td
                      className="queue-cell"
                      title={displayTitle}
                      style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      {expanded ? `${TRIANGLE_DOWN_SMALL} ` : `${TRIANGLE_RIGHT_SMALL} `}
                      {displayTitle}
                    </td>
                    <td className="queue-cell status-muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {v.uploader}
                    </td>
                    <td className="queue-cell status-muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {v.channel}
                    </td>
                    <td
                      className="queue-cell"
                      style={{ fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      {formatDuration(v.duration_seconds)}
                    </td>
                    <td className="queue-cell status-muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {formatBytes(v.size_bytes)}
                    </td>
                    <td className="queue-cell status-muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {formatWhen(v.created_at)}
                    </td>
                  </tr>
                  {expanded && <SidecarRow video={v} mediaRoot={mediaRoot} colSpan={colSpanAll} />}
                </Fragment>
              );
            })}
            {!loading && visible.length === 0 && (
              <tr>
                <td colSpan={colSpanAll} className="status-muted text-center" style={{ padding: 20 }}>
                  {activeFilterParts.length > 0
                    ? `No videos match ${activeFilterParts.join(" + ")}.`
                    : "No videos in the archive."}
                </td>
              </tr>
            )}
            {visibleCount < filtered.length && (
              <tr>
                <td colSpan={colSpanAll} className="status-muted text-center" style={{ padding: 12 }}>
                  Loading more...
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
