"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatShort } from "@/lib/timecode";
import { GROUP_LABELS } from "@/components/studio/DetailsPanel";
import { BUCKET_ORDER } from "@/lib/buckets";

const SORT_MODES = ["Relevance", "Date: Newest", "Date: Oldest", "Name: A-Z", "Name: Z-A"] as const;
const ALL_TAGS = "All Tags";

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
  /** Postgres ts_rank score for the active transcript search term, null
   *  outside a search or when nothing in this row's transcript matched --
   *  see search_transcripts_ranked() in 0012_transcript_search_rank.sql. */
  relevance?: number | null;
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
  | { level: "recent" }
  | { level: "bucket"; bucket: string }
  | { level: "chamber"; bucket: string; chamber: string }
  | { level: "person"; bucket: string; chamber?: string; person: string }
  | { level: "uncategorized" };

interface Props {
  rows: LibraryRow[];
  selectedId: string | null;
  // Second arg is the active global search term, when a row is opened while
  // a search is live -- lets the transcript panel seed its own search box
  // with it instead of opening empty. Undefined outside of an active search.
  onSelect: (id: string, searchTerm?: string) => void;
  onActivate: (id: string, searchTerm?: string) => void;
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
    case "Relevance":
      // Real Postgres ts_rank scores (see route.ts), not a made-up
      // heuristic -- undefined/null (no active search, or a title/uploader/
      // channel match with nothing in the transcript itself) sorts as 0,
      // falling back to newest-first among ties so this never looks random
      // outside of an active search.
      out.sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0) || b.created_at.localeCompare(a.created_at));
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

  // --- Issue-category filter (2026-09-10) --------------------------------
  // Real classification data from tools/classify_video_issues.py
  // (kind="issue" tags), distinct from the older messy kind="topics"
  // auto-tags the `tag`/`ALL_TAGS` select above already covers. Multi-select
  // (a video can genuinely be about more than one issue); OR semantics --
  // matches ANY selected category, same as picking multiple facets on any
  // normal filtered search UI.
  const [issueFacets, setIssueFacets] = useState<{ label: string; count: number }[]>([]);
  const [selectedIssues, setSelectedIssues] = useState<string[]>([]);
  const [issuePanelOpen, setIssuePanelOpen] = useState(false);
  const [issueFilterQuery, setIssueFilterQuery] = useState("");
  const issuePanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!issuePanelOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (issuePanelRef.current && !issuePanelRef.current.contains(e.target as Node)) {
        setIssuePanelOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [issuePanelOpen]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/library/issues")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && Array.isArray(data.issues)) setIssueFacets(data.issues);
      })
      .catch(() => {
        /* Filter dropdown just shows nothing to pick -- rest of the library still works. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleIssue = useCallback((label: string) => {
    setSelectedIssues((prev) =>
      prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label]
    );
  }, []);

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

  // "Most Relevant" only means anything once there's a keyword to rank
  // against -- switch to it the moment a search goes active (without
  // clobbering a sort the user picks by hand mid-search), and back to the
  // normal browsing default the moment it clears, rather than leaving
  // Relevance selected over a plain, unranked bucket/person listing.
  const wasSearchActive = useRef(false);
  useEffect(() => {
    if (globalSearchActive && !wasSearchActive.current) {
      setSortMode("Relevance");
    } else if (!globalSearchActive && wasSearchActive.current) {
      setSortMode(SORT_MODES[0]);
    }
    wasSearchActive.current = globalSearchActive;
  }, [globalSearchActive]);

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

  useEffect(() => {
    let cancelled = false;
    const fetchBuckets = () =>
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

    fetchBuckets();

    // A grab's automatic classification and a manual bucket reassignment
    // both change these counts, but neither one lives in this component --
    // they happen in the parent (page.tsx) alongside its own refreshLibrary,
    // which is the one thing every one of those code paths already calls.
    // Rather than threading a new prop through for this alone, refreshLibrary
    // dispatches this same event whenever it re-pulls page 0, and any open
    // LibraryPanel just re-fetches its own bucket counts in response --
    // matching the "basiq:queue" custom-event pattern page.tsx already uses
    // for queue updates.
    window.addEventListener("basiq:library-changed", fetchBuckets);
    return () => {
      cancelled = true;
      window.removeEventListener("basiq:library-changed", fetchBuckets);
    };
  }, []);

  const fetchDetailPage = useCallback(
    async (pageNum: number, opts: { bucket?: string; person?: string; search?: string }) => {
      const params = new URLSearchParams({ page: String(pageNum), limit: "250" });
      if (opts.bucket) params.set("bucket", opts.bucket);
      if (opts.person) params.set("person", opts.person);
      if (opts.search) params.set("search", opts.search);
      // Applied to every fetch through this function -- search results AND
      // normal bucket/person browsing both go through it, so the Filter
      // dropdown works in both places for free rather than needing every
      // call site updated separately.
      // Repeated params, not comma-joined -- several category names contain
      // a literal comma ("National Security, Defense & Foreign Policy"),
      // which a single joined string would corrupt on the other end.
      for (const label of selectedIssues) params.append("issues", label);
      const res = await fetch(`/api/library?${params.toString()}`);
      return res.json();
    },
    [selectedIssues]
  );

  // Scopes the GLOBAL search box to wherever you've manually drilled down to
  // -- searching from inside Elissa Slotkin's folder should only search her
  // videos, not the whole library, the same way "Filter this folder" below
  // already does for a title/transcript match. Chamber has no filter of its
  // own server-side (no videos_by_chamber view), so it falls back to
  // scoping by the whole bucket rather than not scoping at all.
  const searchScopeFor = useCallback((v: ExplorerView): { bucket?: string; person?: string } => {
    switch (v.level) {
      case "person":
        return { person: v.person };
      case "uncategorized":
        return { bucket: "Uncategorized" };
      case "chamber":
      case "bucket":
        return { bucket: v.bucket };
      default:
        return {};
    }
  }, []);

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
    fetchDetailPage(0, { search: globalSearchTerm, ...searchScopeFor(view) })
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
  }, [globalSearchActive, globalSearchTerm, view, fetchDetailPage, searchScopeFor]);

  const loadMoreSearchResults = useCallback(() => {
    if (searchLoading || !searchHasMore) return;
    const next = searchPage + 1;
    setSearchLoading(true);
    fetchDetailPage(next, { search: globalSearchTerm, ...searchScopeFor(view) })
      .then((data) => {
        setSearchPage(next);
        setSearchResults((prev) => [...prev, ...(data.rows ?? [])]);
        setSearchHasMore(Boolean(data.pagination?.hasMore));
      })
      .catch(() => setSearchHasMore(false))
      .finally(() => setSearchLoading(false));
  }, [searchLoading, searchHasMore, searchPage, globalSearchTerm, view, fetchDetailPage, searchScopeFor]);

  // person/uncategorized share one pagination path (see loadMoreDetail below).
  const detailOptsFor = useCallback(
    (v: ExplorerView): { bucket?: string; person?: string } | null => {
      if (v.level === "person") return { bucket: v.bucket, person: v.person };
      if (v.level === "uncategorized") return { bucket: "Uncategorized" };
      return null;
    },
    []
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
        })
        .catch(() => {
          if (cancelled) return;
          setDetailRows([]);
          setDetailHasMore(false);
        })
        .finally(() => {
          if (!cancelled) setDetailLoading(false);
        });
    } else {
      // folders / bucket / chamber levels don't render detailRows at all,
      // but clearing it here means nothing stale can ever leak into view if
      // you navigate person -> back -> a different bucket in one motion.
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
        onClick={() => onSelect(row.id, globalSearchActive ? globalSearchTerm : undefined)}
        onDoubleClick={() => onActivate(row.id, globalSearchActive ? globalSearchTerm : undefined)}
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

  // One back-button, computed once, rendered outside the scrollable list --
  // previously this was five near-identical rows, each the FIRST item
  // inside renderExplorer()'s own output, so it scrolled away with
  // everything else in a large bucket. Same label logic each view level had,
  // just no longer duplicated and no longer inside the scroll container.
  const explorerBackLabel: string | null = !explorerReady
    ? null
    : view.level === "recent" || view.level === "bucket" || view.level === "uncategorized"
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
        const ai = (BUCKET_ORDER as readonly string[]).indexOf(a.label);
        const bi = (BUCKET_ORDER as readonly string[]).indexOf(b.label);
        return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.label.localeCompare(b.label);
      });
      return (
        <>
          {renderFolderRow("Recently Downloaded", "Recently Downloaded", summary.totalVideos, () =>
            setView({ level: "recent" })
          )}
          {orderedBuckets.map((b) =>
            renderFolderRow(b.label, b.label, b.count, () => setView({ level: "bucket", bucket: b.label }))
          )}
          {renderFolderRow("Uncategorized", "Uncategorized", summary.uncategorizedCount, () =>
            setView({ level: "uncategorized" })
          )}
        </>
      );
    }

    if (view.level === "recent") {
      // Not a separate store or fetch -- the same `rows`/pagination the
      // parent already streams in (newest-first, see refreshLibrary in
      // page.tsx), just browsed as its own folder instead of a
      // fixed-length list bolted onto the sidebar. Scrolling to the
      // bottom pages in more the same way any bucket/person folder does
      // (see handleUnifiedScroll's plain onLoadMore branch below).
      return <>{filtered.map((row, i) => renderRow(row, i + 1))}</>;
    }

    if (view.level === "bucket") {
      const b = summary.buckets.find((x) => x.label === view.bucket);

      if (b?.chambers) {
        return (
          <>
            {b.chambers.map((c) =>
              renderFolderRow(c.chamber, c.chamber, c.count, () =>
                setView({ level: "chamber", bucket: view.bucket, chamber: c.chamber })
              )
            )}
          </>
        );
      }

      return (
        <>
          {(b?.people ?? []).map((p) =>
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
      return (
        <>
          {(c?.people ?? []).map((p) =>
            renderFolderRow(p.name, p.name, p.count, () =>
              setView({ level: "person", bucket: view.bucket, chamber: view.chamber, person: p.name })
            )
          )}
        </>
      );
    }

    if (view.level === "person") {
      const sorted = sortRows(detailRows, sortMode);
      return (
        <>
          {detailLoading && detailRows.length === 0 ? (
            <div className="status-muted text-center" style={{ padding: 12 }}>
              Loading videos for {view.person}…
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
    : view.level === "folders" || view.level === "recent"
    ? summary!.totalVideos
    : view.level === "bucket"
    ? summary!.buckets.find((x) => x.label === view.bucket)?.count ?? 0
    : view.level === "chamber"
    ? summary!.buckets.find((x) => x.label === view.bucket)?.chambers?.find((c) => c.chamber === view.chamber)?.count ?? 0
    : view.level === "uncategorized"
    ? summary!.uncategorizedCount
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

      {/* Always-visible global search -- independent of folder navigation.
          Hits the server (title, uploader, channel, and transcript content)
          rather than filtering whatever's already on screen. The placeholder
          is deliberately plain rather
          than naming the current bucket/person -- that used to read as
          "Search Majority Democrats…" while just browsing that folder,
          which looked like a stray leftover label, not a hint that the box
          also scopes itself to wherever you've drilled down to (it still
          does -- see searchScopeFor above -- this is copy only). */}
      <div style={{ position: "relative" }}>
        <input
          type="text"
          className="field"
          placeholder="Search…"
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

      {/* Only ever seen if the buckets endpoint itself fails to load --
          explorerReady is normally true, in which case the always-visible
          global search box above already covers this. */}
      {!explorerReady && (
        <input
          type="text"
          className="field"
          placeholder="Search library…"
          value={search}
          onChange={handleSearchChange}
        />
      )}

      <div className="flex gap-2">
        <div ref={issuePanelRef} style={{ position: "relative" }}>
          <button
            type="button"
            className="select"
            onClick={() => setIssuePanelOpen((v) => !v)}
            title="Filter by issue category — multi-select"
          >
            {selectedIssues.length === 0
              ? "All Issues"
              : selectedIssues.length === 1
              ? selectedIssues[0]
              : `${selectedIssues.length} issues`}
          </button>
          {issuePanelOpen && (
            <div
              className="panel"
              style={{
                position: "absolute",
                top: "calc(100% + 4px)",
                left: 0,
                zIndex: 20,
                width: 280,
                maxHeight: 340,
                overflowY: "auto",
                padding: 10,
              }}
            >
              <input
                type="text"
                className="field"
                placeholder="Search issues…"
                value={issueFilterQuery}
                onChange={(e) => setIssueFilterQuery(e.target.value)}
                style={{ marginBottom: 8, width: "100%" }}
                autoFocus
              />
              {selectedIssues.length > 0 && (
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ width: "100%", marginBottom: 8 }}
                  onClick={() => setSelectedIssues([])}
                >
                  Clear all ({selectedIssues.length})
                </button>
              )}
              {issueFacets.length === 0 && (
                <p className="status-muted" style={{ padding: 4 }}>
                  No categories loaded yet.
                </p>
              )}
              {issueFacets
                .filter((f) =>
                  f.label.toLowerCase().includes(issueFilterQuery.trim().toLowerCase())
                )
                .map((f) => (
                  <label
                    key={f.label}
                    className="flex items-center"
                    style={{ gap: 8, padding: "4px 2px", cursor: "pointer" }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedIssues.includes(f.label)}
                      onChange={() => toggleIssue(f.label)}
                    />
                    <span className="flex-1">{f.label}</span>
                    <span className="status-muted">{f.count}</span>
                  </label>
                ))}
            </div>
          )}
        </div>

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
