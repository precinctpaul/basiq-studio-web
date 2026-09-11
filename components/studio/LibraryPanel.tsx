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
  /** Manually assign/correct a video's bucket -- same action Details panel's
   *  own BUCKET selector triggers, exposed here too so a freshly-downloaded
   *  video showing up Uncategorized in "Recently Downloaded" below can be
   *  fixed in the same place it was just noticed, no need to select it and
   *  switch to the Details tab first. */
  onBucketChange?: (id: string, bucket: string) => void;
}

/** Videos this session/browser has chosen to hide from "Recently Downloaded"
 *  by pressing Clear -- a video created after this timestamp still shows;
 *  nothing is deleted, this only affects what that one list displays. */
const RECENT_CLEARED_AT_KEY = "basiq.recentDownloads.clearedAt";
const RECENT_COLLAPSED_COUNT = 10;
const RECENT_EXPANDED_COUNT = 25;

function bucketLabelFor(row: LibraryRow): string {
  return (row.tags ?? []).find((t) => t.kind === "bucket")?.label ?? "Uncategorized";
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
  onBucketChange,
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

  // --- Recently Downloaded (2026-09-11) ---------------------------------
  // A view over videos already in `rows`, not a separate store -- nothing
  // here is fetched or kept twice. `rows` is already newest-first (see
  // refreshLibrary in page.tsx), so this is just "the first N of `rows`
  // that are videos, newer than the last time Clear was pressed".
  const [recentClearedAt, setRecentClearedAt] = useState<string | null>(null);
  const [recentExpanded, setRecentExpanded] = useState(false);

  useEffect(() => {
    try {
      setRecentClearedAt(window.localStorage.getItem(RECENT_CLEARED_AT_KEY));
    } catch {
      /* private browsing / storage disabled -- the list just never hides */
    }
  }, []);

  const recentDownloads = useMemo(() => {
    const videos = rows.filter((r) => r.kind === "video");
    const visible = recentClearedAt ? videos.filter((r) => r.created_at > recentClearedAt) : videos;
    return visible.slice(0, recentExpanded ? RECENT_EXPANDED_COUNT : RECENT_COLLAPSED_COUNT);
  }, [rows, recentClearedAt, recentExpanded]);

  const clearRecentDownloads = useCallback(() => {
    const now = new Date().toISOString();
    setRecentClearedAt(now);
    try {
      window.localStorage.setItem(RECENT_CLEARED_AT_KEY, now);
    } catch {
      /* nothing to persist to -- it'll just reappear on reload, harmless */
    }
  }, []);

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

  /** A "Recently Downloaded" row -- same shape as renderRow, plus an inline
   *  bucket badge/selector so "where did it go, and can I fix it" is
   *  answerable without leaving this list. Selecting a different bucket
   *  stops the click from also selecting the row (it isn't the same action). */
  const renderRecentRow = (row: LibraryRow, idx: number) => (
    <div
      key={row.id}
      className="playlist-row"
      data-selected={row.id === selectedId ? "true" : undefined}
      onClick={() => onSelect(row.id)}
      onDoubleClick={() => onActivate(row.id)}
      title={row.title}
    >
      <div className="playlist-row-title">
        <span>{labelFor(row, idx)}</span>
      </div>
      {onBucketChange ? (
        <select
          className="select"
          value={bucketLabelFor(row)}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onBucketChange(row.id, e.target.value)}
          title="Move to a different bucket"
          style={{ fontSize: "0.8rem", padding: "2px 4px" }}
        >
          <option value="Uncategorized">Uncategorized</option>
          {BUCKET_ORDER.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      ) : (
        <span className="playlist-row-tags">{bucketLabelFor(row)}</span>
      )}
    </div>
  );

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
        const ai = (BUCKET_ORDER as readonly string[]).indexOf(a.label);
        const bi = (BUCKET_ORDER as readonly string[]).indexOf(b.label);
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
          and of "Filter this list" below. Hits the server (title, uploader,
          channel, and transcript content) rather than filtering whatever's
          already on screen. The placeholder is deliberately plain rather
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

      {/* Distinct from the global search above: this one never leaves the
          browser. At the folders/bucket/chamber levels it's a plain
          substring filter over whatever list of bucket or person names is
          already on screen -- worth having once a bucket has 100+ people in
          it and you just want to jump to one by typing part of their name.
          At the person/uncategorized levels it becomes a real, scoped
          server search instead (title + transcript, just this folder). */}
      <input
        type="text"
        className="field"
        placeholder={
          !explorerReady
            ? "Search library…"
            : view.level === "person" || view.level === "uncategorized"
            ? "Search titles + transcripts in this folder…"
            : "Filter this list…"
        }
        value={explorerReady ? folderFilter : search}
        onChange={explorerReady ? (e) => setFolderFilter(e.target.value) : handleSearchChange}
      />

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
              : `${selectedIssues.length} issues`}{" "}
            ▾
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

      {!globalSearchActive && view.level === "folders" && recentDownloads.length > 0 && (
        <div style={{ flexShrink: 0 }}>
          <div className="flex items-center" style={{ padding: "2px 2px 4px" }}>
            <span className="section-label" style={{ fontSize: "0.72rem" }}>
              RECENTLY DOWNLOADED
            </span>
            <span className="flex-1" />
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setRecentExpanded((v) => !v)}
              title={recentExpanded ? `Show ${RECENT_COLLAPSED_COUNT}` : `Show ${RECENT_EXPANDED_COUNT}`}
            >
              {recentExpanded ? `SHOW ${RECENT_COLLAPSED_COUNT}` : `SHOW ${RECENT_EXPANDED_COUNT}`}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={clearRecentDownloads}
              title="Hide this list until the next download -- doesn't delete anything"
            >
              CLEAR
            </button>
          </div>
          {recentDownloads.map((row, i) => renderRecentRow(row, i + 1))}
        </div>
      )}

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
