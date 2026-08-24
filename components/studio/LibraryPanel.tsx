"use client";

import { useMemo, useState } from "react";
import { formatShort } from "@/lib/timecode";
import { GROUP_LABELS } from "@/components/studio/DetailsPanel";

const SORT_MODES = ["Date: Newest", "Date: Oldest", "Name: A-Z", "Name: Z-A"] as const;
const ALL_TAGS = "All Tags";

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
}: Props) {
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState(ALL_TAGS);
  const [sortMode, setSortMode] = useState<string>(SORT_MODES[0]);

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
      if (!term) return true;
      return (
        r.title.toLowerCase().includes(term) ||
        (r.uploader ?? "").toLowerCase().includes(term) ||
        (r.channel ?? "").toLowerCase().includes(term) ||
        (r.tags ?? []).some((t) => t.label.toLowerCase().includes(term))
      );
    });
    out = [...out];
    switch (sortMode) {
      case "Date: Oldest":
        out.sort((a, b) => a.created_at.localeCompare(b.created_at));
        break;
      case "Name: A-Z":
        out.sort((a, b) => a.title.localeCompare(a.title, undefined, { sensitivity: "base" }));
        break;
      case "Name: Z-A":
        out.sort((a, b) => b.title.localeCompare(a.title, undefined, { sensitivity: "base" }));
        break;
      default:
        out.sort((a, b) => b.created_at.localeCompare(a.created_at));
    }
    return out;
  }, [rows, search, tag, sortMode]);

  // Triggers when you scroll within 200px of the bottom
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, clientHeight, scrollHeight } = e.currentTarget;
    if (scrollHeight - scrollTop - clientHeight < 200) {
      if (onLoadMore && hasMore) {
        onLoadMore();
      }
    }
  };

  return (
    <div className="sidebar flex h-full min-h-0 flex-col" style={{ padding: "16px 18px", gap: 10 }}>
      <div className="flex items-center">
        <span className="section-label">LOCAL LIBRARY</span>
        <span className="flex-1" />
        <span className="status-muted">{filtered.length}</span>
      </div>

      <input
        type="text"
        className="field"
        placeholder="Search library…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

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

      <div className="list-surface min-h-0 flex-1 overflow-y-auto" onScroll={handleScroll}>
        {filtered.map((row, i) => {
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
                <span>{labelFor(row, i + 1)}</span>
                {hits && (
                  <span className="playlist-row-tags">{hits.join(" · ")}</span>
                )}
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
        })}

        {onLoadMore && hasMore && (
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