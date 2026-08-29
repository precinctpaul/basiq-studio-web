"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatShort } from "@/lib/timecode";
import { GROUP_LABELS } from "@/components/studio/DetailsPanel";

const SORT_MODES = ["Date: Newest", "Date: Oldest", "Name: A-Z", "Name: Z-A"] as const;
const ALL_TAGS = "All Tags";

/** Sections appear in this order when present; anything not listed (e.g. a
 *  bucket added later that isn't here yet) falls in after these, alphabetized. */
const BUCKET_ORDER = ["Majority Democrats", "The Bench", "House", "Senate", "Notable Figures", "Institutional"];

/** Minimum characters before the global search actually fires a request --
 *  matches the same threshold already used for the transcript-tag-match
 *  highlighting below, so one-character keystrokes don't hit the server. */
const MIN_SEARCH_LENGTH = 2;

/** Debounce for the global search box -- unlike "Filter this folder" (a
 *  free client-side substring check), this hits the server on every commit,
 *  so it waits for typing to pause rather than firing on every keystroke. */
const SEARCH_DEBOUNCE_MS = 350;

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

interface ChamberGroup {
  chamber: string;
  count: number;
  people: BucketPerson[];
}

interface BucketSummary {
  label: string;
  count: number;
  people?: BucketPerson[];
  chambers?: ChamberGroup[];
}

interface BucketsResponse {
  buckets: BucketSummary[];
  uncategorizedCount: number;
  totalVideos: number;
}

type ExplorerView =
  | { level: "folders" }
  | { level: "bucket"; bucket: string }
  | { level: "chamber"; bucket: string; chamber: string }
  | { level: "person"; bucket: string; chamber?: string; person: string }
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

/** Shared by the classic flat list, a bucket/person's detail rows, and
 *  global search results -- so "Sort" behaves identically no matter which
 *  of those three you're currently looking at. */
function sortRows(rows: LibraryRow[], sortMode: string): LibraryRow[] {
  const out = [...rows];
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

  // --- Global search state (new) ----------------------------------------
  // Always-visible, independent of folder navigation and of "Filter this
  // folder" below -- searches the whole library server-side (title,
  // uploader, channel, AND transcript content) rather than filtering
  // whatever happens to already be on screen.
  const [globalSearchInput, setGlobalSearchInput] = useState("");
  const [globalSearchTerm, setGlobalSearchTerm] = useState(""); // debounced
  const [searchResults, setSearchResults] = useState<LibraryRow[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchPage, setSearchPage] = useState(0);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [searchTotal, setSearchTotal] = useState(0);
  const globalSearchActive = globalSearchTerm.trim().length >= MIN_SEARCH_LENGTH;

  useEffect(() => {
    const t = setTimeout(() => setGlobalSearchTerm(globalSearchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [globalSearchInput]);

  // --- Folder-explorer state -------------------------------------------
  // Bucket/person counts come from a dedicated lightweight endpoint that
  // reads straight from the tags table, so they're accurate the instant the
  // page opens — they never depend on how much of the library has streamed
  // into `rows` yet.
  const [summary, setSummary] = useState<BucketsResponse | null>(null);
  // Distinct from `summary` itself: null summary means either "still
  // loading" or "failed/empty", and those need different UI. Without this,
  // the flat list -- built from whatever `rows` the parent already has --
  // renders for the brief window before the buckets fetch resolves, then
  // gets replaced by the folder view a moment later. A visible flash on
  // every page load, not a real race between two sources of truth.
  const [bucketsLoaded, setBucketsLoaded] = useState(false);
  const [view, setView] = useState<ExplorerView>({ level: "folders" });
  const [detailRows, setDetailRows] = useState<LibraryRow[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailPage, setDetailPage] = useState(0);
  const [detailHasMore, setDetailHasMore] = useState(false);
  // True match count for the current person/uncategorized fetch, straight
  // from the server's pagination.totalCombined -- only meaningful while
  // folderSearchTerm is active (otherwise the header falls back to the
  // buckets endpoint's own count, which is cheaper and already accurate).
  const [detailTotal, setDetailTotal] = useState(0);
  const [folderFilter, setFolderFilter] = useState("");
  // Debounced from folderFilter, and ONLY consulted at the person/
  // uncategorized levels -- this is what turns "Filter this folder" from a
  // client-side title-only substring check (useless against a folder full
  // of raw filenames like "cspan_680822") into the same server-side title+
  // transcript search the global box uses, just scoped to this one person
  // instead of the whole library. At the bucket/chamber levels folderFilter
  // still filters PEOPLE'S NAMES client-side (that list is small and
  // already fully loaded, so a server round-trip would be pure overhead).
  const [folderSearchTerm, setFolderSearchTerm] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setFolderSearchTerm(folderFilter.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [folderFilter]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/library/buckets")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) {
          if (!data.error) setSummary(data);
          setBucketsLoaded(true);
        }
      })
      .catch(() => {
        /* falls back to the classic flat list below */
        if (!cancelled) setBucketsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchDetailPage = useCallback(
    async (pageNum: number, opts: { bucket?: string; person?: string; search?: string }) => {
      const params = new URLSearchParams({ page: String(pageNum), limit: "250" });
      if (opts.bucket) params.set("bucket", opts.bucket);
      if (opts.person) params.set("person", opts.person);
      if (opts.search) params.set("search", opts.search);
      const res = await fetch(`/api/library?${params.toString()}`);
      return res.json();
    },
    []
  );

  // --- Global search fetch (new) ----------------------------------------
  useEffect(() => {
    let cancelled = false;
    if (!globalSearchActive) {
      setSearchResults([]);
      setSearchHasMore(false);
      setSearchPage(0);
      setSearchTotal(0);
      return;
    }
    setSearchLoading(true);
    setSearchPage(0);
    fetchDetailPage(0, { search: globalSearchTerm })
      .then((data) => {
        if (cancelled) return;
        setSearchResults(data.rows ?? []);
        setSearchHasMore(Boolean(data.pagination?.hasMore));
        setSearchTotal(data.pagination?.totalCombined ?? 0);
      })
      .catch(() => {
        if (cancelled) return;
        setSearchResults([]);
        setSearchHasMore(false);
        setSearchTotal(0);
      })
      .finally(() => {
        if (!cancelled) setSearchLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [globalSearchActive, globalSearchTerm, fetchDetailPage]);

  const loadMoreSearchResults = useCallback(() => {
    if (searchLoading || !searchHasMore) return;
    const next = searchPage + 1;
    setSearchLoading(true);
    fetchDetailPage(next, { search: globalSearchTerm })
      .then((data) => {
        setSearchPage(next);
        setSearchResults((prev) => [...prev, ...(data.rows ?? [])]);
        setSearchHasMore(Boolean(data.pagination?.hasMore));
      })
      .catch(() => setSearchHasMore(false))
      .finally(() => setSearchLoading(false));
  }, [searchLoading, searchHasMore, searchPage, globalSearchTerm, fetchDetailPage]);

  // person/uncategorized share one pagination + optional scoped-search
  // path (see loadMoreDetail below) -- a folder-search only kicks in once
  // it clears MIN_SEARCH_LENGTH, same floor the global search box uses.
  const activeFolderSearch = folderSearchTerm.length >= MIN_SEARCH_LENGTH ? folderSearchTerm : "";
  const detailOptsFor = useCallback(
    (v: ExplorerView): { bucket?: string; person?: string; search?: string } | null => {
      if (v.level === "person") return { bucket: v.bucket, person: v.person, search: activeFolderSearch || undefined };
      if (v.level === "uncategorized") return { bucket: "Uncategorized", search: activeFolderSearch || undefined };
      return null;
    },
    [activeFolderSearch]
  );

  useEffect(() => {
    // `cancelled` guards against a slow fetch from a folder you've since
    // navigated away from landing AFTER a newer fetch and overwriting its
    // rows — e.g. double-click Person A, then quickly double-click Person B
    // before A's response comes back. Clearing detailRows up front handles
    // the case where nothing new has loaded yet; this flag handles the case
    // where something old finishes loading too late.
    let cancelled = false;

    const opts = detailOptsFor(view);
    if (opts) {
      setDetailPage(0);
      setDetailRows([]);
      setDetailLoading(true);
      fetchDetailPage(0, opts)
        .then((data) => {
          if (cancelled) return;
          setDetailRows(data.rows ?? []);
          setDetailHasMore(Boolean(data.pagination?.hasMore));
          setDetailTotal(data.pagination?.totalCombined ?? 0);
        })
        .catch(() => {
          if (cancelled) return;
          setDetailRows([]);
          setDetailHasMore(false);
          setDetailTotal(0);
        })
        .finally(() => {
          if (!cancelled) setDetailLoading(false);
        });
    } else {
      // folders / bucket / chamber levels don't render detailRows at all,
      // but clearing it here means nothing stale can ever leak into view if
      // you navigate person -> back -> a different bucket in one motion.
      setFolderFilter("");
      setDetailRows([]);
      setDetailHasMore(false);
    }

    return () => {
      cancelled = true;
    };
  }, [view, fetchDetailPage, detailOptsFor]);

  const loadMoreDetail = useCallback(() => {
    if (detailLoading || !detailHasMore) return;
    const opts = detailOptsFor(view);
    if (!opts) return;
    const next = detailPage + 1;
    setDetailLoading(true);
    fetchDetailPage(next, opts)
      .then((data) => {
        setDetailPage(next);
        setDetailRows((prev) => [...prev, ...(data.rows ?? [])]);
        setDetailHasMore(Boolean(data.pagination?.hasMore));
      })
      .catch(() => setDetailHasMore(false))
      .finally(() => setDetailLoading(false));
  }, [detailLoading, detailHasMore, detailPage, fetchDetailPage, detailOptsFor, view]);

  // Unified scroll handler: global search (when active) takes priority over
  // whatever the explorer/flat-list would otherwise do, since search results
  // replace that view entirely while a search term is live.
  const handleUnifiedScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, clientHeight, scrollHeight } = e.currentTarget;
    const nearBottom = scrollHeight - scrollTop - clientHeight < 1200;
    if (globalSearchActive) {
      if (nearBottom) loadMoreSearchResults();
      return;
    }
    if (view.level === "uncategorized" || view.level === "person") {
      if (nearBottom) loadMoreDetail();
      return;
    }
    if (onLoadMore && hasMore && nearBottom) {
      onLoadMore();
    }
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
    if (term.length < MIN_SEARCH_LENGTH) return map;
    for (const r of rows) {
      const hits = (r.tags ?? [])
        .filter((t) => t.label.toLowerCase().includes(term))
        .map((t) => t.label);
      if (hits.length) map.set(r.id, hits);
    }
    return map;
  }, [rows, search]);

  const filtered = useMemo(() => {
    let out = rows.filter((r) => {
      if (tag !== ALL_TAGS && !(r.tags ?? []).some((t) => t.label === tag)) return false;
      return true;
    });
    return sortRows(out, sortMode);
  }, [rows, tag, sortMode]);

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

  const goBack = useCallback(() => {
    if (view.level === "person") {
      setView(view.chamber ? { level: "chamber", bucket: view.bucket, chamber: view.chamber } : { level: "bucket", bucket: view.bucket });
    } else if (view.level === "chamber") {
      setView({ level: "bucket", bucket: view.bucket });
    } else {
      setView({ level: "folders" });
    }
  }, [view]);

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

  // One back-button, computed once, rendered outside the scrollable list --
  // previously this was five near-identical rows, each the FIRST item
  // inside renderExplorer()'s own output, so it scrolled away with
  // everything else in a large bucket. Same label logic each view level had,
  // just no longer duplicated and no longer inside the scroll container.
  const explorerBackLabel: string | null = !explorerReady
    ? null
    : view.level === "bucket" || view.level === "uncategorized"
    ? "All buckets"
    : view.level === "chamber"
    ? view.bucket
    : view.level === "person"
    ? view.chamber ?? view.bucket
    : null; // "folders" -- already at the root, nothing to go back to

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

      if (b?.chambers) {
        const chambers = b.chambers.filter(
          (c) => !filterTerm || c.chamber.toLowerCase().includes(filterTerm)
        );
        return (
          <>
            {chambers.map((c) =>
              renderFolderRow(c.chamber, c.chamber, c.count, () =>
                setView({ level: "chamber", bucket: view.bucket, chamber: c.chamber })
              )
            )}
          </>
        );
      }

      const people = (b?.people ?? []).filter(
        (p) => !filterTerm || p.name.toLowerCase().includes(filterTerm)
      );
      return (
        <>
          {people.map((p) =>
            renderFolderRow(p.name, p.name, p.count, () =>
              setView({ level: "person", bucket: view.bucket, person: p.name })
            )
          )}
        </>
      );
    }

    if (view.level === "chamber") {
      const b = summary.buckets.find((x) => x.label === view.bucket);
      const c = b?.chambers?.find((x) => x.chamber === view.chamber);
      const people = (c?.people ?? []).filter(
        (p) => !filterTerm || p.name.toLowerCase().includes(filterTerm)
      );
      return (
        <>
          {people.map((p) =>
            renderFolderRow(p.name, p.name, p.count, () =>
              setView({ level: "person", bucket: view.bucket, chamber: view.chamber, person: p.name })
            )
          )}
        </>
      );
    }

    if (view.level === "person") {
      // detailRows already reflects activeFolderSearch server-side (title +
      // transcript, scoped to this person) -- re-filtering by title here
      // client-side would both lag the debounce and wrongly hide a row the
      // server matched only via its transcript, not its title.
      const sorted = sortRows(detailRows, sortMode);
      return (
        <>
          {detailLoading && detailRows.length === 0 ? (
            <div className="status-muted text-center" style={{ padding: 12 }}>
              {activeFolderSearch ? `Searching ${view.person}'s videos…` : `Loading videos for ${view.person}…`}
            </div>
          ) : !detailLoading && detailRows.length === 0 && activeFolderSearch ? (
            <div className="status-muted text-center" style={{ padding: 12 }}>
              No matches for "{activeFolderSearch}" in {view.person}'s videos.
            </div>
          ) : (
            sorted.map((row, i) => renderRow(row, i + 1))
          )}
        </>
      );
    }

    // uncategorized
    const sorted = sortRows(detailRows, sortMode);
    return (
      <>
        {sorted.map((row, i) => renderRow(row, i + 1))}
        {detailLoading && (
          <div className="status-muted text-center" style={{ padding: 12 }}>
            Loading more videos…
          </div>
        )}
      </>
    );
  };

  // The true count for a person comes from the buckets endpoint (accurate
  // the instant the page loads, independent of how much of that person's
  // videos have streamed into detailRows) -- falls back to detailRows.length
  // only if summary somehow doesn't have this person yet.
  const personTrueCount = (v: Extract<ExplorerView, { level: "person" }>): number | undefined => {
    const b = summary?.buckets.find((x) => x.label === v.bucket);
    if (v.chamber) return b?.chambers?.find((c) => c.chamber === v.chamber)?.people.find((p) => p.name === v.person)?.count;
    return b?.people?.find((p) => p.name === v.person)?.count;
  };

  const headerCount = globalSearchActive
    ? searchTotal
    : !bucketsLoaded
    ? "…"
    : !explorerReady
    ? filtered.length
    : view.level === "folders"
    ? summary!.totalVideos
    : view.level === "bucket"
    ? summary!.buckets.find((x) => x.label === view.bucket)?.count ?? 0
    : view.level === "chamber"
    ? summary!.buckets.find((x) => x.label === view.bucket)?.chambers?.find((c) => c.chamber === view.chamber)?.count ?? 0
    : view.level === "uncategorized"
    ? (activeFolderSearch ? detailTotal : summary!.uncategorizedCount)
    : activeFolderSearch
    ? detailTotal
    : personTrueCount(view) ?? detailRows.length;

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

      {/* Always-visible global search -- independent of folder navigation
          and of "Filter this folder" below. Hits the server (title,
          uploader, channel, and transcript content) rather than filtering
          whatever's already on screen. */}
      <div style={{ position: "relative" }}>
        <input
          type="text"
          className="field"
          placeholder="Search everywhere (titles, people, transcripts)…"
          value={globalSearchInput}
          onChange={(e) => setGlobalSearchInput(e.target.value)}
        />
        {globalSearchInput && (
          <button
            type="button"
            onClick={() => setGlobalSearchInput("")}
            title="Clear search"
            style={{
              position: "absolute",
              right: 8,
              top: "50%",
              transform: "translateY(-50%)",
              background: "none",
              border: "none",
              color: "inherit",
              cursor: "pointer",
              fontSize: "1rem",
              opacity: 0.7,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        )}
      </div>

      <input
        type="text"
        className="field"
        placeholder={
          !explorerReady
            ? "Search library…"
            : view.level === "person" || view.level === "uncategorized"
            ? "Search titles + transcripts in this folder…"
            : "Filter names…"
        }
        value={explorerReady ? folderFilter : search}
        onChange={explorerReady ? (e) => setFolderFilter(e.target.value) : handleSearchChange}
      />

      <div className="flex gap-2">
        {!explorerReady && (
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
        )}

        <select className="select" value={sortMode} onChange={(e) => setSortMode(e.target.value)}>
          {SORT_MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      {!globalSearchActive && explorerBackLabel && (
        <div
          className="playlist-row"
          style={{ cursor: "pointer", fontWeight: 600, flexShrink: 0 }}
          onClick={goBack}
        >
          <span>◂ &nbsp;{explorerBackLabel}</span>
        </div>
      )}

      <div
        className="list-surface min-h-0 flex-1 overflow-y-auto"
        onScroll={handleUnifiedScroll}
      >
        {globalSearchActive ? (
          <>
            {sortRows(searchResults, sortMode).map((row, i) => renderRow(row, i + 1))}
            {searchLoading && (
              <div className="status-muted text-center" style={{ padding: 12 }}>
                {searchResults.length === 0 ? `Searching for "${globalSearchTerm}"…` : "Loading more results…"}
              </div>
            )}
            {!searchLoading && searchResults.length === 0 && (
              <div className="status-muted text-center" style={{ padding: 12 }}>
                No matches for "{globalSearchTerm}".
              </div>
            )}
          </>
        ) : !bucketsLoaded ? (
          <div className="status-muted text-center" style={{ padding: 12 }}>
            Loading library…
          </div>
        ) : explorerReady ? (
          renderExplorer()
        ) : (
          filtered.map((row, i) => renderRow(row, i + 1))
        )}

        {!globalSearchActive && bucketsLoaded && !explorerReady && onLoadMore && hasMore && (
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
