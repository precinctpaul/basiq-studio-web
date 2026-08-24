"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatShort } from "@/lib/timecode";
import { GROUP_LABELS } from "@/components/studio/DetailsPanel";

const SORT_MODES = ["Date: Newest", "Date: Oldest", "Name: A-Z", "Name: Z-A"] as const;
const ALL_TAGS = "All Tags";

/** Sections appear in this order when present; anything not listed (e.g. a
 *  bucket added later that isn't here yet) falls in after these, alphabetized. */
const BUCKET_ORDER = ["Majority Democrats", "The Bench", "House", "Senate", "Opponents", "Cabinet", "Court"];

export interface LibraryRow {
  id: string;
  kind: "video" | "clip";
  title: string;
  duration_seconds: number;
  uploader?: string | null;
  channel?: string | null;
  is_clip?: boolean;
  status: string;
  created_at: string;
  tags?: Array<{ label: string; source: string; kind?: string | null }>;
  share_token?: string | null;
  probed?: boolean;
}

interface BucketPerson {
  name: string;
  count: number;
}

interface BucketSummary {
  label: string;
  count: number;
  people: BucketPerson[];
}

interface BucketsResponse {
  buckets: BucketSummary[];
  uncategorizedCount: number;
  totalVideos: number;
}

type ExplorerView =
  | { level: "folders" }
  | { level: "bucket"; bucket: string }
  | { level: "person"; bucket: string; person: string }
  | { level: "uncategorized" };

interface Props {
  rows: LibraryRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onActivate: (id: string) => void;
  onRescan: () => void;
  onAgentCheck: () => void;
  mediaRoot: string;
  onLoadMore?: () => void;
  hasMore?: boolean;
  onSearch?: (term: string) => void;
  agentError?: string | null;
}

function labelFor(row: LibraryRow, index: number): string {
  const prefix = row.is_clip ? "✂  " : "";
  const source = row.uploader || row.channel || "";
  const title =
    source && !row.title.toLowerCase().includes(source.toLowerCase())
      ? `${source} — ${row.title}`
      : row.title;
  return `${index}.  ${prefix}${title}`;
}

export function LibraryPanel({
  rows,
  selectedId,
  onSelect,
  onActivate,
  onRescan,
  onAgentCheck,
  mediaRoot,
  onLoadMore,
  hasMore,
  onSearch,
  agentError,
}: Props) {
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState(ALL_TAGS);
  const [sortMode, setSortMode] = useState<string>(SORT_MODES[0]);

  // --- Folder-explorer state -------------------------------------------
  // Bucket/person counts come from a dedicated lightweight endpoint that
  // reads straight from the tags table, so they're accurate the instant the
  // page opens — they never depend on how much of the library has streamed
  // into `rows` yet.
  const [summary, setSummary] = useState<BucketsResponse | null>(null);
  const [view, setView] = useState<ExplorerView>({ level: "folders" });
  const [detailRows, setDetailRows] = useState<LibraryRow[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailPage, setDetailPage] = useState(0);
  const [detailHasMore, setDetailHasMore] = useState(false);
  const [folderFilter, setFolderFilter] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/library/buckets")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && !data.error) setSummary(data);
      })
      .catch(() => {
        /* falls back to the classic flat list below */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchDetailPage = useCallback(
    async (pageNum: number, opts: { bucket?: string; person?: string }) => {
      const params = new URLSearchParams({ page: String(pageNum), limit: "250" });
      if (opts.bucket) params.set("bucket", opts.bucket);
      if (opts.person) params.set("person", opts.person);
      const res = await fetch(`/api/library?${params.toString()}`);
      return res.json();
    },
    []
  );

  useEffect(() => {
    if (view.level === "person") {
      setDetailLoading(true);
      setDetailRows([]);
      fetchDetailPage(0, { person: view.person })
        .then((data) => setDetailRows(data.rows ?? []))
        .finally(() => setDetailLoading(false));
    } else if (view.level === "uncategorized") {
      setDetailPage(0);
      setDetailRows([]);
      setDetailLoading(true);
      fetchDetailPage(0, { bucket: "Uncategorized" })
        .then((data) => {
          setDetailRows(data.rows ?? []);
          setDetailHasMore(Boolean(data.pagination?.hasMore));
        })
        .finally(() => setDetailLoading(false));
    } else {
      setFolderFilter("");
    }
  }, [view, fetchDetailPage]);

  const loadMoreUncategorized = useCallback(() => {
    if (detailLoading || !detailHasMore) return;
    const next = detailPage + 1;
    setDetailLoading(true);
    fetchDetailPage(next, { bucket: "Uncategorized" })
      .then((data) => {
        setDetailPage(next);
        setDetailRows((prev) => [...prev, ...(data.rows ?? [])]);
        setDetailHasMore(Boolean(data.pagination?.hasMore));
      })
      .finally(() => setDetailLoading(false));
  }, [detailLoading, detailHasMore, detailPage, fetchDetailPage]);

  const handleDetailScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (view.level !== "uncategorized") return;
    const { scrollTop, clientHeight, scrollHeight } = e.currentTarget;
    if (scrollHeight - scrollTop - clientHeight < 1200) loadMoreUncategorized();
  };

  // --- Classic flat-list state (fallback until buckets exist) ----------

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setSearch(val);
    onSearch?.(val);
  };

  const tagGroups = useMemo(() => {
    const counts = new Map<string, { n: number; group: string }>();
    for (const r of rows) {
      for (const t of r.tags ?? []) {
        const group = t.source === "manual" ? "mine" : (t.kind ?? "topics");
        const prev = counts.get(t.label);
        counts.set(t.label, { n: (prev?.n ?? 0) + 1, group: prev?.group ?? group });
      }
    }
    const buckets = new Map<string, string[]>();
    for (const [label, { n, group }] of [...counts.entries()].sort(
      (a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]),
    )) {
      void n;
      buckets.set(group, [...(buckets.get(group) ?? []), label]);
    }
    const order = Object.keys(GROUP_LABELS);
    return [...buckets.entries()].sort(([a], [b]) => {
      const ai = order.indexOf(a);
      const bi = order.indexOf(b);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.localeCompare(b);
    });
  }, [rows]);

  const matchedTags = useMemo(() => {
    const term = search.trim().toLowerCase();
    const map = new Map<string, string[]>();
    if (term.length < 2) return map;
    for (const r of rows) {
      const hits = (r.tags ?? [])
        .filter((t) => t.label.toLowerCase().includes(term))
        .map((t) => t.label);
      if (hits.length) map.set(r.id, hits);
    }
    return map;
  }, [rows, search]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    let out = rows.filter((r) => {
      if (tag !== ALL_TAGS && !(r.tags ?? []).some((t) => t.label === tag)) return false;
      return true;
    });
    out = [...out];
    switch (sortMode) {
      case "Date: Oldest":
        out.sort((a, b) => a.created_at.localeCompare(b.created_at));
        break;
      case "Name: A-Z":
        out.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
        break;
      case "Name: Z-A":
        out.sort((a, b) => b.title.localeCompare(a.title, undefined, { sensitivity: "base" }));
        break;
      default:
        out.sort((a, b) => b.created_at.localeCompare(a.created_at));
    }
    return out;
  }, [rows, tag, sortMode]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, clientHeight, scrollHeight } = e.currentTarget;
    if (scrollHeight - scrollTop - clientHeight < 1200) {
      if (onLoadMore && hasMore) {
        onLoadMore();
      }
    }
  };

  const renderRow = (row: LibraryRow, idx: number) => {
    const hits = matchedTags.get(row.id);
    return (
      <div
        key={row.id}
        className="playlist-row"
        data-selected={row.id === selectedId ? "true" : undefined}
        data-tagged={hits ? "true" : undefined}
        onClick={() => onSelect(row.id)}
        onDoubleClick={() => onActivate(row.id)}
        title={row.title}
      >
        <div className="playlist-row-title">
          <span>{labelFor(row, idx)}</span>
          {hits && <span className="playlist-row-tags">{hits.join(" · ")}</span>}
        </div>
        <span className="playlist-row-duration">
          {row.probed === false ? (
            <span className="status-muted animate-pulse">Scanning...</span>
          ) : row.duration_seconds ? (
            formatShort(row.duration_seconds)
          ) : (
            ""
          )}
        </span>
      </div>
    );
  };

  const renderFolderRow = (key: string, label: string, count: number, onOpen: () => void) => (
    <div
      key={key}
      className="playlist-row"
      onDoubleClick={onOpen}
      title={`Double-click to open ${label}`}
      style={{ cursor: "default" }}
    >
      <span className="playlist-row-title">
        <span>{label}</span>
      </span>
      <span className="playlist-row-duration">{count}</span>
    </div>
  );

  const explorerReady = Boolean(summary && summary.buckets.length > 0);
  const filterTerm = folderFilter.trim().toLowerCase();

  const renderExplorer = () => {
    if (!summary) return null;

    if (view.level === "folders") {
      const orderedBuckets = [...summary.buckets].sort((a, b) => {
        const ai = BUCKET_ORDER.indexOf(a.label);
        const bi = BUCKET_ORDER.indexOf(b.label);
        return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.label.localeCompare(b.label);
      });
      const visible = orderedBuckets.filter((b) => !filterTerm || b.label.toLowerCase().includes(filterTerm));
      const showUncategorized = !filterTerm || "uncategorized".includes(filterTerm);
      return (
        <>
          {visible.map((b) =>
            renderFolderRow(b.label, b.label, b.count, () => setView({ level: "bucket", bucket: b.label }))
          )}
          {showUncategorized &&
            renderFolderRow("Uncategorized", "Uncategorized", summary.uncategorizedCount, () =>
              setView({ level: "uncategorized" })
            )}
        </>
      );
    }

    if (view.level === "bucket") {
      const b = summary.buckets.find((x) => x.label === view.bucket);
      const people = (b?.people ?? []).filter(
        (p) => !filterTerm || p.name.toLowerCase().includes(filterTerm)
      );
      return (
        <>
          <div className="playlist-row" style={{ cursor: "pointer", fontWeight: 600 }} onClick={() => setView({ level: "folders" })}>
            <span>◂ &nbsp;All buckets</span>
          </div>
          {people.map((p) =>
            renderFolderRow(p.name, p.name, p.count, () =>
              setView({ level: "person", bucket: view.bucket, person: p.name })
            )
          )}
        </>
      );
    }

    if (view.level === "person") {
      const visibleRows = filterTerm
        ? detailRows.filter((r) => r.title.toLowerCase().includes(filterTerm))
        : detailRows;
      return (
        <>
          <div className="playlist-row" style={{ cursor: "pointer", fontWeight: 600 }} onClick={() => setView({ level: "bucket", bucket: view.bucket })}>
            <span>◂ &nbsp;{view.bucket}</span>
          </div>
          {detailLoading && detailRows.length === 0 ? (
            <div className="status-muted text-center" style={{ padding: 12 }}>
              Loading videos for {view.person}…
            </div>
          ) : (
            visibleRows.map((row, i) => renderRow(row, i + 1))
          )}
        </>
      );
    }

    // uncategorized
    const visibleRows = filterTerm
      ? detailRows.filter((r) => r.title.toLowerCase().includes(filterTerm))
      : detailRows;
    return (
      <>
        <div className="playlist-row" style={{ cursor: "pointer", fontWeight: 600 }} onClick={() => setView({ level: "folders" })}>
          <span>◂ &nbsp;All buckets</span>
        </div>
        {visibleRows.map((row, i) => renderRow(row, i + 1))}
        {detailLoading && (
          <div className="status-muted text-center" style={{ padding: 12 }}>
            Loading more videos…
          </div>
        )}
      </>
    );
  };

  const headerCount = !explorerReady
    ? filtered.length
    : view.level === "folders"
    ? summary!.totalVideos
    : view.level === "bucket"
    ? summary!.buckets.find((x) => x.label === view.bucket)?.count ?? 0
    : view.level === "uncategorized"
    ? summary!.uncategorizedCount
    : detailRows.length;

  return (
    <div className="sidebar flex h-full min-h-0 flex-col" style={{ padding: "16px 18px", gap: 10 }}>
      <div className="flex items-center">
        <span className="section-label">LOCAL LIBRARY</span>
        <span className="flex-1" />
        <span className="status-muted">{headerCount}</span>
      </div>

      {agentError === "Shared drive not mounted" && (
        <div style={{ padding: "12px", background: "rgba(255, 68, 68, 0.1)", color: "#ff4444", borderRadius: "6px", border: "1px solid rgba(255, 68, 68, 0.2)", fontSize: "0.85rem" }}>
          ⚠️ <strong>Drive Disconnected</strong><br/>
          Please mount your LucidLink drive at <code style={{ color: "inherit", opacity: 0.8 }}>{mediaRoot}</code> to access the library.
        </div>
      )}

      <input
        type="text"
        className="field"
        placeholder={explorerReady ? "Filter this folder…" : "Search library…"}
        value={explorerReady ? folderFilter : search}
        onChange={explorerReady ? (e) => setFolderFilter(e.target.value) : handleSearchChange}
      />

      {!explorerReady && (
        <>
          <select
            className="select"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            title="Filter by metadata tag — type to search a long list"
          >
            <option value={ALL_TAGS}>{ALL_TAGS}</option>
            {tagGroups.map(([group, labels]) => (
              <optgroup key={group} label={GROUP_LABELS[group] ?? group.toUpperCase()}>
                {labels.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>

          <select className="select" value={sortMode} onChange={(e) => setSortMode(e.target.value)}>
            {SORT_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </>
      )}

      <div
        className="list-surface min-h-0 flex-1 overflow-y-auto"
        onScroll={explorerReady ? handleDetailScroll : handleScroll}
      >
        {explorerReady
          ? renderExplorer()
          : filtered.map((row, i) => renderRow(row, i + 1))}

        {!explorerReady && onLoadMore && hasMore && (
          <div className="status-muted text-center" style={{ padding: 12 }}>
            Loading more videos…
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          className="btn flex-1"
          onClick={onRescan}
          title="Re-read the library  (F5)"
        >
          RESCAN
        </button>
        <button
          type="button"
          className="btn flex-1"
          onClick={onAgentCheck}
          title="Check the local agent connection"
        >
          CHECK AGENT
        </button>
      </div>

      <div className="status-muted" style={{ wordBreak: "break-all" }}>
        {mediaRoot}
      </div>
    </div>
  );
}
